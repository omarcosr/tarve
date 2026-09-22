import { jsx, type BaseProps, type Child, type VNode } from "./jsx-runtime";
import { Column, Row, Scroll } from "./components";

export interface VirtualListProps<T> extends BaseProps {
  items: readonly T[];
  itemHeight: number;
  height: number;
  offset: number;
  overscan?: number;
  keyForItem?: (item: T, index: number) => string | number;
  renderItem: (item: T, index: number) => Child;
  onScroll: (offset: number, max: number) => void;
}

/** Fixed-height rows; the caller keeps `offset` and updates it from `onScroll`. */
export function VirtualList<T>({
  items, itemHeight, height, offset, overscan = 2, keyForItem, renderItem, onScroll, style, ...props
}: VirtualListProps<T>): VNode {
  if (![itemHeight, height, offset, overscan].every(Number.isFinite)
    || itemHeight <= 0 || height <= 0 || offset < 0 || overscan < 0 || !Number.isInteger(overscan)) {
    throw new RangeError("VirtualList requires positive fixed heights, a nonnegative offset and integer overscan");
  }
  const total = items.length * itemHeight;
  const scroll = Math.min(offset, Math.max(0, total - height));
  const start = Math.max(0, Math.floor(scroll / itemHeight) - overscan);
  const end = Math.min(items.length, Math.ceil((scroll + height) / itemHeight) + overscan);
  const rows: VNode[] = [];
  for (let index = start; index < end; index++) {
    const item = items[index];
    rows.push(jsx(Row, {
      style: { width: "100%", height: itemHeight, shrink: 0 },
      children: renderItem(item, index),
    }, keyForItem?.(item, index) ?? index));
  }
  return jsx(Scroll, { ...props, onScroll, control: { role: "virtualList", value: scroll }, style: { ...style, height, shrink: 0 },
    children: jsx(Column, { style: { width: "100%" }, children: [
      start > 0 ? jsx(Row, { style: { height: start * itemHeight, shrink: 0 } }, "before") : null,
      ...rows,
      end < items.length ? jsx(Row, { style: { height: (items.length - end) * itemHeight, shrink: 0 } }, "after") : null,
    ] }),
  });
}
