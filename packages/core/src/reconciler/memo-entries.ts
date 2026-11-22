/** Memoized subtrees (`memo`, templates and automatic list-item memos): what each keeps between renders. */
import { _isNativeVNode, type Component, type VNode } from "../jsx-runtime";
import type { NativeNode } from "../protocol";
import type { ThemeDefinition } from "../theme";
import type { MemoInfo } from "../memo";
import type { MediaRequest } from "../media-element";
import type { FormContext } from "../html-elements";
import type { Handlers } from "./handlers";
import type { NodeBinding } from "./bindings";

/** One memoized subtree: what produced it and everything compiling it registered. */
export interface MemoEntry {
  render: MemoInfo<object>["render"];
  props: object;
  group: string | undefined;
  theme: ThemeDefinition;
  font: Record<string, unknown>;
  form: FormContext | undefined;
  result: NativeNode[];
  /** The ids it claimed, when they are not just its nodes' ids in order (`entryIds`). */
  ids: string[] | undefined;
  /** Its nodes; each is registered under its own id. */
  nodes: NativeNode[];
  handlers: [string, Handlers][];
  media: [string, MediaRequest][];
  bindings: [string, NodeBinding[]][];
  /** Memoized components inside this one, kept alive when it is reused. */
  nested: string[];
  idSet?: Set<string>;
  /** The breakpoint, orientation and environment the subtree was styled for, when it read them (currentBreakpoint). */
  breakpoint?: string;
  /** "index/count" of the list position a template's element was styled for (first/last/odd/even). */
  position?: string;
  /** Plain texts in the subtree (automatic memos only): what an item whose texts alone changed patches. */
  texts?: TextSlots;
}

/** The plain text nodes of a compiled item and the VNodes whose children they show. */
export interface TextSlots {
  /** The text component VNode in the item, by slot. */
  owners: VNode[];
  /** Its compiled text node, by slot. */
  nodes: NativeNode[];
}
/** patchTexts' replaced nodes by id: a list row has a text or two, so two short arrays beat a Map. */
export interface Replaced { ids: string[]; nodes: NativeNode[]; map: Map<string, NativeNode> | undefined }
export const scratch: Replaced = { ids: [], nodes: [], map: undefined };
export function replacedNode(replaced: Replaced, id: string): NativeNode | undefined {
  if (replaced.map) return replaced.map.get(id);
  const index = replaced.ids.indexOf(id);
  return index < 0 ? undefined : replaced.nodes[index];
}
/** A node with the replaced descendants swapped in; copied (and itself replaced) only above a change. */
export function patchNode(node: NativeNode, replaced: Replaced): NativeNode {
  const own = replacedNode(replaced, node.id);
  if (own) return own;
  const children = node.children;
  if (!children || children.length === 0) return node;
  let next: NativeNode[] | undefined;
  for (let index = 0; index < children.length; index++) {
    const child = children[index]!;
    const patched = patchNode(child, replaced);
    if (patched !== child) (next ??= children.slice())[index] = patched;
  }
  if (!next) return node;
  const copy: NativeNode = { ...node, children: next };
  if (replaced.map) replaced.map.set(node.id, copy);
  else { replaced.ids.push(node.id); replaced.nodes.push(copy); }
  return copy;
}
/** What autoMemoItem found when only some slots' texts changed: the new owners and children by slot. */
export interface TextPatch { owners: (VNode | undefined)[]; children: unknown[] }

export const memoStores = new WeakMap<object, Map<string, MemoEntry>>();
export const unstoredItems = new WeakMap<object, Set<string>>();
export const EMPTY_ENTRIES: readonly [string, unknown][] = Object.freeze([]) as readonly [string, unknown][];
/** A leaf's children: shared and frozen (nothing writes a compiled node's children in place). */
export const NO_CHILDREN = Object.freeze([]) as unknown as NativeNode[];
/** A node's final style and the font its children inherit, by resolved style and inherited font. */
export interface FinalStyle { style: NativeNode["style"]; font: Record<string, unknown> }
export const finalStyleCache = new WeakMap<object, WeakMap<object, Map<string, FinalStyle>>>();

/**
 * Automatic memo for list items: an item made only of native kinds and pure components
 * (View, Row, Column, Text…) is compiled from its VNode alone, so an item equal to last
 * render's (`sameVNode`) reuses its compiled nodes, as `memo` would. A grid where one cell
 * of thousands changes compiles and diffs one cell.
 */
export const AUTO_MEMO: MemoInfo<{ vnode: VNode; same: boolean; owners?: (VNode | undefined)[]; patch?: TextPatch }> = {
  render: props => props.vnode,
  // Compared once, before visitMemo (which counts on it).
  equal: (_previous, next) => next.same,
  template: true,
};
/** Native kinds and HTML elements that compile to plain boxes, text and pictures from their props alone. */
export const PURE_INTRINSICS = new Set(["view", "row", "column", "text", "image", "svg", "div", "span", "p", "section", "main", "header", "footer", "article", "nav", "aside", "h1", "h2", "h3", "h4", "h5", "h6", "strong", "em", "b", "i", "small"]);
/** A string-typed element whose compile depends on its props alone: a native kind, or a plain HTML box. */
/** A media picture: its `<video>`/`<audio>` element registers the media around it, which a reused item would replace with its old request. */
export const MEDIA_KINDS = new Set(["video", "audio", "surface"]);
export const pureElement = (vnode: VNode): boolean => !MEDIA_KINDS.has(vnode.type as string) && (_isNativeVNode(vnode) || PURE_INTRINSICS.has(vnode.type as string));
/** Per render scope: how the last renders' automatic memos fared, to stop trying when most miss. */
export interface AutoMemoState { tries: number; misses: number; off: number }
export const autoMemoStates = new WeakMap<object, AutoMemoState>();
/** Renders to skip after one where most items changed (an animation of every item), before trying again. */
export const AUTO_MEMO_BACKOFF = 16;
/** Children inside a memoized item get memo entries of their own only when there are more than this. */
export const NESTED_AUTO_MEMO_MIN = 4;

/** Devtools (devtools/trace.ts): wraps each function component's compile while the inspector traces a render. */
export type ComponentTrace = (type: Component, props: Record<string, any>, path: string, compile: () => NativeNode[]) => NativeNode[];
export let componentTrace: ComponentTrace | undefined;
/** Installs a component trace for the next compiles; returns the previous one to restore. */
export function setComponentTrace(trace: ComponentTrace | undefined): ComponentTrace | undefined {
  const previous = componentTrace;
  componentTrace = trace;
  return previous;
}

/**
 * Forgets every memoized subtree containing `id`, so the next render compiles it
 * again. Called when a handler of that node runs: handlers update the state a
 * component reads (VirtualList's measured height, a row's own module state),
 * which its props alone do not show.
 */
/** The ids a memo entry claimed: its own list, or its nodes' ids (most entries). */
export function entryIds(entry: MemoEntry): string[] {
  return entry.ids ?? entry.nodes.map(node => node.id);
}

export function invalidateMemos(renderScope: object, id: string): void {
  const store = memoStores.get(renderScope);
  if (!store) return;
  for (const [path, entry] of store) {
    entry.idSet ??= new Set(entryIds(entry));
    if (entry.idSet.has(id)) store.delete(path);
  }
}
