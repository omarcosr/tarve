/**
 * node:net createConnection for the native event wake pipe (a Windows named pipe or a
 * Unix socket), over tjs.connect("pipe"). Only the events the bridge listens to exist.
 */
type Listener = (...args: any[]) => void;

export class Socket {
  destroyed = false;
  private readonly listeners = new Map<string, Listener[]>();
  private connection?: TjsConnection;

  constructor(path: string) {
    tjs.connect("pipe", path).then(async connection => {
      if (this.destroyed) {
        connection.close();
        return;
      }
      this.connection = connection;
      const { readable } = await connection.opened;
      this.emit("connect");
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
        this.emit("data", value);
      }
      this.destroyed = true;
      this.emit("close", false);
    } catch (error) {
      this.fail(error);
    }
  }

  private fail(error: unknown): void {
    if (this.destroyed) return;
    this.destroyed = true;
    this.emit("error", error instanceof Error ? error : new Error(String(error)));
    this.emit("close", true);
  }

  private emit(event: string, ...args: unknown[]): void {
    for (const listener of this.listeners.get(event) ?? []) listener(...args);
  }

  on(event: string, listener: Listener): this {
    this.listeners.set(event, [...this.listeners.get(event) ?? [], listener]);
    return this;
  }

  destroy(): this {
    if (this.destroyed) return this;
    this.destroyed = true;
    this.connection?.close();
    return this;
  }
}

export function createConnection(path: string): Socket {
  return new Socket(path);
}

export default { Socket, createConnection };
