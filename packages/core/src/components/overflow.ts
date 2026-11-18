import { jsx, type Child, type SizeEvent, type VNode } from "../jsx-runtime";
import type { Style } from "../protocol";
import { scopedState } from "../render-scope";
import { container, type ViewProps } from "./layout";

export interface OverflowProps<T> extends Omit<ViewProps, "children" | "gap"> {
  /** Remembers the measured sizes across renders. */
  id: string;
  items: readonly T[];
  renderItem: (item: T, index: number) => Child;
  /** The control for the items that do not fit (a "more" button); not shown while everything fits. */
  renderOverflow?: (hidden: T[]) => Child;
  /** Stable key of an item. Default: its index. */
  itemKey?: (item: T, index: number) => string | number;
  gap?: number;
  /** Main axis. Default `"row"`. */
  direction?: "row" | "column";
  /**
   * Space available on the main axis, in logical px (border box). When set, the box sizes to its
   * items up to `max` (`maxWidth`/`maxHeight`) and decides what fits against `max` instead of
   * its measured size, so it works in a container that grows with its content (a dock, a taskbar).
   */
  max?: number;
}

interface OverflowSizes {
  /** Content-box main size of the container. */
  container?: number;
  /** Padding plus border of the container on the main axis. */
  inset?: number;
  /** Border-box main size of the overflow control. */
  more?: number;
  items: Map<string | number, number>;
}

const OVERFLOW_SIZES = Symbol("tarve.overflow.sizes");

/**
 * How many leading items fit in `available` next to each other (`gap` apart), keeping room for
 * the overflow control when some do not. Unknown sizes count as fitting: they are shown so the
 * next layout measures them.
 */
export function overflowVisibleCount(sizes: readonly (number | undefined)[], available: number | undefined, gap: number, more = 0): number {
  if (available === undefined) return sizes.length;
  let total = 0;
  for (let index = 0; index < sizes.length; index++) total += (sizes[index] ?? 0) + (index > 0 ? gap : 0);
  if (total <= available + 0.5) return sizes.length;
  let used = more;
  let count = 0;
  for (const size of sizes) {
    used += (size ?? 0) + gap;
    if (used > available + 0.5) break;
    count++;
  }
  return count;
}

/**
 * A row (or column) that shows the leading items that fit and hands the rest to
 * `renderOverflow(hidden)`, like a toolbar or tab strip's "more" menu.
 *
 * Native layout has no "hide what does not fit and tell me" rule, so the decision is made in JS
 * from sizes native reports (`onSize`), with no extra pass: sizes from one layout arrive in one
 * batch, which re-renders once with the new split, computed during that render (no microtask
 * re-render). Items keep their last measured size while hidden (`display: none`), so growing back
 * needs no trial render; an item never measured is shown once to be measured. The box clips
 * (`overflow: hidden`) so nothing spills meanwhile. Give it a bounded main size (`flex: 1`, a
 * width), or `max` to let it grow with its items up to a limit.
 */
export function Overflow<T>({
  id,
  items,
  renderItem,
  renderOverflow,
  itemKey,
  gap = 0,
  direction = "row",
  max,
  onSize,
  style,
  ...props
}: OverflowProps<T>): VNode {
  if (direction !== "row" && direction !== "column") throw new TypeError(`Unsupported Overflow direction: ${direction}`);
  if (max !== undefined && !(max >= 0)) throw new RangeError(`Overflow max must be a non-negative number: ${max}`);
  const all = scopedState(OVERFLOW_SIZES, () => new Map<string, OverflowSizes>());
  let sizes = all.get(id);
  if (!sizes) all.set(id, sizes = { items: new Map() });
  const store = sizes;
  const row = direction === "row";
  const main = (size: SizeEvent, border: boolean) => {
    const box = border ? size.borderBox : size;
    return row ? box.width : box.height;
  };
  const keys = items.map((item, index) => itemKey ? itemKey(item, index) : index);
  if (store.items.size > keys.length) {
    const live = new Set(keys);
    for (const key of store.items.keys()) if (!live.has(key)) store.items.delete(key);
  }
  const available = max === undefined ? store.container : Math.max(0, max - (store.inset ?? 0));
  const visible = overflowVisibleCount(keys.map(key => store.items.get(key)), available, gap,
    renderOverflow ? store.more ?? 0 : 0);
  const hidden = items.slice(visible);
  const children: Child[] = items.map((item, index) => {
    const key = keys[index];
    const shown = index < visible;
    return jsx("view", {
      onSize: (size: SizeEvent) => { if (shown) store.items.set(key, main(size, true)); },
      style: shown ? { shrink: 0 } : { shrink: 0, display: "none" },
      children: renderItem(item, index),
    }, key);
  });
  if (renderOverflow && hidden.length > 0) {
    children.push(jsx("view", {
      onSize: (size: SizeEvent) => { store.more = main(size, true); },
      style: { shrink: 0 },
      children: renderOverflow(hidden),
    }, "\u0000overflow"));
  }
  const base: Style = { direction, align: row ? "center" : "stretch", overflow: "hidden", minWidth: 0, minHeight: 0, shrink: 1 };
  if (max !== undefined) base[row ? "maxWidth" : "maxHeight"] = max;
  return container(row ? "row" : "column", {
    ...props,
    id,
    gap,
    onSize: (size: SizeEvent) => {
      store.container = main(size, false);
      store.inset = main(size, true) - store.container;
      onSize?.(size);
    },
    style: style ? { ...base, ...style } : base,
    children,
  });
}
