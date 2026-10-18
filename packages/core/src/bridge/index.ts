import { NATIVE_ABI_VERSION, type SceneDocument, type NativeCommand, type NativeEvent } from "../protocol";
import { openLibrary } from "./binding";
import { nativePath } from "#tarve/runtime";
import { createConnection, type Socket } from "node:net";

export interface NativeBridge {
  start(document: SceneDocument, onEvent: (event: NativeEvent) => void): void;
  send(command: NativeCommand): void;
  join(): void;
  /**
   * Sends a request and blocks until native answers it, or `timeoutMs` passes
   * (`undefined`). Events that arrive meanwhile are delivered afterwards, in order.
   * Optional: bridges without it cannot answer synchronous layout reads.
   */
  requestSync?(command: NativeCommand & { requestId: string }, timeoutMs: number): NativeEvent | undefined;
}

export interface BunFfiBridgeOptions {
  libraryPath?: string;
  /** @deprecated Event delivery no longer uses a Bun Worker. */
  workerPath?: string | URL;
}

export function assertNativeAbiVersion(actual: number): void {
  if (actual !== NATIVE_ABI_VERSION) {
    throw new Error("Native ABI mismatch; expected " + NATIVE_ABI_VERSION + ", got " + actual + ". Rebuild the library.");
  }
}

function nativeLibraryError(library: ReturnType<typeof openLibrary>): Error {
  const bytes = new Uint8Array(4096);
  const length = library.symbols.tarve_last_error(bytes, bytes.length);
  return new Error(new TextDecoder().decode(bytes.subarray(0, Math.max(0, length))));
}

/** Open an absolute URI with the operating system's registered handler. */
export function openExternal(target: string): void {
  if (typeof target !== "string" || target.trim().length === 0) {
    throw new TypeError("openExternal target must be a non-empty absolute URI");
  }
  const library = openLibrary(nativePath());
  try {
    assertNativeAbiVersion(library.symbols.tarve_abi_version());
    const payload = new TextEncoder().encode(target);
    if (library.symbols.tarve_open_external(payload, payload.length) !== 0) {
      throw nativeLibraryError(library);
    }
  } finally {
    library.close();
  }
}

export interface PolledNativeEvent {
  buffer: Uint8Array<ArrayBufferLike>;
  event?: NativeEvent;
}

export function pollNativeEvent(
  initialBuffer: Uint8Array<ArrayBufferLike>,
  poll: (buffer: Uint8Array<ArrayBufferLike>, capacity: number) => number,
  error: () => Error,
  decoder = new TextDecoder(),
): PolledNativeEvent {
  let buffer = initialBuffer;
  for (;;) {
    const length = poll(buffer, buffer.length);
    if (length < -1) {
      buffer = new Uint8Array(-length);
      continue;
    }
    if (length === 0) return { buffer };
    if (length < 0) throw error();
    return {
      buffer,
      event: JSON.parse(decoder.decode(buffer.subarray(0, length))) as NativeEvent,
    };
  }
}

export function drainNativeEvents(
  initialBuffer: Uint8Array<ArrayBufferLike>,
  poll: (buffer: Uint8Array<ArrayBufferLike>, capacity: number) => number,
  error: () => Error,
  onEvent: (event: NativeEvent) => void,
  decoder = new TextDecoder(),
): Uint8Array<ArrayBufferLike> {
  let buffer = initialBuffer;
  for (;;) {
    const result = pollNativeEvent(buffer, poll, error, decoder);
    buffer = result.buffer;
    if (!result.event) return buffer;
    onEvent(result.event);
  }
}

const pauseCell = typeof SharedArrayBuffer === "function" ? new Int32Array(new SharedArrayBuffer(4)) : undefined;
let canPause = !!pauseCell;
/** Sleeps ~0.2 ms between polls of a synchronous request; spins where Atomics.wait is unavailable. */
function pause(): void {
  if (!canPause) return;
  try { Atomics.wait(pauseCell!, 0, 0, 0.2); } catch { canPause = false; }
}

export class BunFfiBridge implements NativeBridge {
  private library?: ReturnType<typeof openLibrary>;
  private eventSocket?: Socket;
  private eventBuffer: Uint8Array<ArrayBufferLike> = new Uint8Array(64 * 1024);
  private readonly decoder = new TextDecoder();
  private closed = false;
  private eventTransportFailed = false;
  /** Events polled while a synchronous request waited: delivered before newer ones. */
  private backlog: NativeEvent[] = [];
  private onEvent?: (event: NativeEvent) => void;
  private backlogScheduled = false;

  constructor(private readonly options: BunFfiBridgeOptions = {}) {}

  private error(): Error {
    return nativeLibraryError(this.library!);
  }

  private pollOne(): NativeEvent | undefined {
    const result = pollNativeEvent(
      this.eventBuffer,
      (buffer, capacity) => this.library!.symbols.tarve_poll_event(buffer, capacity),
      () => this.error(),
      this.decoder,
    );
    this.eventBuffer = result.buffer;
    return result.event;
  }

  private drainEventQueue(onEvent: (event: NativeEvent) => void): void {
    if (!this.library) return;
    for (;;) {
      // A handler may block on requestSync, which moves newer events to the backlog: those come first.
      const event = this.backlog.shift() ?? this.pollOne();
      if (!event) return;
      // Another window's "closed" (it carries `window`) leaves the app running.
        const appClosed = event.type === "closed" && !("window" in event);
        if (appClosed) {
          this.closed = true;
          this.closeEventSocket();
      }
      onEvent(event);
      if (appClosed) return;
    }
  }

  private scheduleBacklog(): void {
    if (!this.backlog.length || this.backlogScheduled) return;
    this.backlogScheduled = true;
    setTimeout(() => {
      this.backlogScheduled = false;
      const onEvent = this.onEvent;
      if (!onEvent || !this.backlog.length) return;
      if (this.closed) {
        // The window closed while a request waited: its remaining events still go out.
        for (const event of this.backlog.splice(0)) onEvent(event);
        return;
      }
      this.pollEvents(onEvent);
    }, 0);
  }

  requestSync(command: NativeCommand & { requestId: string }, timeoutMs: number): NativeEvent | undefined {
    if (!this.library || this.closed) return undefined;
    this.send(command);
    const started = performance.now();
    const deadline = started + timeoutMs;
    try {
      for (;;) {
        const event = this.pollOne();
        if (event) {
          if ("requestId" in event && event.requestId === command.requestId) return event;
          this.backlog.push(event);
          if (event.type === "closed" && !("window" in event)) return undefined;
          continue;
        }
        const now = performance.now();
        if (now >= deadline) return undefined;
        // A layout answers within a few milliseconds: spin first, as a sleep can last a whole timer tick.
        if (now - started > 4) pause();
      }
    } finally {
      this.scheduleBacklog();
    }
  }

  private eventPipeName(): string {
    if (!this.library) throw new Error("Bridge not started");
    let buffer = new Uint8Array(256);
    for (;;) {
      const length = this.library.symbols.tarve_event_pipe_name(buffer, buffer.length);
      if (length < -1) {
        buffer = new Uint8Array(-length);
        continue;
      }
      if (length < 0) throw this.error();
      if (length === 0) throw new Error("Native event wake pipe name is empty");
      return this.decoder.decode(buffer.subarray(0, length));
    }
  }

  private closeEventSocket(): void {
    const socket = this.eventSocket;
    this.eventSocket = undefined;
    if (socket && !socket.destroyed) socket.destroy();
  }

  private failEventTransport(error: unknown, onEvent: (event: NativeEvent) => void): void {
    if (this.closed || this.eventTransportFailed) return;
    this.eventTransportFailed = true;
    this.closed = true;
    this.closeEventSocket();
    const cleanupErrors = this.stopAfterEventFailure();
    onEvent({ type: "error", message: `Native event wake pipe failed: ${error instanceof Error ? error.message : String(error)}` });
    for (const cleanupError of cleanupErrors) {
      onEvent({ type: "error", message: `Bridge cleanup failed: ${cleanupError.message}` });
    }
    onEvent({ type: "closed" });
  }

  private connectEventWake(onEvent: (event: NativeEvent) => void): void {
    const socket = createConnection(this.eventPipeName());
    this.eventSocket = socket;
    socket.on("connect", () => {
      if (this.closed || this.eventSocket !== socket) return;
      this.pollEvents(onEvent);
    });
    socket.on("data", () => {
      if (this.closed || this.eventSocket !== socket) return;
      this.pollEvents(onEvent);
    });
    socket.on("error", error => this.failEventTransport(error, onEvent));
    socket.on("close", hadError => {
      if (this.closed || this.eventSocket !== socket) return;
      this.failEventTransport(new Error(hadError ? "wake pipe closed after socket error" : "wake pipe closed unexpectedly"), onEvent);
    });
  }

  private pollEvents(onEvent: (event: NativeEvent) => void): void {
    if (!this.library || this.closed) return;
    try {
      this.drainEventQueue(onEvent);
    } catch (error) {
      if (this.closed) return;
      this.closed = true;
      const cleanupErrors = this.stopAfterEventFailure();
      onEvent({ type: "error", message: error instanceof Error ? error.message : String(error) });
      for (const cleanupError of cleanupErrors) {
        onEvent({ type: "error", message: `Bridge cleanup failed: ${cleanupError.message}` });
      }
      onEvent({ type: "closed" });
      return;
    }
  }

  private stopAfterEventFailure(): Error[] {
    const cleanupErrors: Error[] = [];
    if (!this.library) return cleanupErrors;
    this.closeEventSocket();
    const close = new TextEncoder().encode(JSON.stringify({ type: "close" }));
    if (this.library.symbols.tarve_send(close, close.length) !== 0) cleanupErrors.push(this.error());
    return cleanupErrors;
  }

  start(document: SceneDocument, onEvent: (event: NativeEvent) => void): void {
    if (this.library) throw new Error("Bridge already started");
    this.onEvent = onEvent;
    const path = this.options.libraryPath ?? nativePath();
    this.library = openLibrary(path);
    assertNativeAbiVersion(this.library.symbols.tarve_abi_version());
    const payload = new TextEncoder().encode(JSON.stringify(document));
    if (this.library.symbols.tarve_start(payload, payload.length) !== 0) {
      throw this.error();
    }
    try {
      this.connectEventWake(onEvent);
    } catch (error) {
      this.closed = true;
      const cleanupErrors = this.stopAfterEventFailure();
      const joinResult = this.library.symbols.tarve_join();
      if (joinResult !== 0) cleanupErrors.push(this.error());
      if (cleanupErrors.length) {
        throw new AggregateError([error, ...cleanupErrors], "Could not initialize native event wake pipe");
      }
      throw error;
    }
  }

  send(command: NativeCommand): void {
    if (this.closed) throw new Error("Native window is closed");
    if (!this.library) throw new Error("Bridge not started");
    const payload = new TextEncoder().encode(JSON.stringify(command));
    if (this.library.symbols.tarve_send(payload, payload.length) !== 0) throw this.error();
  }

  join(): void {
    if (!this.library) return;
    this.closeEventSocket();
    const result = this.library.symbols.tarve_join();
    if (result !== 0) throw this.error();
  }
}
