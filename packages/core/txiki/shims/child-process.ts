/** node:child_process spawn over tjs.spawn: exit/error events and stream-like stdio. spawnSync: child-process-sync.ts. */
import { Buffer } from "./buffer";
import { spawnDetachedWindows, spawnSync } from "./child-process-sync";
import { EventEmitter } from "./events";

export { spawnSync };

declare const TARVE_TXIKI_PLATFORM: "win32" | "linux";

type Stdio = "pipe" | "ignore" | "inherit";

export interface SpawnOptions {
  cwd?: string;
  env?: Record<string, string | undefined>;
  stdio?: Stdio | Stdio[];
  windowsHide?: boolean;
  /** The child outlives this process (on Windows, outside the job libuv puts children in). */
  detached?: boolean;
}

/** A Node-style readable over a web stream: "data"/"end" events or async iteration. */
class Readable extends EventEmitter {
  private encoding?: string;
  private started = false;

  constructor(private readonly stream: ReadableStream<Uint8Array>) {
    super();
  }

  setEncoding(encoding: string): this {
    this.encoding = encoding;
    return this;
  }

  private chunk(bytes: Uint8Array): Buffer | string {
    const buffer = Buffer.from(bytes);
    return this.encoding ? buffer.toString(this.encoding as "utf8") : buffer;
  }

  override on(event: string | symbol, listener: (...args: any[]) => void): this {
    super.on(event, listener);
    if (event === "data" && !this.started) void this.pump();
    return this;
  }

  private async pump(): Promise<void> {
    this.started = true;
    try {
      for await (const chunk of this) this.emit("data", chunk);
      this.emit("end");
    } catch (error) {
      if (this.listenerCount("error")) this.emit("error", error);
    }
    this.emit("close");
  }

  async *[Symbol.asyncIterator](): AsyncGenerator<Buffer | string> {
    const reader = this.stream.getReader();
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) return;
        yield this.chunk(value);
      }
    } finally {
      reader.releaseLock();
    }
  }
}

class Writable extends EventEmitter {
  private readonly writer: WritableStreamDefaultWriter<Uint8Array>;

  constructor(stream: WritableStream<Uint8Array>) {
    super();
    this.writer = stream.getWriter();
  }

  write(data: string | Uint8Array, callback?: (error?: Error) => void): boolean {
    this.writer.write(typeof data === "string" ? Buffer.from(data) : data).then(() => callback?.(), error => {
      callback?.(error);
      if (this.listenerCount("error")) this.emit("error", error);
    });
    return true;
  }

  end(data?: string | Uint8Array): this {
    if (data !== undefined) this.write(data);
    this.writer.close().catch(() => {});
    return this;
  }
}

interface TjsProcess {
  pid: number;
  stdin?: WritableStream<Uint8Array>;
  stdout?: ReadableStream<Uint8Array>;
  stderr?: ReadableStream<Uint8Array>;
  kill(signal?: string): void;
  wait(): Promise<{ exit_status: number; term_signal: string | null }>;
}

export class ChildProcess extends EventEmitter {
  pid?: number;
  exitCode: number | null = null;
  signalCode: string | null = null;
  killed = false;
  stdin: Writable | null = null;
  stdout: Readable | null = null;
  stderr: Readable | null = null;
  private process?: TjsProcess;

  constructor(command: string, args: readonly string[], options: SpawnOptions = {}) {
    super();
    if (options.detached && TARVE_TXIKI_PLATFORM === "win32") {
      try {
        this.pid = spawnDetachedWindows(command, args, options);
      } catch (error) {
        queueMicrotask(() => this.emit("error", error));
      }
      return;
    }
    const stdio = typeof options.stdio === "string" || options.stdio === undefined
      ? [options.stdio ?? "pipe", options.stdio ?? "pipe", options.stdio ?? "pipe"]
      : options.stdio;
    try {
      const spawn = (tjs as unknown as { spawn(args: string[], options: object): TjsProcess }).spawn;
      this.process = spawn([command, ...args], {
        ...(options.cwd ? { cwd: options.cwd } : {}),
        ...(options.env ? { env: Object.fromEntries(Object.entries(options.env).filter(([, value]) => value !== undefined)) } : {}),
        stdin: stdio[0] ?? "pipe", stdout: stdio[1] ?? "pipe", stderr: stdio[2] ?? "pipe",
      });
    } catch (error) {
      queueMicrotask(() => this.emit("error", error));
      return;
    }
    const child = this.process;
    this.pid = child.pid;
    if (child.stdin) this.stdin = new Writable(child.stdin);
    if (child.stdout) this.stdout = new Readable(child.stdout);
    if (child.stderr) this.stderr = new Readable(child.stderr);
    child.wait().then(status => {
      this.exitCode = status.term_signal ? null : status.exit_status;
      this.signalCode = status.term_signal;
      this.emit("exit", this.exitCode, this.signalCode);
      this.emit("close", this.exitCode, this.signalCode);
    }, error => this.emit("error", error));
  }

  /** tjs.spawn has no unref: a child it runs keeps the event loop alive. Detached children are not tracked. */
  unref(): this {
    return this;
  }

  ref(): this {
    return this;
  }

  kill(signal: string = "SIGTERM"): boolean {
    if (!this.process || this.exitCode !== null) return false;
    try {
      this.process.kill(signal);
      this.killed = true;
      return true;
    } catch {
      return false;
    }
  }
}

export function spawn(command: string, args: readonly string[] | SpawnOptions = [], options?: SpawnOptions): ChildProcess {
  return Array.isArray(args) ? new ChildProcess(command, args, options) : new ChildProcess(command, [], args as SpawnOptions);
}

export default { ChildProcess, spawn, spawnSync };
