/**
 * node:net over txiki.js pipes (a Windows named pipe or a Unix socket): client sockets
 * (tjs.connect) for the native event wake pipe, and a server (tjs.listen) with the sockets it
 * accepts for requestSingleInstance. Only the methods and events those use exist.
 */
type Listener = (...args: any[]) => void;

/** What tjs.listen gives: accepted connections arrive on `opened.readable`. */
interface TjsListener {
  readonly opened: Promise<{ readable: ReadableStream<TjsConnection> }>;
  close(): void;
}

const encoder = new TextEncoder();

class Emitter {
  private readonly listeners = new Map<string, Listener[]>();

  protected emit(event: string, ...args: unknown[]): void {
    for (const listener of this.listeners.get(event) ?? []) listener(...args);
  }

  on(event: string, listener: Listener): this {
    this.listeners.set(event, [...this.listeners.get(event) ?? [], listener]);
    return this;
  }

  removeAllListeners(event?: string): this {
    if (event === undefined) this.listeners.clear(); else this.listeners.delete(event);
    return this;
  }
}

export class Socket extends Emitter {
  destroyed = false;
  private connection?: TjsConnection;
  private writer?: WritableStreamDefaultWriter<Uint8Array>;
  private decoder?: TextDecoder;
  /** Written before the connection opened. */
  private pending: Uint8Array[] = [];
  private ending = false;
  /** This side's end, once asked for: settles when what was written went out. */
  private ended?: Promise<void>;

  /** A path to connect to, or a connection a Server accepted. */
  constructor(source: string | TjsConnection) {
    super();
    const connecting = typeof source === "string" ? tjs.connect("pipe", source) : Promise.resolve(source);
    connecting.then(async connection => {
      if (this.destroyed) {
        connection.close();
        return;
      }
      this.connection = connection;
      const { readable, writable } = await connection.opened;
      this.writer = writable.getWriter();
      for (const chunk of this.pending.splice(0)) this.send(chunk);
      if (this.ending) this.finish();
      if (typeof source === "string") this.emit("connect");
      void this.pump(readable);
    }).catch(error => this.fail(error));
  }

  private async pump(readable: ReadableStream<Uint8Array>): Promise<void> {
    const reader = readable.getReader();
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (this.destroyed) return;
        if (done) break;
        this.emit("data", this.decoder ? this.decoder.decode(value, { stream: true }) : value);
      }
      this.destroyed = true;
      this.emit("end");
      // The peer ended: like Node.js (allowHalfOpen false) end this side too, then release the
      // handle, which would otherwise keep the process alive.
      if (!this.ending) this.finish();
      const connection = this.connection;
      void this.ended!.finally(() => connection?.close());
      this.emit("close", false);
    } catch (error) {
      this.fail(error);
    }
  }

  private fail(error: unknown): void {
    if (this.destroyed) return;
    this.destroyed = true;
    this.connection?.close();
    this.emit("error", error instanceof Error ? error : new Error(String(error)));
    this.emit("close", true);
  }

  private send(bytes: Uint8Array): void {
    this.writer!.write(bytes).catch(error => this.fail(error));
  }

  private finish(): void {
    this.ended ??= this.writer!.close().catch(() => {});
  }

  setEncoding(encoding: string): this {
    this.decoder = new TextDecoder(encoding);
    return this;
  }

  write(data: string | Uint8Array): boolean {
    const bytes = typeof data === "string" ? encoder.encode(data) : data;
    if (this.writer) this.send(bytes); else this.pending.push(bytes);
    return true;
  }

  /** Writes `data`, then closes this side; the peer reads the end. */
  end(data?: string | Uint8Array): this {
    if (data !== undefined) this.write(data);
    this.ending = true;
    if (this.writer) this.finish();
    return this;
  }

  destroy(): this {
    if (this.destroyed) return this;
    this.destroyed = true;
    this.connection?.close();
    return this;
  }
}

export class Server extends Emitter {
  private listener?: TjsListener;
  private closed = false;

  constructor(onConnection?: (socket: Socket) => void) {
    super();
    if (onConnection) this.on("connection", onConnection);
  }

  listen(path: string, callback?: () => void): this {
    tjs.listen("pipe", path).then(async listener => {
      if (this.closed) {
        listener.close();
        return;
      }
      this.listener = listener;
      const { readable } = await listener.opened;
      callback?.();
      this.emit("listening");
      const reader = readable.getReader();
      for (;;) {
        const { done, value } = await reader.read();
        if (done || this.closed) return;
        this.emit("connection", new Socket(value));
      }
    }).catch(error => {
      if (!this.closed) this.emit("error", error instanceof Error ? error : new Error(String(error)));
    });
    return this;
  }

  /**
   * txiki.js has no public API to let the process exit while a listener is open (tjs.listen
   * returns no handle to unref), so this throws instead of silently keeping the process
   * alive: close() the server when it is no longer needed.
   */
  unref(): this {
    throw new Error("server.unref() is not available in the Tarve txiki.js runtime (txiki.js cannot unref a listener); close() the server instead.");
  }

  close(callback?: () => void): this {
    if (this.closed) return this;
    this.closed = true;
    this.listener?.close();
    callback?.();
    this.emit("close");
    return this;
  }
}

export function createConnection(path: string, onConnect?: () => void): Socket {
  const socket = new Socket(path);
  if (onConnect) socket.on("connect", onConnect);
  return socket;
}

export const connect = createConnection;

export function createServer(onConnection?: (socket: Socket) => void): Server {
  return new Server(onConnection);
}

export default { Socket, Server, connect, createConnection, createServer };
