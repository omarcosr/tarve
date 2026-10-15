import type { VNode } from "./jsx-runtime";

/** Marks a component made by {@link memo}; the reconciler reads it. */
export const MEMO = Symbol.for("tarve.memo");

export interface MemoInfo<P> {
  render: (props: P) => VNode;
  equal: (previous: P, next: P) => boolean;
  /** A compiled JSX template (jsx-compile.ts): it renders one element, which keeps its list position. */
  template?: boolean;
}

/** Object.is on every own prop, like React.memo's default comparison. */
export function shallowEqual(previous: object, next: object): boolean {
  if (previous === next) return true;
  const a = previous as Record<string, unknown>;
  const b = next as Record<string, unknown>;
  const keys = Object.keys(a);
  if (keys.length !== Object.keys(b).length) return false;
  for (let index = 0; index < keys.length; index++) {
    const key = keys[index]!;
    if (!Object.is(a[key], b[key]) || !Object.prototype.hasOwnProperty.call(b, key)) return false;
  }
  return true;
}

/**
 * A component whose compiled subtree is reused while its props stay equal
 * (shallowly, or by `equal`), its position in the tree is the same, and the
 * theme, inherited font and form around it have not changed. A reused subtree
 * costs no rendering, no compiling and no diffing: an update touches only the
 * components whose props changed. Everything the component shows must come
 * from its props; reading module state inside it shows stale values.
 */
export function memo<P extends object>(render: (props: P) => VNode, equal: (previous: P, next: P) => boolean = shallowEqual): (props: P) => VNode {
  const component = (props: P) => render(props);
  (component as unknown as Record<symbol, MemoInfo<P>>)[MEMO] = { render, equal };
  Object.defineProperty(component, "name", { value: `memo(${render.name || "Component"})` });
  return component;
}

const LIVE = Symbol("tarve.template.live");

/**
 * A JSX subtree compiled at build time (packages/core/jsx-compile.ts): `render` builds
 * the subtree from its dynamic parts (`props`), which are only values the parent
 * computed, so the compiled subtree is reused while they are equal. Event handler
 * props (`events`) never force a recompile: the subtree calls whichever handler the
 * latest render passed.
 */
export function template<P extends Record<string, unknown>>(render: (props: P) => VNode, events: readonly string[] = []): (props: P) => VNode {
  const isEvent = new Set(events);
  type Live = { current: P };
  const equal = (previous: P, next: P): boolean => {
    if (previous === next) return true;
    const keys = Object.keys(next);
    if (keys.length !== Object.keys(previous).length) return false;
    for (let index = 0; index < keys.length; index++) {
      const key = keys[index]!;
      const a = previous[key], b = next[key];
      if (Object.is(a, b)) continue;
      if (isEvent.has(key) && typeof a === "function" && typeof b === "function") continue;
      return false;
    }
    const live = (previous as Record<symbol, Live | undefined>)[LIVE];
    if (live) {
      live.current = next;
      (next as Record<symbol, Live>)[LIVE] = live;
    }
    return true;
  };
  const component = (props: P): VNode => {
    if (!events.length) return render(props);
    const live: Live = { current: props };
    (props as Record<symbol, Live>)[LIVE] = live;
    const forwarded = { ...props };
    for (const name of events) {
      if (typeof props[name] === "function") (forwarded as Record<string, unknown>)[name] = (...args: unknown[]) => (live.current[name] as (...args: unknown[]) => unknown)(...args);
    }
    return render(forwarded);
  };
  (component as unknown as Record<symbol, MemoInfo<P>>)[MEMO] = { render: component, equal, template: true };
  return component;
}
