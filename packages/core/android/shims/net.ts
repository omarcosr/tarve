/**
 * node:net createConnection for the bridge's event wake pipe. On Android the host loop
 * calls __tarveWake (prelude.ts) when the runtime queues events: each open socket gets a
 * "data" event, as the Unix socket gives Bun and Node.js. Any other address refuses the
 * connection, and a server listens only inside the process: Android runs one process per
 * app, so requestSingleInstance's first instance is always this one.
 */
type Listener = (...args: any[]) => void;

/** The name tarve_event_pipe_name reports on Android. */
export const WAKE_PIPE = "tarve-android-wake";
export const wakeSockets = new Set<Socket>();

export class Socket {
  destroyed = false;
  private readonly listeners = new Map<string, Listener[]>();

  constructor(path: string, onConnect?: () => void) {
    if (onConnect) this.on("connect", onConnect);
    if (path !== WAKE_PIPE) {
      setTimeout(() => this.fail(new Error(`connect ENOENT ${path}: only the Tarve event wake pipe is available on Android`)), 0);
      return;
    }
    wakeSockets.add(this);
    setTimeout(() => { if (!this.destroyed) this.emit("connect"); }, 0);
  }

  /** Called by the host loop through __tarveWake. */
  wake(): void {
    if (!this.destroyed) this.emit("data", new Uint8Array(0));
  }

  private fail(error: Error): void {
    if (this.destroyed) return;
    this.destroyed = true;
    this.emit("error", error);
    this.emit("close", true);
  }

  private emit(event: string, ...args: unknown[]): void {
    for (const listener of this.listeners.get(event) ?? []) listener(...args);
  }

  on(event: string, listener: Listener): this {
    this.listeners.set(event, [...this.listeners.get(event) ?? [], listener]);
    return this;
  }

  once(event: string, listener: Listener): this {
    const once: Listener = (...args) => { this.listeners.set(event, (this.listeners.get(event) ?? []).filter(l => l !== once)); listener(...args); };
    return this.on(event, once);
  }

  setEncoding(_encoding: string): this { return this; }
  write(_data: unknown): boolean { return !this.destroyed; }
  end(_data?: unknown): this { return this.destroy(); }

  destroy(): this {
    this.destroyed = true;
    wakeSockets.delete(this);
    return this;
  }
}

export function createConnection(path: string, onConnect?: () => void): Socket {
  return new Socket(path, onConnect);
}

export const connect = createConnection;

/** A server no other process can reach: listening succeeds, nothing ever connects. */
export class Server {
  private readonly listeners = new Map<string, Listener[]>();
  listening = false;

  on(event: string, listener: Listener): this {
    this.listeners.set(event, [...this.listeners.get(event) ?? [], listener]);
    return this;
  }

  listen(_address: unknown, onListening?: () => void): this {
    this.listening = true;
    if (onListening) setTimeout(onListening, 0);
    return this;
  }

  close(onClose?: () => void): this {
    this.listening = false;
    if (onClose) setTimeout(onClose, 0);
    return this;
  }

  ref(): this { return this; }
  unref(): this { return this; }
}

export function createServer(_onConnection?: (socket: Socket) => void): Server {
  return new Server();
}

export default { Socket, Server, connect, createConnection, createServer };
