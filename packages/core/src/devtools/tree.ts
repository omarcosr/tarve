import type { NativeNode } from "../protocol";
import type { ComponentFrame } from "./trace";

/** One item of the inspector tree: a function component, or a native node it compiled to. */
export interface InspectorNode {
  /** `c:<component key>` or `h:<native id>`: stable across renders. */
  key: string;
  kind: "component" | "host";
  /** Component name, or the native kind (`button`, `column`…). */
  name: string;
  /** The native id: the node's own, or a component's first rendered node. */
  id?: string;
  frame?: ComponentFrame;
  node?: NativeNode;
  children: InspectorNode[];
}

export interface TreeRow {
  key: string;
  depth: number;
  kind: InspectorNode["kind"];
  label: string;
  hasChildren: boolean;
  expanded: boolean;
  id?: string;
}

export interface Rect { x: number; y: number; width: number; height: number }

/** Ids the reconciler made up from the tree path (`root/children/0`), not given by the app. */
export const isGeneratedId = (id: string): boolean => id === "root" || id.includes("/");

/**
 * Joins the compiled native tree and the traced components into one tree, the way
 * React DevTools shows it: each component wraps the native nodes it returned. A
 * component returning a fragment wraps its sibling nodes once. `hidden` drops
 * nodes (the inspector's own overlay).
 */
export function buildInspectorTree(root: NativeNode, frames: readonly ComponentFrame[], hidden: (id: string) => boolean = () => false): InspectorNode {
  // Pre-order: outer components claim a node before the components they rendered.
  const owners = new Map<string, ComponentFrame[]>();
  const claim = (list: readonly ComponentFrame[]) => {
    for (const frame of list) {
      for (const id of frame.roots) {
        const chain = owners.get(id);
        if (chain) chain.push(frame); else owners.set(id, [frame]);
      }
      claim(frame.children);
    }
  };
  claim(frames);

  const host = (node: NativeNode): InspectorNode => ({
    key: `h:${node.id}`, kind: "host", name: node.kind, id: node.id, node,
    children: wrap(node.children.filter(child => !hidden(child.id))),
  });
  function wrap(nodes: NativeNode[], level = 0): InspectorNode[] {
    const out: InspectorNode[] = [];
    for (let index = 0; index < nodes.length;) {
      const frame = owners.get(nodes[index]!.id)?.[level];
      if (!frame) { out.push(host(nodes[index]!)); index++; continue; }
      let end = index + 1;
      while (end < nodes.length && owners.get(nodes[end]!.id)?.[level] === frame) end++;
      const group = nodes.slice(index, end);
      out.push({ key: `c:${frame.key}`, kind: "component", name: frame.name, id: group[0]!.id, frame, children: wrap(group, level + 1) });
      index = end;
    }
    return out;
  }
  const top = wrap([root]);
  return top.length === 1 ? top[0]! : { key: "c:", kind: "component", name: "App", id: root.id, children: top };
}

/** Index of every node by key, with its parent key. */
export function indexTree(root: InspectorNode): Map<string, { node: InspectorNode; parent?: string; depth: number }> {
  const index = new Map<string, { node: InspectorNode; parent?: string; depth: number }>();
  const walk = (node: InspectorNode, parent: string | undefined, depth: number) => {
    index.set(node.key, { node, ...(parent !== undefined ? { parent } : {}), depth });
    for (const child of node.children) walk(child, node.key, depth + 1);
  };
  walk(root, undefined, 0);
  return index;
}

/** The keys to expand to show `key`, outermost first (not including `key`); undefined when it is not in the tree. */
export function ancestorKeys(index: ReturnType<typeof indexTree>, key: string): string[] | undefined {
  let entry = index.get(key);
  if (!entry) return undefined;
  const out: string[] = [];
  while (entry.parent !== undefined) {
    out.unshift(entry.parent);
    entry = index.get(entry.parent)!;
  }
  return out;
}

/** Keys of every node shallower than `depth`: the tree as it first opens. */
export function expandToDepth(root: InspectorNode, depth: number): Set<string> {
  const out = new Set<string>();
  const walk = (node: InspectorNode, level: number) => {
    if (level >= depth || !node.children.length) return;
    out.add(node.key);
    for (const child of node.children) walk(child, level + 1);
  };
  walk(root, 0);
  return out;
}

/** A short label: the component name, or the native kind with its app id and text. */
export function nodeLabel(node: InspectorNode): string {
  if (node.kind === "component") return node.name;
  const native = node.node!;
  let label = native.kind;
  if (!isGeneratedId(native.id)) label += ` #${native.id}`;
  const text = native.text ?? (typeof native.value === "string" ? native.value : undefined);
  if (text) label += ` "${truncate(text.replace(/\s+/g, " "), 32)}"`;
  return label;
}

/** The visible rows of the tree, depth first, at most `limit`; `truncated` counts the rest. */
export function flattenTree(root: InspectorNode, expanded: ReadonlySet<string>, limit = Infinity): { rows: TreeRow[]; truncated: number } {
  const rows: TreeRow[] = [];
  let truncated = 0;
  const walk = (node: InspectorNode, depth: number) => {
    const open = expanded.has(node.key);
    if (rows.length < limit) {
      rows.push({ key: node.key, depth, kind: node.kind, label: nodeLabel(node), hasChildren: node.children.length > 0, expanded: open, ...(node.id !== undefined ? { id: node.id } : {}) });
    } else truncated++;
    if (open) for (const child of node.children) walk(child, depth + 1);
  };
  walk(root, 0);
  return { rows, truncated };
}

/** Row navigation: the key `delta` visible rows away from `key` (arrow keys), clamped to the list. */
export function stepSelection(rows: readonly TreeRow[], key: string | undefined, delta: number): string | undefined {
  if (!rows.length) return undefined;
  const at = key === undefined ? -1 : rows.findIndex(row => row.key === key);
  if (at < 0) return rows[delta < 0 ? rows.length - 1 : 0]!.key;
  return rows[Math.max(0, Math.min(rows.length - 1, at + delta))]!.key;
}

/** The innermost native node under (x, y) in window coordinates, painting order respected. */
export function hitTest(root: NativeNode, boxes: ReadonlyMap<string, Rect>, x: number, y: number, skip: (id: string) => boolean = () => false): string | undefined {
  const inside = (box: Rect | undefined) => !!box && x >= box.x && y >= box.y && x < box.x + box.width && y < box.y + box.height;
  const visit = (node: NativeNode): string | undefined => {
    if (skip(node.id)) return undefined;
    const box = boxes.get(node.id);
    const hit = inside(box);
    // Scroll containers and overflow:hidden clip their children to their box.
    if (!hit && box && (node.kind === "scroll" || node.style.overflow === "hidden" || node.style.overflow === "clip")) return undefined;
    // Later siblings paint on top; portals and higher zIndex above them.
    const order = node.children.map((child, index) => ({ child, index, layer: (child.portal ? 1e9 : 0) + (child.style.zIndex ?? 0) }));
    order.sort((a, b) => b.layer - a.layer || b.index - a.index);
    for (const { child } of order) {
      const found = visit(child);
      if (found !== undefined) return found;
    }
    return hit ? node.id : undefined;
  };
  return visit(root);
}

export function truncate(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

/** A readable one-line form of a prop or style value; functions, nodes and cycles stay short. */
export function describeValue(value: unknown, depth = 2, seen = new Set<object>()): string {
  if (value === null) return "null";
  switch (typeof value) {
    case "string": return JSON.stringify(truncate(value, 120));
    case "number": case "boolean": case "undefined": return String(value);
    case "bigint": return `${value}n`;
    case "symbol": return value.toString();
    case "function": return `ƒ ${value.name || "anonymous"}()`;
  }
  const object = value as Record<string, unknown>;
  if (seen.has(object)) return "[circular]";
  if ("type" in object && "props" in object && (typeof object.type === "string" || typeof object.type === "function")) {
    const type = typeof object.type === "string" ? object.type : (object.type as { name?: string }).name || "Component";
    return `<${type} />`;
  }
  if (depth <= 0) return Array.isArray(object) ? `Array(${object.length})` : "{…}";
  seen.add(object);
  try {
    if (Array.isArray(object)) {
      const items = object.slice(0, 8).map(item => describeValue(item, depth - 1, seen));
      return `[${items.join(", ")}${object.length > 8 ? `, …${object.length - 8} more` : ""}]`;
    }
    const keys = Object.keys(object);
    const items = keys.slice(0, 12).map(key => `${key}: ${describeValue(object[key], depth - 1, seen)}`);
    return `{ ${items.join(", ")}${keys.length > 12 ? `, …${keys.length - 12} more` : ""} }`;
  } finally {
    seen.delete(object);
  }
}

/** Sorted `[name, value]` pairs of an object, for the props and style tables. */
export function describeEntries(object: Record<string, unknown> | undefined, omit: readonly string[] = []): [string, string][] {
  if (!object) return [];
  return Object.keys(object).filter(key => !omit.includes(key) && object[key] !== undefined).sort()
    .map(key => [key, describeValue(object[key])]);
}

/** A native node's own fields besides id, kind, style and children. */
export function nativeFields(node: NativeNode): [string, string][] {
  return describeEntries(node as unknown as Record<string, unknown>, ["id", "kind", "style", "children"]);
}
