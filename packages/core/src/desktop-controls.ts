import type { Style } from "../../protocol/src/index";
import { jsx, type BaseProps, type Child, type VNode } from "./jsx-runtime";
import { Icon, Pressable, Row, Text, View, Column, type IconName } from "./components";
import { VirtualList } from "./virtual-list";
import { theme } from "./theme";

const c = theme.colors;

export interface TreeNode<T = unknown> {
  id: string;
  label: string;
  children?: readonly TreeNode<T>[];
  disabled?: boolean;
  icon?: IconName;
  data?: T;
}

export interface TreeViewProps<T = unknown> extends BaseProps {
  nodes: readonly TreeNode<T>[];
  expandedIds?: readonly string[];
  selectedId?: string;
  indent?: number;
  rowHeight?: number;
  onExpandedChange?: (ids: string[]) => void;
  onSelectedChange?: (id: string, node: TreeNode<T>) => void;
  onActivate?: (id: string, node: TreeNode<T>) => void;
}

interface FlatTreeNode<T> {
  node: TreeNode<T>;
  depth: number;
}

function validateTree<T>(nodes: readonly TreeNode<T>[]): void {
  const ids = new Set<string>();
  const visit = (items: readonly TreeNode<T>[]) => {
    for (const item of items) {
      if (!item.id) throw new TypeError("TreeView node ids must not be empty");
      if (ids.has(item.id)) throw new TypeError(`TreeView node ids must be unique: ${item.id}`);
      ids.add(item.id);
      if (item.children) visit(item.children);
    }
  };
  visit(nodes);
}

function treeHasId<T>(nodes: readonly TreeNode<T>[], id: string): boolean {
  return nodes.some(node => node.id === id || (node.children ? treeHasId(node.children, id) : false));
}

function flattenTree<T>(nodes: readonly TreeNode<T>[], expanded: ReadonlySet<string>, depth = 0, out: FlatTreeNode<T>[] = []): FlatTreeNode<T>[] {
  for (const node of nodes) {
    out.push({ node, depth });
    if (node.children?.length && expanded.has(node.id)) flattenTree(node.children, expanded, depth + 1, out);
  }
  return out;
}

/** Controlled desktop tree with roving keyboard focus and explicit expansion/selection state. */
export function TreeView<T>({
  nodes,
  expandedIds = [],
  selectedId,
  indent = 18,
  rowHeight = 32,
  onExpandedChange,
  onSelectedChange,
  onActivate,
  style,
  id,
  ...props
}: TreeViewProps<T>): VNode {
  validateTree(nodes);
  if (!Number.isFinite(indent) || indent < 0 || !Number.isFinite(rowHeight) || rowHeight <= 0) {
    throw new RangeError("TreeView indent must be nonnegative and rowHeight must be greater than zero");
  }
  const expanded = new Set(expandedIds);
  if (expanded.size !== expandedIds.length) throw new TypeError("TreeView expandedIds must be unique");
  const visible = flattenTree(nodes, expanded);
  if (selectedId !== undefined && !treeHasId(nodes, selectedId)) throw new RangeError("TreeView selectedId must reference a node");
  const setExpanded = (nodeId: string, next: boolean) => {
    const values = new Set(expanded);
    if (next) values.add(nodeId); else values.delete(nodeId);
    onExpandedChange?.([...values]);
  };
  return jsx(Column, {
    ...props,
    ...(id ? { id } : {}),
    control: { role: "tree", orientation: "vertical", label: "Tree" },
    gap: 1,
    style: { width: "100%", ...style },
    children: visible.map(({ node, depth }) => {
      const hasChildren = !!node.children?.length;
      const isExpanded = hasChildren && expanded.has(node.id);
      const selected = node.id === selectedId;
      const rowId = id ? `${id}-node-${node.id}` : undefined;
      return jsx(Pressable, {
        ...(rowId ? { id: rowId } : {}),
        disabled: node.disabled,
        control: { role: "treeitem", label: node.label, selected, ...(hasChildren ? { expanded: isExpanded } : {}) },
        onClick: () => {
          onSelectedChange?.(node.id, node);
          onActivate?.(node.id, node);
        },
        onKeyDown: (key: string) => {
          if (!hasChildren) return;
          if (key === "ArrowRight" && !isExpanded) setExpanded(node.id, true);
          if (key === "ArrowLeft" && isExpanded) setExpanded(node.id, false);
        },
        style: {
          height: rowHeight,
          minHeight: rowHeight,
          shrink: 0,
          direction: "row",
          align: "center",
          gap: 6,
          padding: { left: 6 + depth * indent, right: 8 },
          radius: theme.radius.sm,
          background: selected ? c.muted : "#00000000",
          hover: { background: c.muted },
          disabled: { foreground: c.disabledForeground },
        },
        children: [
          hasChildren
            ? jsx(Pressable, {
                ...(rowId ? { id: `${rowId}-toggle` } : {}),
                focusable: false,
                control: { role: "button", label: `${isExpanded ? "Collapse" : "Expand"} ${node.label}` },
                onClick: () => setExpanded(node.id, !isExpanded),
                style: { width: 20, height: 20, align: "center", justify: "center", background: "#00000000" },
                children: jsx(Icon, { name: isExpanded ? "chevron-down" : "chevron-right", size: 13 }),
              })
            : jsx(View, { style: { width: 20, height: 20, shrink: 0 } }),
          node.icon ? jsx(Icon, { name: node.icon, size: 15, color: node.disabled ? c.disabledForeground : c.foreground }) : null,
          jsx(Text, { size: 13, color: node.disabled ? c.disabledForeground : c.foreground, children: node.label }),
        ],
      }, node.id);
    }),
  });
}

export type DataGridKey = string | number;
export type DataGridSortDirection = "asc" | "desc";
export interface DataGridSort {
  column: string;
  direction: DataGridSortDirection;
}
export interface DataGridColumn<T> {
  key: string;
  header: Child;
  value?: (row: T, index: number) => unknown;
  render?: (row: T, index: number) => Child;
  width?: Style["width"];
  align?: Style["align"];
  sortable?: boolean;
  searchable?: boolean;
  compare?: (a: T, b: T) => number;
}
export interface DataGridProps<T> extends BaseProps {
  columns: readonly DataGridColumn<T>[];
  rows: readonly T[];
  rowKey: (row: T, index: number) => DataGridKey;
  height?: number;
  rowHeight?: number;
  offset?: number;
  overscan?: number;
  sort?: DataGridSort;
  sortMode?: "local" | "manual";
  filter?: string;
  filterMode?: "local" | "manual";
  selectionMode?: "none" | "single" | "multiple";
  selectedKeys?: readonly DataGridKey[];
  empty?: Child;
  onSortChange?: (sort: DataGridSort | undefined) => void;
  onSelectionChange?: (keys: DataGridKey[]) => void;
  onRowActivate?: (row: T, index: number) => void;
  onScroll?: (offset: number, max: number) => void;
}

interface GridEntry<T> {
  row: T;
  sourceIndex: number;
  key: DataGridKey;
}

function gridValue<T>(column: DataGridColumn<T>, row: T, index: number): unknown {
  if (column.value) return column.value(row, index);
  if (row && typeof row === "object" && column.key in (row as Record<string, unknown>)) {
    return (row as Record<string, unknown>)[column.key];
  }
  return undefined;
}

function gridCell<T>(column: DataGridColumn<T>, entry: GridEntry<T>): Child {
  const value = column.render?.(entry.row, entry.sourceIndex) ?? gridValue(column, entry.row, entry.sourceIndex);
  if (value == null) return jsx(Text, { size: 13, children: "" });
  if (typeof value === "string" || typeof value === "number") return jsx(Text, { size: 13, children: value });
  if (typeof value === "boolean") return jsx(Text, { size: 13, children: String(value) });
  if (typeof value === "object" && "type" in (value as object)) return value as Child;
  return jsx(Text, { size: 13, children: String(value) });
}

function compareGridValues(a: unknown, b: unknown): number {
  if (a == null && b == null) return 0;
  if (a == null) return -1;
  if (b == null) return 1;
  if (typeof a === "number" && typeof b === "number") return a - b;
  if (typeof a === "boolean" && typeof b === "boolean") return Number(a) - Number(b);
  return String(a).localeCompare(String(b), undefined, { numeric: true, sensitivity: "base" });
}

/** Virtualized controlled data grid with local/manual sort, filtering and row selection. */
export function DataGrid<T>({
  columns,
  rows,
  rowKey,
  height = 360,
  rowHeight = 40,
  offset = 0,
  overscan = 3,
  sort,
  sortMode = "local",
  filter = "",
  filterMode = "local",
  selectionMode = "none",
  selectedKeys = [],
  empty = "No results.",
  onSortChange,
  onSelectionChange,
  onRowActivate,
  onScroll = () => {},
  style,
  id,
  ...props
}: DataGridProps<T>): VNode {
  if (columns.length === 0) throw new RangeError("DataGrid requires at least one column");
  if (new Set(columns.map(column => column.key)).size !== columns.length) throw new TypeError("DataGrid column keys must be unique");
  if (![height, rowHeight, offset, overscan].every(Number.isFinite) || height <= 0 || rowHeight <= 0 || offset < 0 || overscan < 0 || !Number.isInteger(overscan)) {
    throw new RangeError("DataGrid requires positive height/rowHeight, nonnegative offset and integer overscan");
  }
  if (sort && !columns.some(column => column.key === sort.column && column.sortable)) {
    throw new RangeError("DataGrid sort must reference a sortable column");
  }
  const selectedTokens = new Set(selectedKeys.map(key => `${typeof key}:${String(key)}`));
  if (selectedTokens.size !== selectedKeys.length) throw new TypeError("DataGrid selectedKeys must be unique");
  const entries: GridEntry<T>[] = rows.map((row, sourceIndex) => ({ row, sourceIndex, key: rowKey(row, sourceIndex) }));
  const rowTokens = new Set<string>();
  for (const entry of entries) {
    const token = `${typeof entry.key}:${String(entry.key)}`;
    if (rowTokens.has(token)) throw new TypeError(`DataGrid row keys must be unique: ${String(entry.key)}`);
    rowTokens.add(token);
  }
  let visible = entries;
  const needle = filter.trim().toLocaleLowerCase();
  if (needle && filterMode === "local") {
    const searchable = columns.filter(column => column.searchable !== false);
    visible = visible.filter(entry => searchable.some(column => String(gridValue(column, entry.row, entry.sourceIndex) ?? "").toLocaleLowerCase().includes(needle)));
  }
  if (sort && sortMode === "local") {
    const column = columns.find(candidate => candidate.key === sort.column)!;
    const direction = sort.direction === "asc" ? 1 : -1;
    visible = [...visible].sort((a, b) => direction * (column.compare?.(a.row, b.row)
      ?? compareGridValues(gridValue(column, a.row, a.sourceIndex), gridValue(column, b.row, b.sourceIndex))));
  }
  const toggleSelection = (entry: GridEntry<T>) => {
    if (selectionMode === "none") return;
    const token = `${typeof entry.key}:${String(entry.key)}`;
    let next: DataGridKey[];
    if (selectionMode === "single") next = selectedTokens.has(token) ? [] : [entry.key];
    else next = selectedTokens.has(token)
      ? selectedKeys.filter(key => `${typeof key}:${String(key)}` !== token)
      : [...selectedKeys, entry.key];
    onSelectionChange?.(next);
  };
  const header = jsx(Row, {
    ...(id ? { id: `${id}-header` } : {}),
    style: { width: "100%", height: 38, shrink: 0, borderWidth: { bottom: 1 }, borderColor: c.border, background: c.card },
    children: columns.map(column => {
      const active = sort?.column === column.key;
      const content: Child = [
        typeof column.header === "string" || typeof column.header === "number"
          ? jsx(Text, { size: 12, weight: 600, color: c.mutedForeground, children: column.header })
          : column.header,
        active ? jsx(Text, { size: 11, color: c.mutedForeground, children: sort!.direction === "asc" ? "↑" : "↓" }) : null,
      ];
      const common = { style: { width: column.width, flex: column.width === undefined ? 1 : undefined, minWidth: 0, height: "100%", padding: { left: 10, right: 10 }, direction: "row" as const, align: column.align ?? "start" as const, gap: 5 } };
      if (!column.sortable) return jsx(Row, { ...common, children: content }, column.key);
      return jsx(Pressable, {
        ...(id ? { id: `${id}-sort-${column.key}` } : {}),
        control: {
          role: "button",
          label: `Sort by ${typeof column.header === "string" ? column.header : column.key}`,
          ...(active ? { sortDirection: sort!.direction === "asc" ? "ascending" as const : "descending" as const } : {}),
        },
        onClick: () => onSortChange?.(!active ? { column: column.key, direction: "asc" }
          : sort!.direction === "asc" ? { column: column.key, direction: "desc" } : undefined),
        ...common,
        style: {
          ...common.style,
          background: "#00000000",
          hover: { background: c.muted },
          focus: { outlineWidth: 0, outlineStyle: "none" },
        },
        children: content,
      }, column.key);
    }),
  });
  const bodyHeight = Math.max(rowHeight, height - 38);
  const body = visible.length === 0
    ? jsx(View, { ...(id ? { id: `${id}-empty` } : {}), style: { height: bodyHeight, align: "center", justify: "center" },
        children: typeof empty === "string" || typeof empty === "number" ? jsx(Text, { size: 13, color: c.mutedForeground, children: empty }) : empty })
    : jsx(VirtualList<GridEntry<T>>, {
        ...(id ? { id: `${id}-body` } : {}),
        items: visible,
        itemHeight: rowHeight,
        height: bodyHeight,
        offset,
        overscan,
        keyForItem: (entry: GridEntry<T>) => entry.key,
        onScroll,
        renderItem: (entry: GridEntry<T>) => {
          const token = `${typeof entry.key}:${String(entry.key)}`;
          const selected = selectedTokens.has(token);
          return jsx(Pressable, {
            ...(id ? { id: `${id}-row-${String(entry.key)}` } : {}),
            control: { role: "row", label: `Row ${entry.sourceIndex + 1}`, selected },
            onClick: () => { toggleSelection(entry); onRowActivate?.(entry.row, entry.sourceIndex); },
            style: { width: "100%", height: rowHeight, shrink: 0, direction: "row", background: selected ? c.muted : "#00000000", hover: { background: c.muted }, borderWidth: { bottom: 1 }, borderColor: c.border },
            children: columns.map(column => jsx(View, {
              style: { width: column.width, flex: column.width === undefined ? 1 : undefined, minWidth: 0, height: "100%", padding: { left: 10, right: 10 }, align: column.align ?? "start", justify: "center" },
              children: gridCell(column, entry),
            }, column.key)),
          });
        },
      });
  return jsx(Column, {
    ...props,
    ...(id ? { id } : {}),
    control: { role: "grid", orientation: "vertical", label: "Data grid" },
    style: { width: "100%", height, borderWidth: 1, borderColor: c.border, radius: theme.radius.md, ...style },
    children: [header, body],
  });
}
