import { jsx, type BaseProps, type Child, type VNode } from "./jsx-runtime";
import { Column, Scroll, type ScrollProps } from "./components";

export interface ListProps<T> extends ScrollProps {
  items?: readonly T[];
  renderItem?: (item: T, index: number) => Child;
  keyForItem?: (item: T, index: number) => string | number;
  gap?: number;
}

/** A regular, non-virtual list. Every item stays mounted and can have any height. */
export function List<T>({ items, renderItem, keyForItem, gap = 0, children, ...props }: ListProps<T>): VNode {
  if (items && !renderItem) throw new TypeError("List with items requires renderItem");
  const content = items?.map((item, index) => jsx(Column, {
    style: { width: "100%", shrink: 0 }, children: renderItem!(item, index),
  }, keyForItem?.(item, index) ?? index)) ?? children;
  return jsx(Scroll, { ...props, children: jsx(Column, { gap, style: { width: "100%" }, children: content }) });
}
