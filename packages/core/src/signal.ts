/**
 * Signals: values a view binds to a node's text or style without rendering again. Setting
 * `value` updates only the native nodes that show it, in one small command, the way BUI binds
 * an attribute to a signal or the DOM sets `element.style` (`<Text>{count}</Text>`,
 * `style={{ background: color }}`). Reading `value` inside a component makes no subscription:
 * pass the signal itself as the child or style value.
 */
const SIGNAL = Symbol.for("tarve.signal");

type Listener = (signal: Signal<unknown>) => void;

let batchDepth = 0;
/** Signals a batch changed, each once (`queued`), in the order they first changed. */
let pending: Signal<unknown>[] = [];

export class Signal<T> {
  readonly [SIGNAL] = true;
  #value: T;
  /** Most signals have one subscriber (the node they are bound to): no Set for them. */
  #listener: Listener | undefined;
  #listeners: Set<Listener> | undefined;
  /** In `pending` (changed during the running batch). */
  #queued = false;

  constructor(value: T) {
    this.#value = value;
  }

  get value(): T {
    return this.#value;
  }

  set value(next: T) {
    if (Object.is(next, this.#value)) return;
    this.#value = next;
    if (batchDepth > 0) {
      if (!this.#queued) {
        this.#queued = true;
        pending.push(this as Signal<unknown>);
      }
    } else this.notify();
  }

  /** The value; the same as `value` (no subscription is ever made by reading). */
  peek(): T {
    return this.#value;
  }

  /** Calls `listener` after each change; returns the unsubscribe. */
  subscribe(listener: (signal: Signal<T>) => void): () => void {
    const added = listener as Listener;
    if (this.#listeners) this.#listeners.add(added);
    else if (this.#listener && this.#listener !== added) this.#listeners = new Set([this.#listener, added]);
    else this.#listener = added;
    return () => this.unsubscribe(listener);
  }

  /** Stops calling `listener` (what `subscribe`'s returned function does, without a closure per subscription). */
  unsubscribe(listener: (signal: Signal<T>) => void): void {
    if (this.#listeners) this.#listeners.delete(listener as Listener);
    else if (this.#listener === listener) this.#listener = undefined;
  }

  /** @internal */
  notify(): void {
    this.#queued = false;
    if (this.#listeners) for (const listener of this.#listeners) listener(this as Signal<unknown>);
    else this.#listener?.(this as Signal<unknown>);
  }

  /** @internal Notifies `changed` in order; a listener that throws leaves the rest unqueued. */
  static notifyAll(changed: Signal<unknown>[]): void {
    let index = 0;
    try {
      for (; index < changed.length; index++) changed[index]!.notify();
    } finally {
      for (index++; index < changed.length; index++) changed[index]!.#queued = false;
    }
  }

  toString(): string {
    return String(this.#value);
  }
}

export function signal<T>(value: T): Signal<T> {
  return new Signal(value);
}

export function isSignal(value: unknown): value is Signal<unknown> {
  return typeof value === "object" && value !== null && (value as Record<symbol, unknown>)[SIGNAL] === true;
}

/** Runs `fn`, then notifies each signal it changed once. */
export function batch<T>(fn: () => T): T {
  batchDepth++;
  try {
    return fn();
  } finally {
    if (--batchDepth === 0) {
      const changed = pending;
      pending = [];
      Signal.notifyAll(changed);
    }
  }
}

/** A value that may be bound to a signal. */
export type Bindable<T> = T | Signal<T>;
