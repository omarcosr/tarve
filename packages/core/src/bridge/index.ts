import { NATIVE_ABI_VERSION, type SceneDocument, type NativeCommand, type NativeEvent } from "../../../protocol/src/index";
import { openLibrary } from "./binding";
import { nativePath } from "#tarve/runtime";

const EVENT_POLL_INTERVAL_MS = 4;

export interface NativeBridge {
  start(document: SceneDocument, onEvent: (event: NativeEvent) => void): void;
  send(command: NativeCommand): void;
  join(): void;
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

export class BunFfiBridge implements NativeBridge {
  private library?: ReturnType<typeof openLibrary>;
  private eventTimer?: ReturnType<typeof setTimeout>;
  private eventBuffer: Uint8Array<ArrayBufferLike> = new Uint8Array(64 * 1024);
  private readonly decoder = new TextDecoder();
  private closed = false;

  constructor(private readonly options: BunFfiBridgeOptions = {}) {}

  private error(): Error {
    const bytes = new Uint8Array(4096);
    const length = this.library!.symbols.tarve_last_error(bytes, bytes.length);
    return new Error(new TextDecoder().decode(bytes.subarray(0, Math.max(0, length))));
  }

  private drainEventQueue(onEvent: (event: NativeEvent) => void): void {
    if (!this.library) return;
    this.eventBuffer = drainNativeEvents(
      this.eventBuffer,
      (buffer, capacity) => this.library!.symbols.tarve_poll_event(buffer, capacity),
      () => this.error(),
      (event) => {
        if (event.type === "closed") this.closed = true;
        onEvent(event);
      },
      this.decoder,
    );
  }

  private clearEventTimer(): void {
    if (this.eventTimer === undefined) return;
    clearTimeout(this.eventTimer);
    this.eventTimer = undefined;
  }

  private scheduleEventPoll(onEvent: (event: NativeEvent) => void, delay = EVENT_POLL_INTERVAL_MS): void {
    if (!this.library || this.closed || this.eventTimer !== undefined) return;
    this.eventTimer = setTimeout(() => {
      this.eventTimer = undefined;
      this.pollEvents(onEvent);
    }, delay);
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
    if (!this.closed) this.scheduleEventPoll(onEvent);
  }

  private stopAfterEventFailure(): Error[] {
    const cleanupErrors: Error[] = [];
    if (!this.library) return cleanupErrors;
    this.clearEventTimer();
    const close = new TextEncoder().encode(JSON.stringify({ type: "close" }));
    if (this.library.symbols.tarve_send(close, close.length) !== 0) cleanupErrors.push(this.error());
    return cleanupErrors;
  }

  start(document: SceneDocument, onEvent: (event: NativeEvent) => void): void {
    if (this.library) throw new Error("Bridge already started");
    const path = this.options.libraryPath ?? nativePath();
    this.library = openLibrary(path);
    assertNativeAbiVersion(this.library.symbols.tarve_abi_version());
    const payload = new TextEncoder().encode(JSON.stringify(document));
    if (this.library.symbols.tarve_start(payload, payload.length) !== 0) {
      throw this.error();
    }
    this.scheduleEventPoll(onEvent, 0);
  }

  send(command: NativeCommand): void {
    if (this.closed) throw new Error("Native window is closed");
    if (!this.library) throw new Error("Bridge not started");
    const payload = new TextEncoder().encode(JSON.stringify(command));
    if (this.library.symbols.tarve_send(payload, payload.length) !== 0) throw this.error();
  }

  join(): void {
    if (!this.library) return;
    this.clearEventTimer();
    const result = this.library.symbols.tarve_join();
    if (result !== 0) throw this.error();
  }
}
