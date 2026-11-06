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
const pending = new Set<Signal<unknown>>();

export class Signal<T> {
  readonly [SIGNAL] = true;
  #value: T;
  #listeners = new Set<Listener>();

  constructor(value: T) {
    this.#value = value;
  }

  get value(): T {
    return this.#value;
  }

  set value(next: T) {
    if (Object.is(next, this.#value)) return;
    this.#value = next;
    if (batchDepth > 0) pending.add(this as Signal<unknown>);
    else this.notify();
  }

  /** The value; the same as `value` (no subscription is ever made by reading). */
  peek(): T {
    return this.#value;
  }

  /** Calls `listener` after each change; returns the unsubscribe. */
  subscribe(listener: (signal: Signal<T>) => void): () => void {
    this.#listeners.add(listener as Listener);
    return () => { this.#listeners.delete(listener as Listener); };
  }

  /** @internal */
  notify(): void {
    for (const listener of this.#listeners) listener(this as Signal<unknown>);
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
      const changed = [...pending];
      pending.clear();
      for (const signal of changed) signal.notify();
    }
  }
}

/** A value that may be bound to a signal. */
export type Bindable<T> = T | Signal<T>;
