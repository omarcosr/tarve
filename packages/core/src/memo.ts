import type { VNode } from "./jsx-runtime";

/** Marks a component made by {@link memo}; the reconciler reads it. */
export const MEMO = Symbol.for("tarve.memo");

export interface MemoInfo<P> {
  render: (props: P) => VNode;
  equal: (previous: P, next: P) => boolean;
  /** A compiled JSX template (jsx-compile.ts): it renders one element, which keeps its list position. */
  template?: boolean;
}

/**
 * Marks a component whose output depends only on its props (a layout box, a text): no state,
 * no context, no module variables. The reconciler then reuses an unchanged list item made of
 * such components without compiling it again (`sameVNode`).
 */
export const PURE = Symbol.for("tarve.pure");

export function markPure<T extends Function>(component: T): T {
  (component as unknown as Record<symbol, boolean>)[PURE] = true;
  return component;
}

/**
 * Whether two VNodes compile the same: equal types and keys, props equal as plain data, and
 * every element in them pure: `pureElement` (the reconciler's call: native kinds and plain
 * HTML boxes; elements such as `<video>` expand with state and are not) or a component marked
 * with {@link markPure}. Anything else, a component that may read state included, is never the same.
 */
export function sameVNode(a: VNode, b: VNode, pureElement: (vnode: VNode) => boolean): boolean {
  const outer = pureCheck;
  pureCheck = pureElement;
  try {
    return sameNode(a, b);
  } finally {
    pureCheck = outer;
  }
}

// Module-level helpers rather than closures made per call: an interpreter (QuickJS on Android)
// pays for every closure and `for…in`, and a list compares thousands of items per render.
let pureCheck: (vnode: VNode) => boolean = () => false;
const hasOwn = Object.prototype.hasOwnProperty;

function isPure(node: VNode): boolean {
  const type = node.type;
  return typeof type === "string"
    ? pureCheck(node)
    : typeof type === "function" && (type as unknown as Record<symbol, unknown>)[PURE] === true;
}

function isVNodeLike(value: object): value is VNode {
  return "type" in value && "props" in value && "key" in value;
}

function everyVNode(child: unknown): boolean {
  if (typeof child !== "object" || child === null) return true;
  if (Array.isArray(child)) {
    for (let index = 0; index < child.length; index++) if (!everyVNode(child[index])) return false;
    return true;
  }
  if (isVNodeLike(child)) {
    if (!isPure(child)) return false;
    const props = child.props as Record<string, unknown>;
    for (const key in props) if (!everyVNode(props[key])) return false;
  }
  return true;
}

/** Plain data equal by value: what a pure subtree's output can depend on. Functions only by identity. */
function sameData(x: unknown, y: unknown): boolean {
  // The same object: equal, but a VNode in it must still be pure.
  if (Object.is(x, y)) return typeof x !== "object" || x === null || everyVNode(x);
  if (typeof x !== "object" || typeof y !== "object" || x === null || y === null) return false;
  if (Array.isArray(x)) {
    if (!Array.isArray(y) || x.length !== y.length) return false;
    for (let index = 0; index < x.length; index++) if (!sameData(x[index], y[index])) return false;
    return true;
  }
  if (Array.isArray(y)) return false;
  const xNode = isVNodeLike(x), yNode = isVNodeLike(y);
  if (xNode || yNode) return xNode && yNode && sameNode(x, y);
  const prototype = Object.getPrototypeOf(x);
  if ((prototype !== Object.prototype && prototype !== null) || Object.getPrototypeOf(y) !== prototype) return false;
  const p = x as Record<string, unknown>, q = y as Record<string, unknown>;
  const keys = Object.keys(p);
  if (keys.length !== Object.keys(q).length) return false;
  for (let index = 0; index < keys.length; index++) {
    const key = keys[index]!;
    if (!hasOwn.call(q, key) || !sameData(p[key], q[key])) return false;
  }
  return true;
}

function sameNode(x: VNode, y: VNode): boolean {
  if (x === y) return everyVNode(x);
  if (x.type !== y.type || x.key !== y.key || !isPure(x)) return false;
  return sameData(x.props, y.props);
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
