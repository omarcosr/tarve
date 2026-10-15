/** node:events: the EventEmitter subset apps and the shims use. */
type Listener = (...args: any[]) => void;

export class EventEmitter {
  private readonly events = new Map<string | symbol, Listener[]>();

  on(event: string | symbol, listener: Listener): this {
    this.events.set(event, [...this.events.get(event) ?? [], listener]);
    return this;
  }

  addListener(event: string | symbol, listener: Listener): this {
    return this.on(event, listener);
  }

  once(event: string | symbol, listener: Listener): this {
    const wrapper: Listener = (...args) => {
      this.off(event, wrapper);
      listener(...args);
    };
    return this.on(event, wrapper);
  }

  off(event: string | symbol, listener: Listener): this {
    const listeners = this.events.get(event);
    if (listeners) this.events.set(event, listeners.filter(item => item !== listener));
    return this;
  }

  removeListener(event: string | symbol, listener: Listener): this {
    return this.off(event, listener);
  }

  removeAllListeners(event?: string | symbol): this {
    if (event === undefined) this.events.clear();
    else this.events.delete(event);
    return this;
  }

  emit(event: string | symbol, ...args: unknown[]): boolean {
    const listeners = this.events.get(event);
    if (!listeners?.length) {
      if (event === "error") throw args[0] instanceof Error ? args[0] : new Error(String(args[0]));
      return false;
    }
    for (const listener of [...listeners]) listener(...args);
    return true;
  }

  listenerCount(event: string | symbol): number {
    return this.events.get(event)?.length ?? 0;
  }

  setMaxListeners(_count: number): this {
    return this;
  }
}

/** Resolves with the event's arguments; rejects on "error" (except when waiting for "error"). */
export function once(emitter: EventEmitter, event: string): Promise<unknown[]> {
  return new Promise((resolve, reject) => {
    const done = (...args: unknown[]) => {
      emitter.off("error", fail);
      resolve(args);
    };
    const fail = (error: unknown) => {
      emitter.off(event, done);
      reject(error);
    };
    emitter.once(event, done);
    if (event !== "error") emitter.once("error", fail);
  });
}

export default Object.assign(EventEmitter, { EventEmitter, once });
