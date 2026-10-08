import type { VNode } from "./jsx-runtime";

/** Marks a component made by {@link memo}; the reconciler reads it. */
export const MEMO = Symbol.for("tarve.memo");

export interface MemoInfo<P> {
  render: (props: P) => VNode;
  equal: (previous: P, next: P) => boolean;
}

/** Object.is on every own prop, like React.memo's default comparison. */
export function shallowEqual(previous: object, next: object): boolean {
  if (previous === next) return true;
  const a = previous as Record<string, unknown>;
  const b = next as Record<string, unknown>;
  const keys = Object.keys(a);
  if (keys.length !== Object.keys(b).length) return false;
  return keys.every(key => Object.prototype.hasOwnProperty.call(b, key) && Object.is(a[key], b[key]));
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
