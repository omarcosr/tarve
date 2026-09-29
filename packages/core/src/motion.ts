import type { NumericMotionProperty as MotionProperty, MotionTransitions, MotionValues, Style } from "../../protocol/src/index";
import { currentRenderEpoch, currentRenderScope } from "./render-scope";
import { Fragment, jsx, type VNode } from "./jsx-runtime";

export interface AnimatePresenceProps {
  /** Stable identity for this presence boundary. */
  id: string;
  present: boolean;
  children: VNode;
  /** Initial numeric values applied when the native node is first mounted. */
  enter?: MotionValues;
  /** Numeric targets held until their native transitions finish. */
  exit: MotionValues;
  /** Overrides the child's style.transition for enter/exit motion. */
  transition?: MotionTransitions;
}

interface PresenceState {
  lastVNode?: VNode;
  exiting: boolean;
  removed: boolean;
  awaited: Set<MotionProperty>;
  completed: Set<MotionProperty>;
  lastSeenEpoch: number;
}

interface PresenceStore {
  states: Map<string, PresenceState>;
  lastSweepEpoch: number;
}

const stores = new WeakMap<object, PresenceStore>();
const properties: readonly MotionProperty[] = [
  "width", "height", "top", "right", "bottom", "left", "opacity", "radius",
];

function storeForScope(): PresenceStore {
  const scope = currentRenderScope();
  const existing = stores.get(scope);
  if (existing) return existing;
  const store: PresenceStore = { states: new Map(), lastSweepEpoch: 0 };
  stores.set(scope, store);
  return store;
}

function stateFor(store: PresenceStore, id: string): PresenceState {
  const epoch = currentRenderEpoch();
  if (epoch > store.lastSweepEpoch) {
    for (const [key, state] of store.states) {
      if (state.lastSeenEpoch < epoch - 1) store.states.delete(key);
    }
    store.lastSweepEpoch = epoch;
  }
  const existing = store.states.get(id);
  if (existing) {
    existing.lastSeenEpoch = epoch;
    return existing;
  }
  const state: PresenceState = {
    exiting: false,
    removed: false,
    awaited: new Set(),
    completed: new Set(),
    lastSeenEpoch: epoch,
  };
  store.states.set(id, state);
  return state;
}

function transitionFor(style: Style, property: MotionProperty) {
  return style.transition?.[property] ?? style.transition?.all;
}

function currentNumericValue(style: Style, property: MotionProperty): number | undefined {
  const value = style[property];
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (property === "opacity") return 1;
  if (property === "radius") return 0;
  return undefined;
}

function exitingProperties(vnode: VNode, style: Style, exit: MotionValues): Set<MotionProperty> {
  const awaited = new Set<MotionProperty>();
  for (const property of properties) {
    const target = exit[property];
    if (target === undefined || !Number.isFinite(target)) continue;
    const current = currentNumericValue(vnode.props.style ?? {}, property);
    if (current === undefined || Math.abs(current - target) <= Number.EPSILON) continue;
    const transition = transitionFor(style, property);
    const duration = transition?.duration ?? 200;
    const delay = transition?.delay ?? 0;
    if (Number.isFinite(duration) && duration > 0 && Number.isFinite(delay) && delay >= 0) {
      awaited.add(property);
    }
  }
  return awaited;
}

function cloneWithMotion(
  vnode: VNode,
  style: Style,
  motionFrom: MotionValues | undefined,
  onTransitionEnd?: (event: { property: MotionProperty }) => void,
): VNode {
  return {
    ...vnode,
    props: {
      ...vnode.props,
      style,
      ...(motionFrom ? { motionFrom } : {}),
      ...(onTransitionEnd ? { onTransitionEnd } : {}),
    },
  };
}

/**
 * Keeps one native child alive while its exit targets are animated by the Rust renderer.
 * Keep the boundary itself mounted and toggle `present` so Tarve can retain native identity.
 */
export function AnimatePresence({
  id,
  present,
  children,
  enter,
  exit,
  transition,
}: AnimatePresenceProps): VNode {
  if (!id) throw new TypeError("AnimatePresence requires a stable id");
  if (!children || typeof children !== "object" || Array.isArray(children)) {
    throw new TypeError("AnimatePresence requires exactly one VNode child");
  }

  const store = storeForScope();
  const state = stateFor(store, id);

  if (present) {
    state.lastVNode = children;
    state.exiting = false;
    state.removed = false;
    state.awaited.clear();
    state.completed.clear();
    const style: Style = {
      ...(children.props.style ?? {}),
      ...(transition ? { transition } : {}),
    };
    return cloneWithMotion(children, style, enter ?? children.props.motionFrom, children.props.onTransitionEnd);
  }

  const vnode = state.lastVNode;
  if (!vnode || state.removed) return jsx(Fragment, {});

  const style: Style = {
    ...(vnode.props.style ?? {}),
    ...exit,
    ...(transition ? { transition } : {}),
  };
  if (!state.exiting) {
    state.awaited = exitingProperties(vnode, style, exit);
    state.completed.clear();
    state.exiting = true;
    if (state.awaited.size === 0) {
      state.removed = true;
      state.lastVNode = undefined;
      return jsx(Fragment, {});
    }
  }

  const previous = vnode.props.onTransitionEnd as ((event: { property: MotionProperty }) => void) | undefined;
  const onTransitionEnd = (event: { property: MotionProperty }) => {
    if (state.exiting && state.awaited.has(event.property)) {
      state.completed.add(event.property);
      if (state.completed.size === state.awaited.size) {
        state.removed = true;
        state.exiting = false;
        state.lastVNode = undefined;
      }
    }
    previous?.(event);
  };
  return cloneWithMotion(vnode, style, undefined, onTransitionEnd);
}
