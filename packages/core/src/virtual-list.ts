import { jsx, type BaseProps, type Child, type VNode } from "./jsx-runtime";
import type { VirtualListMeasurement } from "../../protocol/src/index";
import { Column, Row, Scroll } from "./components";
import { currentRenderEpoch, currentRenderScope } from "./render-scope";

export interface VirtualListProps<T> extends BaseProps {
  items: readonly T[];
  itemHeight: number;
  /**
   * Viewport height in px. Omit it (with an `id`) to fill the parent like
   * `flex: 1`: the list follows its real laid-out height, window resizes included.
   */
  height?: number;
  offset: number;
  overscan?: number;
  keyForItem?: (item: T, index: number) => string | number;
  renderItem: (item: T, index: number) => Child;
  onScroll: (offset: number, max: number) => void;
}

export interface VariableVirtualListProps<T> extends Omit<VirtualListProps<T>, "itemHeight" | "keyForItem"> {
  /** Stable list id is required so measured heights survive rerenders. */
  id: string;
  itemHeight?: never;
  estimatedItemHeight: number;
  keyForItem: (item: T, index: number) => string | number;
  alignment?: "top" | "bottom";
  followTail?: boolean;
}

export interface WindowedVirtualListProps<T> extends Omit<VariableVirtualListProps<T>, "overscan"> {
  /** Total logical row count; `items` contains only the mounted window. */
  itemCount: number;
  /** Logical index represented by `items[0]`. */
  windowStart: number;
  overscan?: never;
}

interface VariableListState {
  heights: Map<string, number>;
  effectiveOffset: number;
  lastExternalOffset?: number;
  anchorKey?: string;
  anchorInset: number;
  anchorEdge: "top" | "bottom";
  followingTail: boolean;
  lastFollowTail: boolean;
  scrollRequest?: { generation: number; index: number; offset: number };
  focusedKey?: string;
  retainedRow?: { key: string; index: number; vnode: VNode };
  logicalIndexByKey: Map<string, number>;
  keyByLogicalIndex: Map<number, string>;
  lastSeenEpoch: number;
}

interface VariableListStore {
  states: Map<string, VariableListState>;
  nextScrollGeneration: number;
  lastSweepEpoch: number;
}

const VARIABLE_MEASUREMENT_LIMIT = 100_000;
const PARKED_ROW_TOP = -1_000_000;
const variableListStores = new WeakMap<object, VariableListStore>();

function variableStore(): VariableListStore {
  const scope = currentRenderScope();
  const existing = variableListStores.get(scope);
  if (existing) return existing;
  const store: VariableListStore = { states: new Map(), nextScrollGeneration: 0, lastSweepEpoch: 0 };
  variableListStores.set(scope, store);
  return store;
}

function variableState(store: VariableListStore, id: string): VariableListState {
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

  const state: VariableListState = {
    heights: new Map(),
    effectiveOffset: 0,
    anchorInset: 0,
    anchorEdge: "top",
    followingTail: false,
    lastFollowTail: false,
    logicalIndexByKey: new Map(),
    keyByLogicalIndex: new Map(),
    lastSeenEpoch: epoch,
  };
  store.states.set(id, state);
  return state;
}

function itemToken(key: string | number): string {
  return typeof key === "number" ? `n:${key}` : `s:${key}`;
}

function forgetHeight(state: VariableListState, key: string): void {
  state.heights.delete(key);
  const logicalIndex = state.logicalIndexByKey.get(key);
  state.logicalIndexByKey.delete(key);
  if (logicalIndex !== undefined && state.keyByLogicalIndex.get(logicalIndex) === key) {
    state.keyByLogicalIndex.delete(logicalIndex);
  }
}

function setLogicalIndex(state: VariableListState, key: string, logicalIndex: number): void {
  const previousKey = state.keyByLogicalIndex.get(logicalIndex);
  if (previousKey !== undefined && previousKey !== key) {
    state.logicalIndexByKey.delete(previousKey);
    state.keyByLogicalIndex.delete(logicalIndex);
  }
  const previousIndex = state.logicalIndexByKey.get(key);
  if (previousIndex !== undefined && previousIndex !== logicalIndex
    && state.keyByLogicalIndex.get(previousIndex) === key) {
    state.keyByLogicalIndex.delete(previousIndex);
  }
  state.logicalIndexByKey.set(key, logicalIndex);
  state.keyByLogicalIndex.set(logicalIndex, key);
}

function observeLogicalKey(state: VariableListState, key: string, logicalIndex: number): void {
  const previousKey = state.keyByLogicalIndex.get(logicalIndex);
  if (previousKey !== undefined && previousKey !== key) {
    state.logicalIndexByKey.delete(previousKey);
    state.keyByLogicalIndex.delete(logicalIndex);
  }
  if (state.heights.has(key)) setLogicalIndex(state, key, logicalIndex);
}

function rememberHeight(state: VariableListState, key: string, height: number, logicalIndex?: number): void {
  if (state.heights.has(key)) state.heights.delete(key);
  else if (state.heights.size >= VARIABLE_MEASUREMENT_LIMIT) {
    const oldest = state.heights.keys().next().value as string | undefined;
    if (oldest !== undefined) forgetHeight(state, oldest);
  }
  state.heights.set(key, height);
  if (logicalIndex !== undefined) setLogicalIndex(state, key, logicalIndex);
}

function parkedRow(row: VNode): VNode {
  return {
    ...row,
    props: {
      ...row.props,
      style: {
        ...row.props.style,
        position: "absolute",
        top: PARKED_ROW_TOP,
        left: 0,
        width: "100%",
        shrink: 0,
      },
    },
  };
}

function upperBoundPrefix(prefix: readonly number[], offset: number): number {
  let low = 0;
  let high = prefix.length - 1;
  while (low < high) {
    const mid = Math.floor((low + high) / 2);
    if (prefix[mid + 1]! <= offset) low = mid + 1;
    else high = mid;
  }
  return Math.min(low, prefix.length - 2);
}

/** Height assumed for a filling list until its first layout reports the real one. */
const FILL_ESTIMATE = 800;
const filledHeights = new WeakMap<object, Map<string, number>>();
/** True while rendering a list that fills its parent instead of a fixed height. */
let filling = false;

function viewportStyle(style: BaseProps["style"], height: number): BaseProps["style"] {
  return filling ? { flex: 1, minHeight: 0, ...style } : { ...style, height, shrink: 0 };
}

function fixedVirtualList<T>({
  items, itemHeight, height = FILL_ESTIMATE, offset, overscan = 2, keyForItem, renderItem, onScroll, style, ...props
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
  return jsx(Scroll, { ...props, onScroll, control: { role: "virtualList", value: scroll }, style: viewportStyle(style, height),
    children: jsx(Column, { style: { width: "100%" }, children: [
      start > 0 ? jsx(Row, { style: { height: start * itemHeight, shrink: 0 } }, "before") : null,
      ...rows,
      end < items.length ? jsx(Row, { style: { height: (items.length - end) * itemHeight, shrink: 0 } }, "after") : null,
    ] }),
  });
}

function variableVirtualList<T>({
  id, items, estimatedItemHeight, height = FILL_ESTIMATE, offset, overscan = 2, keyForItem, renderItem, onScroll,
  alignment = "top", followTail = false, style, ...props
}: VariableVirtualListProps<T>): VNode {
  if (![estimatedItemHeight, height, offset, overscan].every(Number.isFinite)
    || estimatedItemHeight <= 0 || height <= 0 || offset < 0 || overscan < 0 || !Number.isInteger(overscan)) {
    throw new RangeError("Variable VirtualList requires a positive estimatedItemHeight/height, nonnegative offset and integer overscan");
  }
  if (!id) throw new TypeError("Variable VirtualList requires a stable id");
  if (alignment !== "top" && alignment !== "bottom") throw new TypeError(`Unsupported VirtualList alignment: ${alignment}`);

  const keys = items.map((item, index) => itemToken(keyForItem(item, index)));
  const uniqueKeys = new Set(keys);
  if (uniqueKeys.size !== keys.length) throw new Error("Variable VirtualList requires unique keyForItem values");

  const store = variableStore();
  const state = variableState(store, id);
  for (const key of state.heights.keys()) if (!uniqueKeys.has(key)) forgetHeight(state, key);
  if (state.focusedKey && !uniqueKeys.has(state.focusedKey)) {
    state.focusedKey = undefined;
    state.retainedRow = undefined;
  }

  const prefix = new Array<number>(items.length + 1);
  prefix[0] = 0;
  for (let index = 0; index < items.length; index++) {
    prefix[index + 1] = prefix[index]! + (state.heights.get(keys[index]!) ?? estimatedItemHeight);
  }
  const total = prefix[items.length]!;
  const max = Math.max(0, total - height);

  const firstRender = state.lastExternalOffset === undefined;
  const externalChanged = firstRender || Math.abs(offset - state.lastExternalOffset!) > 1e-6;
  if (followTail && !state.lastFollowTail) state.followingTail = true;
  if (!followTail) state.followingTail = false;
  state.lastFollowTail = followTail;
  const requestedIndex = state.scrollRequest && items.length > 0
    ? Math.min(state.scrollRequest.index, items.length - 1)
    : undefined;
  const requestedOffset = requestedIndex !== undefined
    ? Math.max(0, Math.min(prefix[requestedIndex]! + state.scrollRequest!.offset, max))
    : undefined;
  if (requestedOffset !== undefined) {
    state.effectiveOffset = requestedOffset;
  } else if (followTail && state.followingTail) {
    state.effectiveOffset = max;
  } else if (firstRender && alignment === "bottom") {
    state.effectiveOffset = max;
  } else if (externalChanged) {
    state.effectiveOffset = offset;
  } else if (state.anchorKey !== undefined) {
    const anchorIndex = keys.indexOf(state.anchorKey);
    if (anchorIndex >= 0) {
      state.effectiveOffset = state.anchorEdge === "bottom"
        ? prefix[anchorIndex + 1]! + state.anchorInset - height
        : prefix[anchorIndex]! + state.anchorInset;
    }
  }
  const scroll = Math.max(0, Math.min(state.effectiveOffset, max));
  state.effectiveOffset = scroll;

  const firstVisible = items.length === 0 ? 0 : upperBoundPrefix(prefix, scroll);
  let lastVisible = firstVisible;
  const viewportEnd = scroll + height;
  while (lastVisible < items.length && prefix[lastVisible]! < viewportEnd) lastVisible++;
  const start = Math.max(0, firstVisible - overscan);
  const end = Math.min(items.length, Math.max(firstVisible + 1, lastVisible) + overscan);

  if (items.length > 0) {
    const anchorIndex = alignment === "bottom"
      ? Math.max(firstVisible, lastVisible - 1)
      : firstVisible;
    state.anchorKey = keys[anchorIndex];
    state.anchorInset = alignment === "bottom"
      ? scroll + height - prefix[anchorIndex + 1]!
      : scroll - prefix[anchorIndex]!;
    state.anchorEdge = alignment;
  } else {
    state.anchorKey = undefined;
    state.anchorInset = 0;
    state.anchorEdge = alignment;
  }
  state.lastExternalOffset = offset;

  const rows: VNode[] = [];
  const rowByKey = new Map<string, VNode>();
  for (let index = start; index < end; index++) {
    const item = items[index]!;
    const row = jsx(Row, {
      style: { width: "100%", shrink: 0 },
      children: renderItem(item, index),
    }, keyForItem(item, index));
    rows.push(row);
    rowByKey.set(keys[index]!, row);
  }
  if (state.focusedKey && rowByKey.has(state.focusedKey)) {
    state.retainedRow = {
      key: state.focusedKey,
      index: keys.indexOf(state.focusedKey),
      vnode: rowByKey.get(state.focusedKey)!,
    };
  }
  const retainedIndex = state.focusedKey === undefined ? -1 : keys.indexOf(state.focusedKey);
  const retainedKey = retainedIndex >= 0 && (retainedIndex < start || retainedIndex >= end)
    ? state.focusedKey
    : undefined;
  const retained = retainedKey === undefined ? undefined : parkedRow(jsx(Row, {
    style: { width: "100%", shrink: 0 },
    children: renderItem(items[retainedIndex]!, retainedIndex),
  }, keyForItem(items[retainedIndex]!, retainedIndex)));

  const onVariableScroll = (next: number, nextMax: number) => {
    state.effectiveOffset = next;
    state.lastExternalOffset = offset;
    state.followingTail = followTail && Math.abs(next - nextMax) <= 0.5;
    state.scrollRequest = undefined;
    onScroll(next, nextMax);
  };
  const onVirtualListLayout = (measurements: VirtualListMeasurement[]) => {
    for (const measurement of measurements) {
      if (!uniqueKeys.has(measurement.key) || !Number.isFinite(measurement.height) || measurement.height <= 0) continue;
      rememberHeight(state, measurement.key, measurement.height);
    }
  };
  const onVirtualListScrollToItem = (index: number, itemOffset: number) => {
    if (!Number.isInteger(index) || index < 0 || !Number.isFinite(itemOffset)) return;
    state.followingTail = false;
    state.scrollRequest = {
      generation: ++store.nextScrollGeneration,
      index,
      offset: itemOffset,
    };
  };
  const onVirtualListFocus = (key: string | null) => {
    state.focusedKey = key ?? undefined;
    if (key === null) {
      state.retainedRow = undefined;
      return;
    }
    const row = rowByKey.get(key);
    if (row) state.retainedRow = { key, index: keys.indexOf(key), vnode: row };
  };

  return jsx(Scroll, {
    ...props,
    id,
    onScroll: onVariableScroll,
    onVirtualListLayout,
    onVirtualListScrollToItem,
    onVirtualListFocus,
    control: { role: "virtualList", value: scroll },
    virtualList: {
      estimatedItemHeight,
      itemCount: items.length,
      windowStart: start,
      windowEnd: end,
      renderedKeys: keys.slice(start, end),
      ...(retainedKey === undefined ? {} : { retainedKey }),
      alignment,
      followTail,
      ...(requestedOffset !== undefined && state.scrollRequest
        ? { scrollRequest: { generation: state.scrollRequest.generation, offset: requestedOffset } }
        : {}),
    },
    style: viewportStyle(style, height),
    children: jsx(Column, { style: { width: "100%" }, children: [
      start > 0 ? jsx(Row, { style: { height: prefix[start], shrink: 0 } }, "before") : null,
      ...rows,
      end < items.length ? jsx(Row, { style: { height: total - prefix[end]!, shrink: 0 } }, "after") : null,
      retained ?? null,
    ] }),
  });
}

function windowedVariableVirtualList<T>({
  id, items, itemCount, windowStart, estimatedItemHeight, height = FILL_ESTIMATE, offset, keyForItem, renderItem, onScroll,
  alignment = "top", followTail = false, style, ...props
}: WindowedVirtualListProps<T>): VNode {
  if (![estimatedItemHeight, height, offset].every(Number.isFinite)
    || estimatedItemHeight <= 0 || height <= 0 || offset < 0) {
    throw new RangeError("Windowed VirtualList requires a positive estimatedItemHeight/height and nonnegative offset");
  }
  if (!id) throw new TypeError("Windowed VirtualList requires a stable id");
  if (!Number.isInteger(itemCount) || itemCount < 0 || !Number.isInteger(windowStart) || windowStart < 0
    || windowStart + items.length > itemCount) {
    throw new RangeError("Windowed VirtualList requires a valid itemCount/windowStart window");
  }
  if (alignment !== "top" && alignment !== "bottom") throw new TypeError(`Unsupported VirtualList alignment: ${alignment}`);

  const keys = items.map((item, localIndex) => itemToken(keyForItem(item, windowStart + localIndex)));
  if (new Set(keys).size !== keys.length) throw new Error("Windowed VirtualList requires unique keyForItem values");
  const keySet = new Set(keys);
  const store = variableStore();
  const state = variableState(store, id);
  for (const [key, logicalIndex] of [...state.logicalIndexByKey]) {
    if (logicalIndex >= itemCount) forgetHeight(state, key);
  }
  if (state.retainedRow && state.retainedRow.index >= itemCount) {
    if (state.focusedKey === state.retainedRow.key) state.focusedKey = undefined;
    state.retainedRow = undefined;
  }
  for (let localIndex = 0; localIndex < keys.length; localIndex++) {
    observeLogicalKey(state, keys[localIndex]!, windowStart + localIndex);
  }

  const localPrefix = new Array<number>(items.length + 1);
  localPrefix[0] = 0;
  for (let localIndex = 0; localIndex < items.length; localIndex++) {
    localPrefix[localIndex + 1] = localPrefix[localIndex]!
      + (state.heights.get(keys[localIndex]!) ?? estimatedItemHeight);
  }
  const windowEnd = windowStart + items.length;
  let beforeCorrection = 0;
  let afterCorrection = 0;
  for (const [key, logicalIndex] of state.logicalIndexByKey) {
    if (logicalIndex < 0 || logicalIndex >= itemCount) continue;
    const measured = state.heights.get(key);
    if (measured === undefined) continue;
    const correction = measured - estimatedItemHeight;
    if (logicalIndex < windowStart) beforeCorrection += correction;
    else if (logicalIndex >= windowEnd) afterCorrection += correction;
  }
  const before = windowStart * estimatedItemHeight + beforeCorrection;
  const after = (itemCount - windowEnd) * estimatedItemHeight + afterCorrection;
  const total = before + localPrefix[items.length]! + after;
  const max = Math.max(0, total - height);

  const firstRender = state.lastExternalOffset === undefined;
  const externalChanged = firstRender || Math.abs(offset - state.lastExternalOffset!) > 1e-6;
  if (followTail && !state.lastFollowTail) state.followingTail = true;
  if (!followTail) state.followingTail = false;
  state.lastFollowTail = followTail;

  let requestedOffset: number | undefined;
  if (state.scrollRequest && itemCount > 0) {
    const logicalIndex = Math.min(state.scrollRequest.index, itemCount - 1);
    let logicalTop = logicalIndex * estimatedItemHeight;
    for (const [key, measuredIndex] of state.logicalIndexByKey) {
      if (measuredIndex < 0 || measuredIndex >= logicalIndex || measuredIndex >= itemCount) continue;
      const measured = state.heights.get(key);
      if (measured !== undefined) logicalTop += measured - estimatedItemHeight;
    }
    requestedOffset = Math.max(0, Math.min(logicalTop + state.scrollRequest.offset, max));
    state.effectiveOffset = requestedOffset;
  } else if (followTail && state.followingTail) {
    state.effectiveOffset = max;
  } else if (firstRender && alignment === "bottom") {
    state.effectiveOffset = max;
  } else if (externalChanged) {
    state.effectiveOffset = offset;
  } else if (state.anchorKey !== undefined) {
    const localAnchor = keys.indexOf(state.anchorKey);
    if (localAnchor >= 0) {
      state.effectiveOffset = state.anchorEdge === "bottom"
        ? before + localPrefix[localAnchor + 1]! + state.anchorInset - height
        : before + localPrefix[localAnchor]! + state.anchorInset;
    }
  }
  const scroll = Math.max(0, Math.min(state.effectiveOffset, max));
  state.effectiveOffset = scroll;

  const windowTop = before;
  const windowBottom = before + localPrefix[items.length]!;
  if (items.length > 0 && scroll + height > windowTop && scroll < windowBottom) {
    const relativeScroll = Math.max(0, scroll - before);
    const firstVisible = upperBoundPrefix(localPrefix, relativeScroll);
    let lastVisible = firstVisible;
    const relativeEnd = scroll + height - before;
    while (lastVisible < items.length && localPrefix[lastVisible]! < relativeEnd) lastVisible++;
    const anchorIndex = alignment === "bottom"
      ? Math.max(firstVisible, lastVisible - 1)
      : firstVisible;
    state.anchorKey = keys[anchorIndex];
    state.anchorInset = alignment === "bottom"
      ? scroll + height - (before + localPrefix[anchorIndex + 1]!)
      : scroll - (before + localPrefix[anchorIndex]!);
    state.anchorEdge = alignment;
  } else {
    state.anchorKey = undefined;
    state.anchorInset = 0;
    state.anchorEdge = alignment;
  }
  state.lastExternalOffset = offset;

  const rowByKey = new Map<string, VNode>();
  const rows = items.map((item, localIndex) => {
    const logicalIndex = windowStart + localIndex;
    const row = jsx(Row, {
      style: { width: "100%", shrink: 0 },
      children: renderItem(item, logicalIndex),
    }, keyForItem(item, logicalIndex));
    rowByKey.set(keys[localIndex]!, row);
    return row;
  });
  if (state.focusedKey && rowByKey.has(state.focusedKey)) {
    state.retainedRow = {
      key: state.focusedKey,
      index: windowStart + keys.indexOf(state.focusedKey),
      vnode: rowByKey.get(state.focusedKey)!,
    };
  }
  const retainedKey = state.focusedKey
    && !keySet.has(state.focusedKey)
    && state.retainedRow?.key === state.focusedKey
    && state.retainedRow.index < itemCount
    ? state.focusedKey
    : undefined;
  const retained = retainedKey === undefined ? undefined : parkedRow(state.retainedRow!.vnode);
  const onVariableScroll = (next: number, nextMax: number) => {
    state.effectiveOffset = next;
    state.lastExternalOffset = offset;
    state.followingTail = followTail && Math.abs(next - nextMax) <= 0.5;
    state.scrollRequest = undefined;
    onScroll(next, nextMax);
  };
  const onVirtualListLayout = (measurements: VirtualListMeasurement[]) => {
    for (const measurement of measurements) {
      if (!keySet.has(measurement.key) || !Number.isFinite(measurement.height) || measurement.height <= 0) continue;
      const localIndex = keys.indexOf(measurement.key);
      if (localIndex < 0) continue;
      rememberHeight(state, measurement.key, measurement.height, windowStart + localIndex);
    }
  };
  const onVirtualListScrollToItem = (index: number, itemOffset: number) => {
    if (!Number.isInteger(index) || index < 0 || !Number.isFinite(itemOffset)) return;
    state.followingTail = false;
    state.scrollRequest = {
      generation: ++store.nextScrollGeneration,
      index,
      offset: itemOffset,
    };
  };
  const onVirtualListFocus = (key: string | null) => {
    state.focusedKey = key ?? undefined;
    if (key === null) {
      state.retainedRow = undefined;
      return;
    }
    const row = rowByKey.get(key);
    const localIndex = keys.indexOf(key);
    if (row && localIndex >= 0) {
      state.retainedRow = { key, index: windowStart + localIndex, vnode: row };
    }
  };

  return jsx(Scroll, {
    ...props,
    id,
    onScroll: onVariableScroll,
    onVirtualListLayout,
    onVirtualListScrollToItem,
    onVirtualListFocus,
    control: { role: "virtualList", value: scroll },
    virtualList: {
      estimatedItemHeight,
      itemCount,
      windowStart,
      windowEnd,
      renderedKeys: keys,
      ...(retainedKey === undefined ? {} : { retainedKey }),
      alignment,
      followTail,
      ...(requestedOffset !== undefined && state.scrollRequest
        ? { scrollRequest: { generation: state.scrollRequest.generation, offset: requestedOffset } }
        : {}),
    },
    style: viewportStyle(style, height),
    children: jsx(Column, { style: { width: "100%" }, children: [
      windowStart > 0 ? jsx(Row, { style: { height: before, shrink: 0 } }, "before") : null,
      ...rows,
      windowEnd < itemCount ? jsx(Row, { style: { height: after, shrink: 0 } }, "after") : null,
      retained ?? null,
    ] }),
  });
}

/** Fixed-height rows; the caller keeps `offset` and updates it from `onScroll`. */
export function VirtualList<T>(props: VirtualListProps<T>): VNode;
export function VirtualList<T>(props: VariableVirtualListProps<T>): VNode;
export function VirtualList<T>(props: WindowedVirtualListProps<T>): VNode;
export function VirtualList<T>(props: VirtualListProps<T> | VariableVirtualListProps<T> | WindowedVirtualListProps<T>): VNode {
  if (props.height === undefined) {
    if (!props.id) throw new TypeError("VirtualList without a height needs an id to remember its measured height");
    let heights = filledHeights.get(currentRenderScope());
    if (!heights) filledHeights.set(currentRenderScope(), heights = new Map());
    const id = props.id;
    const store = heights;
    const onSize = props.onSize;
    const measured = { ...props, height: store.get(id) ?? FILL_ESTIMATE, onSize: (size: { width: number; height: number }) => {
      if (size.height > 0) store.set(id, size.height);
      onSize?.(size);
    } };
    filling = true;
    try {
      return (VirtualList as (next: typeof props) => VNode)(measured as typeof props);
    } finally {
      filling = false;
    }
  }
  if ("itemCount" in props) return windowedVariableVirtualList(props as WindowedVirtualListProps<T>);
  return "estimatedItemHeight" in props
    ? variableVirtualList(props as VariableVirtualListProps<T>)
    : fixedVirtualList(props as VirtualListProps<T>);
}
