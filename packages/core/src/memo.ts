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
  if (Object.is(x, y)) return typeof x !== "object" || x === null || ((slotList === undefined || slotsIn(x)) && everyVNode(x));
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
  if (x === y) {
    if (slotList !== undefined && !sameSlots(x)) return false;
    return everyVNode(x);
  }
  if (x.type !== y.type || x.key !== y.key || !isPure(x)) return false;
  if (slotList !== undefined) {
    const index = slotOf(x);
    if (index >= 0) return sameSlot(x, y, index);
  }
  return sameData(x.props, y.props);
}

/**
 * Marks a component whose `children` reach its native text node unchanged and nothing else:
 * new primitive children only change that node's text (the reconciler patches it in place).
 */
export const TEXT_SLOT = Symbol.for("tarve.textSlot");

export function markTextSlot<T extends Function>(component: T): T {
  (component as unknown as Record<symbol, boolean>)[TEXT_SLOT] = true;
  return component;
}

// sameVNodeExceptText's state: module-level, like pureCheck, so the recursion stays closure-free.
let slotList: readonly VNode[] | undefined;
/** slotList by VNode when it is long; short lists are searched (an item has a text or two). */
let slotMap: Map<VNode, number> | undefined;
function slotOf(node: VNode): number {
  if (slotMap !== undefined) return slotMap.get(node) ?? -1;
  return slotList!.indexOf(node);
}
let slotOwners: (VNode | undefined)[] = [];
let slotChildren: unknown[] = [];

/** Strings, numbers and arrays of them: children that compile to plain text. */
function primitiveChildren(children: unknown): boolean {
  if (typeof children === "string" || typeof children === "number") return true;
  if (!Array.isArray(children)) return false;
  for (let index = 0; index < children.length; index++) {
    const child = children[index];
    if (typeof child !== "string" && typeof child !== "number") return false;
  }
  return true;
}

function sameSlot(x: VNode, y: VNode, index: number): boolean {
  const p = x.props as Record<string, unknown>, q = y.props as Record<string, unknown>;
  const keys = Object.keys(p);
  if (keys.length !== Object.keys(q).length) return false;
  for (let k = 0; k < keys.length; k++) {
    const key = keys[k]!;
    if (key === "children") continue;
    if (!hasOwn.call(q, key) || !sameData(p[key], q[key])) return false;
  }
  if (!hasOwn.call(q, "children") && hasOwn.call(p, "children")) return false;
  slotOwners[index] = y;
  if (sameData(p.children, q.children)) return true;
  if (!primitiveChildren(p.children) || !primitiveChildren(q.children)) return false;
  slotChildren[index] = q.children;
  return true;
}

/** The same VNode object on both sides: its slots keep their owners. */
function sameSlots(node: VNode): boolean {
  const index = slotOf(node);
  if (index >= 0) slotOwners[index] = node;
  const props = node.props as Record<string, unknown>;
  for (const key in props) if (!slotsIn(props[key])) return false;
  return true;
}

function slotsIn(value: unknown): boolean {
  if (typeof value !== "object" || value === null) return true;
  if (Array.isArray(value)) {
    for (let index = 0; index < value.length; index++) if (!slotsIn(value[index])) return false;
    return true;
  }
  return isVNodeLike(value) ? sameSlots(value) : true;
}

/** Whether a VNode's own type is pure: a pure element, or a component marked with {@link markPure}. */
export function pureRoot(vnode: VNode, pureElement: (vnode: VNode) => boolean): boolean {
  const type = vnode.type;
  return typeof type === "string" ? pureElement(vnode) : typeof type === "function" && (type as unknown as Record<symbol, unknown>)[PURE] === true;
}

/**
 * {@link sameVNode}, except that the VNodes in `slots` (text components or native texts, by
 * object) may have new primitive children. Fills `owners` with each slot's VNode in `b` and
 * `children` with its new children where they changed (undefined where they did not). False
 * when anything else differs, or a slot is not found in `b`.
 */
export function sameVNodeExceptText(
  a: VNode, b: VNode, pureElement: (vnode: VNode) => boolean,
  slots: readonly VNode[], owners: (VNode | undefined)[], children: unknown[],
): boolean {
  const outerCheck = pureCheck, outerList = slotList, outerMap = slotMap, outerOwners = slotOwners, outerChildren = slotChildren;
  pureCheck = pureElement;
  slotList = slots; slotOwners = owners; slotChildren = children;
  if (slots.length > 8) {
    slotMap = new Map();
    for (let index = 0; index < slots.length; index++) slotMap.set(slots[index]!, index);
  } else slotMap = undefined;
  try {
    if (!sameNode(a, b)) return false;
    for (let index = 0; index < slots.length; index++) if (owners[index] === undefined) return false;
    return true;
  } finally {
    pureCheck = outerCheck; slotList = outerList; slotMap = outerMap; slotOwners = outerOwners; slotChildren = outerChildren;
  }
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
