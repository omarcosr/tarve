import { PROTOCOL_VERSION, type NativeNode, type Renderer, type SceneDocument, type WindowOptions } from "./protocol";
import { Fragment, _isNativeVNode, type Child, type Component, type VNode } from "./jsx-runtime";
import { lightTheme, resolveStyleString, resolveThemeStyle, resolveThemeStyleShared, theme, type ThemeDefinition } from "./theme";
import { nativeAssetPath } from "#tarve/assets";
import type { ComponentAdapter } from "./component-adapter";
import { canonicalizeIntrinsicStyle } from "./intrinsic-style";
import { Text } from "./components/text";
import { serializeImageSource } from "./components/image";
import { parseTransform } from "./css-shadow";
import { withRenderScope } from "./render-scope";
import { MEMO, pureRoot, sameVNode, sameVNodeExceptText, TEXT_SLOT, type MemoInfo } from "./memo";
import { isSignal, type Signal } from "./signal";
import { openExternal } from "./bridge";
import { compileInline, type InlineContext } from "./inline-text";
import type { MediaRequest } from "./media-element";
import type { FormContext } from "./html-elements";
import { DIV_SHORTHANDS, expandIntrinsic, textContent } from "./reconciler/intrinsics";
import { sameValue } from "./reconciler/diff";
import { environmentKey, initialViewport, setViewportHook } from "./viewport";
import { BREAKPOINTS, foldVariants, luminance, type Position, type VariantContext } from "./reconciler/variants";

const isPrimitive = (child: Child): child is string | number => typeof child === "string" || typeof child === "number";
/** Children paths whose repeated `key` was already reported (warned once, not every render). */
const warnedDuplicateKeys = new Set<string>();





import { handlersOf, type Handlers } from "./reconciler/handlers";

export { diffTrees, diffTreeMutations } from "./reconciler/diff";
export type { Handlers } from "./reconciler/handlers";

function windowBorder(background: string, selected: ThemeDefinition): string {
  const own = luminance(background), themed = luminance(selected.colors.background);
  if (own === null || themed === null || (own < 0.5) === (themed < 0.5)) return selected.colors.border;
  return own < 0.5 ? "#ffffff1f" : "#0000001f";
}

/**
 * A node's value bound to a signal: a style key (resolved like the rest of the style when the
 * signal changes) or the text, made of the pieces it was written with (`Clicks: {count}`).
 */
export interface NodeBinding {
  signal: Signal<unknown>;
  /** The style key, and the theme and viewport the node compiled with (`resolveBoundStyle`). */
  style?: { key: string; theme: ThemeDefinition; viewport: [number, number] };
  text?: unknown[];
  /** A control field (a slider's `value`), set by a patch of the node. */
  control?: "value";
}
/** A bound control value as the control takes it: a number within its `min` and `max`. */
export function boundControlValue(value: unknown, control: { min?: number; max?: number }): number {
  const number = Number(value);
  if (!Number.isFinite(number)) return control.min ?? 0;
  return Math.max(control.min ?? -Infinity, Math.min(number, control.max ?? Infinity));
}
const noop = () => {};
/** Writes the style values a bound signal's `value` stands for into `out`, resolved like the rest of the style. */
export function resolveBoundStyle(binding: NonNullable<NodeBinding["style"]>, value: unknown, out: Map<string, unknown>): void {
  const { key, theme: bindingTheme } = binding;
  // Strings and numbers (a colour, an opacity) resolve on their own, as resolveThemeStyle
  // would; anything else (a gradient, a shadow) goes through the whole resolution.
  if (typeof value === "string") out.set(key, resolveStyleString(key, value, bindingTheme));
  else if (typeof value === "number") out.set(key, value);
  else {
    const context: VariantContext = { viewportWidth: binding.viewport[0], viewportHeight: binding.viewport[1], usedViewport: noop, usedPosition: noop };
    const resolved = resolveThemeStyle(foldVariants({ [key]: value } as never, bindingTheme, context), bindingTheme) as Record<string, unknown>;
    for (const name in resolved) out.set(name, resolved[name]);
  }
}
/** The text of bound pieces now: signals read, the rest as written. */
export function boundText(parts: readonly unknown[]): string {
  let text = "";
  for (let index = 0; index < parts.length; index++) {
    const part = parts[index];
    if (part == null || typeof part === "boolean") continue;
    text += isSignal(part) ? String(part.value ?? "") : String(part);
  }
  return text;
}
/** Text pieces when they hold a signal: a signal, or a list of strings, numbers and signals. */
function signalParts(children: unknown): unknown[] | undefined {
  if (isSignal(children)) return [children];
  if (!Array.isArray(children)) return undefined;
  let found = false;
  for (let index = 0; index < children.length; index++) {
    const child = children[index];
    if (isSignal(child)) found = true;
    else if (child != null && typeof child !== "string" && typeof child !== "number" && typeof child !== "boolean") return undefined;
  }
  return found ? children : undefined;
}
export interface CompiledTree {
  document: SceneDocument; handlers: Map<string, Handlers>; nodes: Map<string, NativeNode>; media?: Map<string, MediaRequest>;
  /** Signal bindings by node id (`signal.ts`). */
  bindings?: Map<string, NodeBinding[]>;
  /** Some style carried a window-width breakpoint: the app re-renders when the width changes. */
  usesViewport?: boolean;
  /** `viewport()` read the exact size: any resize re-renders (set by the app). */
  readsViewportSize?: boolean;
  /** The environment key the render read (viewport.ts), when it read one: a change re-renders. */
  environment?: string;
  /** Ids of controls rendered with `autoFocus`: the app focuses each once, when it first appears. */
  autoFocus?: string[];
}
const kinds = new Set(["window", "titlebar", "view", "row", "column", "text", "markdown", "code", "diff", "button", "image", "svg", "scroll", "input", "textarea", "pressable", "slider", "splitter", "video", "surface"]);
const interactiveKinds = new Set(["button", "input", "textarea", "pressable", "slider", "splitter"]);

function focusOutlineOverrides(style: NonNullable<NativeNode["style"]["focus"]> | undefined) {
  if (!style) return {};
  const { outlineWidth, outlineColor, outlineOffset, outlineRadius, outlineStyle } = style;
  return Object.fromEntries(
    Object.entries({ outlineWidth, outlineColor, outlineOffset, outlineRadius, outlineStyle })
      .filter(([, value]) => value !== undefined),
  );
}
/**
 * Font properties a node passes to its descendants, as CSS inherits them. The
 * theme font is the initial value at the root; Code, Diff and `<code>` set
 * monospace explicitly, like the user-agent style sheet.
 */
const INHERITED_FONT = ["fontFamily", "fontStyle", "letterSpacing", "wordSpacing", "fontVariantNumeric", "fontFeatureSettings", "fontSize", "fontWeight", "lineHeight", "foreground", "textAlign", "textTransform", "whiteSpace", "textShadow"] as const;
const INHERITED_FONT_SET: ReadonlySet<string> = new Set(INHERITED_FONT);
/** The computed value of `text-align: match-parent` under a parent whose computed value is `parent`. */
export function matchParentTextAlign(parent: unknown): string {
  if (parent === undefined || parent === "start" || parent === "match-parent") return "left";
  if (parent === "end") return "right";
  return String(parent);
}
/** Inherited font values that controls (buttons, inputs, code) take too. */
const CONTROL_FONT = ["fontFamily", "fontStyle", "letterSpacing", "wordSpacing", "textTransform"] as const;
/** Kinds whose text takes every inherited value; controls keep their own size, weight and colour. */
const INHERITING_TEXT = new Set(["text", "markdown"]);
const TEXT_KINDS = new Set(["text", "button", "input", "textarea", "markdown", "code", "diff"]);

/** Props copied to the native node unchanged when they are set. */
const COPIED_PROPS = [
  "value", "placeholder", "inputType", "scrollSpeed", "scrollOrientation", "followTail", "maxLength", "virtualList", "disabled", "modal",
  "portal", "dismissOnOutside", "focusable", "dragRegion", "draggable", "dropTarget", "fileDropTarget", "windowAction",
] as const;

const COPIED_PROP_SET: ReadonlySet<string> = new Set(COPIED_PROPS);

/** One memoized subtree: what produced it and everything compiling it registered. */
interface MemoEntry {
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
interface TextSlots {
  /** The text component VNode in the item, by slot. */
  owners: VNode[];
  /** Its compiled text node, by slot. */
  nodes: NativeNode[];
}
/** patchTexts' replaced nodes by id: a list row has a text or two, so two short arrays beat a Map. */
interface Replaced { ids: string[]; nodes: NativeNode[]; map: Map<string, NativeNode> | undefined }
const scratch: Replaced = { ids: [], nodes: [], map: undefined };
function replacedNode(replaced: Replaced, id: string): NativeNode | undefined {
  if (replaced.map) return replaced.map.get(id);
  const index = replaced.ids.indexOf(id);
  return index < 0 ? undefined : replaced.nodes[index];
}
/** A node with the replaced descendants swapped in; copied (and itself replaced) only above a change. */
function patchNode(node: NativeNode, replaced: Replaced): NativeNode {
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
interface TextPatch { owners: (VNode | undefined)[]; children: unknown[] }

const memoStores = new WeakMap<object, Map<string, MemoEntry>>();
const EMPTY_ENTRIES: readonly [string, unknown][] = Object.freeze([]) as readonly [string, unknown][];
/** A leaf's children: shared and frozen (nothing writes a compiled node's children in place). */
const NO_CHILDREN = Object.freeze([]) as unknown as NativeNode[];
/** A node's final style and the font its children inherit, by resolved style and inherited font. */
interface FinalStyle { style: NativeNode["style"]; font: Record<string, unknown> }
const finalStyleCache = new WeakMap<object, WeakMap<object, Map<string, FinalStyle>>>();

/**
 * Automatic memo for list items: an item made only of native kinds and pure components
 * (View, Row, Column, Text…) is compiled from its VNode alone, so an item equal to last
 * render's (`sameVNode`) reuses its compiled nodes, as `memo` would. A grid where one cell
 * of thousands changes compiles and diffs one cell.
 */
const AUTO_MEMO: MemoInfo<{ vnode: VNode; same: boolean; owners?: (VNode | undefined)[]; patch?: TextPatch }> = {
  render: props => props.vnode,
  // Compared once, before visitMemo (which counts on it).
  equal: (_previous, next) => next.same,
  template: true,
};
/** Native kinds and HTML elements that compile to plain boxes, text and pictures from their props alone. */
const PURE_INTRINSICS = new Set(["view", "row", "column", "text", "image", "svg", "div", "span", "p", "section", "main", "header", "footer", "article", "nav", "aside", "h1", "h2", "h3", "h4", "h5", "h6", "strong", "em", "b", "i", "small"]);
/** A string-typed element whose compile depends on its props alone: a native kind, or a plain HTML box. */
/** A media picture: its `<video>`/`<audio>` element registers the media around it, which a reused item would replace with its old request. */
const MEDIA_KINDS = new Set(["video", "audio", "surface"]);
const pureElement = (vnode: VNode): boolean => !MEDIA_KINDS.has(vnode.type as string) && (_isNativeVNode(vnode) || PURE_INTRINSICS.has(vnode.type as string));
/** Per render scope: how the last renders' automatic memos fared, to stop trying when most miss. */
interface AutoMemoState { tries: number; misses: number; off: number }
const autoMemoStates = new WeakMap<object, AutoMemoState>();
/** Renders to skip after one where most items changed (an animation of every item), before trying again. */
const AUTO_MEMO_BACKOFF = 16;

/** Devtools (devtools/trace.ts): wraps each function component's compile while the inspector traces a render. */
export type ComponentTrace = (type: Component, props: Record<string, any>, path: string, compile: () => NativeNode[]) => NativeNode[];
let componentTrace: ComponentTrace | undefined;
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
function entryIds(entry: MemoEntry): string[] {
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

export function compileTree(
  element: VNode,
  debug = false,
  renderer: Renderer = "auto",
  componentAdapters: readonly ComponentAdapter[] = [],
  renderScope?: object,
  visible = true,
  viewport?: { width: number; height: number },
): CompiledTree {
  let usesViewport = false;
  /** `viewport()` was read: a memoized subtree keys on the exact size, not just the breakpoint. */
  let exactViewport = false;
  const outerViewportHook = setViewportHook(() => { usesViewport = true; exactViewport = true; });
  const startViewport = viewport ?? initialViewport();
  const viewportWidth = () => startViewport?.width ?? windowOptions?.width ?? 1120;
  const viewportHeight = () => startViewport?.height ?? windowOptions?.height ?? 760;
  const handlers = new Map<string, Handlers>();
  const bindings = new Map<string, NodeBinding[]>();
  const ids = new Set<string>();
  /** Every id in the order it was claimed: memo entries slice their own span. */
  const idLog: string[] = [];
  const nodes = new Map<string, NativeNode>();
  const labelAssociations = new Map<string, string[]>();
  const labelableTargets = new Map<string, string>();
  let windowOptions: WindowOptions | undefined;
  let selectedTheme: ThemeDefinition = lightTheme;
  let inheritedFont: Record<string, unknown> = {};
  let currentForm: FormContext | undefined;
  const media = new Map<string, MediaRequest>();
  const autoFocus: string[] = [];
  let memoStore: Map<string, MemoEntry> | undefined;
  if (renderScope) {
    memoStore = memoStores.get(renderScope);
    if (!memoStore) memoStores.set(renderScope, memoStore = new Map());
  }
  const memoSeen = new Set<string>();
  /** memoSeen in insertion order: a memo entry's nested paths are a slice, not a walk of the whole set. */
  const memoOrder: string[] = [];
  function seeMemo(path: string): void {
    // One hash lookup: add, and tell a new path by the grown size.
    const size = memoSeen.size;
    memoSeen.add(path);
    if (memoSeen.size !== size) memoOrder.push(path);
  }
  /**
   * The plain texts compiled while an automatic memo's item compiles (TextSlots), in order: an
   * item's own are the ones added since it started. `collecting` counts the items compiling.
   */
  const slotOwners: VNode[] = [];
  const slotNodes: NativeNode[] = [];
  let collecting = 0;
  /** The text component being expanded while items collect: the owner of the text it compiles. */
  let textOwner: VNode | undefined;
  let autoMemo: AutoMemoState | undefined;
  if (renderScope && memoStore && (typeof process === "undefined" || process.env?.TARVE_AUTO_MEMO !== "0")) {
    autoMemo = autoMemoStates.get(renderScope);
    if (!autoMemo) autoMemoStates.set(renderScope, autoMemo = { tries: 0, misses: 0, off: 0 });
    // Most items changed last time: compile them plainly for a while, then try again.
    if (autoMemo.off > 0) { autoMemo.off--; autoMemo = undefined; }
    else { autoMemo.tries = 0; autoMemo.misses = 0; }
  }
  /** What compiling a subtree registered: the ids claimed since `mark` and their nodes, handlers and media. */
  function claimedSince(mark: number): Pick<MemoEntry, "ids" | "nodes" | "handlers" | "media" | "bindings"> {
    // Anonymous text logs its id twice (claimed, released, claimed again by its Text): keep one.
    const own = [...new Set(idLog.slice(mark))].filter(id => ids.has(id));
    // Nothing registered (most subtrees have no handlers, media or bindings): one shared empty list.
    const pick = <T>(map: Map<string, T>): [string, T][] => {
      if (map.size === 0) return EMPTY_ENTRIES as [string, T][];
      let out: [string, T][] | undefined;
      for (const id of own) { const value = map.get(id); if (value !== undefined) (out ??= []).push([id, value]); }
      return out ?? EMPTY_ENTRIES as [string, T][];
    };
    let ownNodes: NativeNode[] | undefined;
    for (let index = 0; index < own.length; index++) { const node = nodes.get(own[index]!); if (node !== undefined) (ownNodes ??= []).push(node); }
    const list = ownNodes ?? EMPTY_ENTRIES as unknown as NativeNode[];
    // Most subtrees claim exactly their nodes' ids: those are not kept twice.
    let same = list.length === own.length;
    for (let index = 0; same && index < own.length; index++) same = list[index]!.id === own[index];
    return { ids: same ? undefined : own, nodes: list, handlers: pick(handlers), media: pick(media), bindings: pick(bindings) };
  }

  function restore<T>(map: Map<string, T>, entries: [string, T][]): void {
    for (let index = 0; index < entries.length; index++) {
      const entry = entries[index]!;
      map.set(entry[0], entry[1]);
    }
  }
  function autoMemoItem(item: VNode, path: string, group: string | undefined, at: Position | undefined): NativeNode[] {
    // An item whose own type may read state is never the same: caching it only costs.
    if (!pureRoot(item, pureElement)) return visit(item, path, group, false, at);
    const state = autoMemo!;
    const previous = memoStore!.get(path);
    state.tries++;
    // visitMemo reuses it when equal; count the misses to know when this does not pay.
    const known = previous !== undefined && previous.render === AUTO_MEMO.render;
    let same = false;
    let owners: (VNode | undefined)[] | undefined;
    let patch: TextPatch | undefined;
    if (known && previous.texts) {
      // One walk tells equal, texts-only changes (patched in place) and anything else apart.
      const slots = previous.texts;
      const found: (VNode | undefined)[] = new Array(slots.owners.length);
      const children: unknown[] = new Array(slots.owners.length);
      if (sameVNodeExceptText(previous.props as VNode, item, pureElement, slots.owners, found, children)) {
        let changed = false;
        for (let slot = 0; slot < children.length; slot++) if (children[slot] !== undefined) { changed = true; break; }
        if (changed) patch = { owners: found, children };
        else { same = true; owners = found; }
      }
    } else if (known) same = sameVNode(previous.props as VNode, item, pureElement);
    // An item seen for the first time is no evidence either way.
    if (!known) state.tries--;
    else if (!same && !patch) state.misses++;
    return visitMemo(memoStore!, AUTO_MEMO as MemoInfo<object>, { vnode: item, same, owners, patch }, path, group, at);
  }
  function visitMemo(store: Map<string, MemoEntry>, info: MemoInfo<object>, props: object, path: string, group?: string, position?: Position): NativeNode[] {
    seeMemo(path);
    const previous = store.get(path);
    const sameContext = previous !== undefined && previous.render === info.render && previous.group === group && previous.theme === selectedTheme
      && previous.form === currentForm && sameValue(previous.font, inheritedFont)
      // A subtree with breakpoint styles is reused only at the breakpoint it was styled for.
      && (previous.breakpoint === undefined || previous.breakpoint === currentBreakpoint(previous.breakpoint.includes("x")))
      && (previous.position === undefined || (position !== undefined && previous.position === position.index + "/" + position.count));
    // An automatic memo whose item changed only some texts: the same nodes, those texts patched.
    const autoProps = info === (AUTO_MEMO as MemoInfo<object>) ? props as { vnode: VNode; owners?: (VNode | undefined)[]; patch?: TextPatch } : undefined;
    const patched = sameContext && autoProps?.patch && previous!.texts ? patchTexts(previous!, autoProps.patch) : undefined;
    if (previous && (patched || (sameContext && info.equal(previous.props, props)))) {
      if (patched) previous.result = patched;
      else if (autoProps?.owners && previous.texts) previous.texts.owners = autoProps.owners as VNode[];
      // It still depends on the width: the root must keep reporting resizes.
      if (previous.breakpoint !== undefined) usesViewport = true;
      // Indexed loops without destructuring: this is the whole cost of a reused subtree.
      const previousIds = previous.ids, previousNodes = previous.nodes;
      const claimed = previousIds ?? previousNodes;
      for (let index = 0; index < claimed.length; index++) {
        const id = previousIds ? previousIds[index]! : previousNodes[index]!.id;
        if (ids.has(id)) throw new Error(`Duplicate node id: ${id}`);
        ids.add(id); idLog.push(id);
      }
      for (let index = 0; index < previousNodes.length; index++) { const node = previousNodes[index]!; nodes.set(node.id, node); }
      restore(handlers, previous.handlers);
      restore(media, previous.media);
      restore(bindings, previous.bindings);
      // Memoized components nested in a reused subtree stay cached too.
      for (let index = 0; index < previous.nested.length; index++) seeMemo(previous.nested[index]!);
      // An automatic memo keeps only the item: the next render compares against it.
      // An automatic memo's props are its own object: the item is swapped in place.
      // An automatic memo keeps the item itself as its props.
      previous.props = autoProps ? autoProps.vnode : props;
      // An enclosing automatic memo's item contains these texts too.
      if (collecting > 0 && previous.texts) {
        for (let slot = 0; slot < previous.texts.owners.length; slot++) {
          slotOwners.push(previous.texts.owners[slot]!);
          slotNodes.push(previous.texts.nodes[slot]!);
        }
      }
      return previous.result;
    }
    const seenBefore = memoOrder.length;
    const before = { log: idLog.length, labels: labelAssociations.size, labelable: labelableTargets.size, window: windowOptions };
    const font = inheritedFont;
    const theme = selectedTheme;
    const form = currentForm;
    // Track whether this subtree reads the viewport, apart from the rest of the tree.
    const outerViewport = usesViewport, outerExact = exactViewport;
    usesViewport = false;
    exactViewport = false;
    let result: NativeNode[];
    let readViewport: boolean;
    const outerCollecting = collecting;
    const slotStart = slotOwners.length;
    // Plain memos hide their texts: they are compared by their own props, not as part of an item.
    collecting = autoProps ? collecting + 1 : 0;
    let readExact = false;
    let readPosition = false;
    try {
      // A template's element is the list item itself: it keeps the position (CSS :first-child).
      const outerPosition = positionRead;
      positionRead = false;
      try {
        result = visit(info.render(props), path, group, false, info.template ? position : undefined);
      } finally {
        readPosition = positionRead;
        positionRead = outerPosition || positionRead;
      }
    } finally {
      collecting = outerCollecting;
      readViewport = usesViewport;
      usesViewport = outerViewport || readViewport;
      readExact = exactViewport;
      exactViewport = outerExact || readExact;
    }
    // Labels and windows tie a subtree to nodes outside it; such subtrees always recompile.
    const selfContained = labelAssociations.size === before.labels && labelableTargets.size === before.labelable && windowOptions === before.window;
    if (selfContained) {
      store.set(path, {
        render: info.render, props, group, theme, font, form, result,
        ...claimedSince(before.log),
        // Only reached on a cache miss: what this subtree's compile saw first.
        nested: memoOrder.length > seenBefore ? memoOrder.slice(seenBefore) : EMPTY_ENTRIES as unknown as string[],
        ...readViewport ? { breakpoint: currentBreakpoint(readExact) } : {},
        ...readPosition && position ? { position: position.index + "/" + position.count } : {},
        ...autoProps && slotOwners.length > slotStart ? { texts: { owners: slotOwners.slice(slotStart), nodes: slotNodes.slice(slotStart) } } : {},
        ...autoProps ? { props: autoProps.vnode } : {},
      });
    } else store.delete(path);
    // A plain memo's texts are its own: an enclosing item does not see them.
    if (!autoProps) { slotOwners.length = slotStart; slotNodes.length = slotStart; }
    return result;
  }
  /**
   * The previous result of an automatic memo with the patch's texts replaced and their ancestors
   * copied, the entry updated; undefined when a new text is not plain (runs): the item compiles.
   */
  function patchTexts(previous: MemoEntry, patch: TextPatch): NativeNode[] | undefined {
    const slots = previous.texts!;
    // Scratch lists, reused item after item (patchTexts does not nest).
    const replacedIds = scratch.ids, replacedNodes = scratch.nodes;
    replacedIds.length = 0;
    replacedNodes.length = 0;
    const nextNodes = slots.nodes.slice();
    for (let slot = 0; slot < patch.children.length; slot++) {
      const children = patch.children[slot];
      if (children === undefined) continue;
      const old = slots.nodes[slot]!;
      const style = old.style as Record<string, unknown>;
      const inline = compileInline(children as Child, String(style.whiteSpace ?? "normal"), style, () => inlineContext(old.id, style));
      if (inline.runs.length) return undefined;
      const node: NativeNode = { ...old, text: inline.text };
      replacedIds.push(old.id);
      replacedNodes.push(node);
      nextNodes[slot] = node;
    }
    scratch.map = replacedIds.length > 8 ? new Map(replacedIds.map((id, index) => [id, replacedNodes[index]!])) : undefined;
    const replaced = scratch;
    const result: NativeNode[] = [];
    for (let index = 0; index < previous.result.length; index++) result.push(patchNode(previous.result[index]!, replaced));
    const entries = previous.nodes;
    for (let index = 0; index < entries.length; index++) {
      // The entry's own list (claimedSince made it): updated in place.
      const node = replacedNode(replaced, entries[index]!.id);
      if (node) entries[index] = node;
    }
    slots.owners = patch.owners as VNode[];
    slots.nodes = nextNodes;
    return result;
  }
  function inlineContext(textId: string, base: Record<string, unknown>): InlineContext {
    let runs = 0;
    return {
      base,
      linkColor: resolveStyleString("foreground", theme.colors.primary, selectedTheme),
      resolve: style => resolveThemeStyle(foldVariants(style, selectedTheme, { viewportWidth: viewportWidth(), viewportHeight: viewportHeight(), usedViewport: () => { usesViewport = true; } }) as never, selectedTheme) as Record<string, unknown>,
      register(id, onClick) {
        const runId = id ?? `${textId}/run:${runs++}`;
        if (ids.has(runId)) throw new Error(`Duplicate node id: ${runId}`);
        ids.add(runId); idLog.push(runId);
        handlers.set(runId, { onClick });
        return runId;
      },
      openExternal,
    };
  }
  // One context per compile instead of four closures per element (expandIntrinsic reads it synchronously).
  const intrinsicContext: Parameters<typeof expandIntrinsic>[2] = {
    form: undefined,
    labelable: (id, nativeId) => { labelableTargets.set(id, nativeId); },
    label: (targetId, labelId) => {
      const labels = labelAssociations.get(targetId) ?? [];
      labels.push(labelId);
      labelAssociations.set(targetId, labels);
    },
    media: (id, request) => { media.set(id, request); },
  };
  const usedViewport = () => { usesViewport = true; };
  // Set while a template's own element compiles; true when its style read the list position.
  let positionRead = false;
  const usedPosition = () => { positionRead = true; };
  /** How many responsive breakpoints the viewport width passes, its orientation and the environment; the exact size too when `viewport()` was read. */
  const currentBreakpoint = (exact: boolean) => {
    const width = viewportWidth(), height = viewportHeight();
    let passed = 0;
    for (let index = 0; index < BREAKPOINTS.length; index++) if (width >= BREAKPOINTS[index]![1]) passed++;
    return `${passed}|${height > width ? "p" : "l"}|${environmentKey()}${exact ? `|${width}x${height}` : ""}`;
  };
  // The theme focus ring most interactive nodes use, built once per theme; resolveThemeStyle copies it.
  let focusRingTheme: ThemeDefinition | undefined, focusRing: Record<string, unknown> = {};
  const defaultFocusRing = () => {
    if (focusRingTheme !== selectedTheme) {
      focusRingTheme = selectedTheme;
      focusRing = { outlineColor: theme.colors.ring, ...lightTheme.focusOutline, ...selectedTheme.focusOutline };
    }
    return focusRing;
  };
  // The CSS initial font values, per theme: built once instead of once per text node.
  let initialFontTheme: ThemeDefinition | undefined, initialFontValues: Record<string, unknown> = {};
  const initialFont = () => {
    if (initialFontTheme !== selectedTheme) {
      initialFontTheme = selectedTheme;
      initialFontValues = {
        fontFamily: theme.font.family, fontSize: theme.font.size, fontWeight: 400, lineHeight: theme.font.lineHeight,
        foreground: resolveStyleString("foreground", theme.colors.foreground, selectedTheme),
      };
    }
    return initialFontValues;
  };
  /**
   * A node's resolved style with what it inherits written in (CSS inherited font properties,
   * `text-align: match-parent`), and the inherited font its children get.
   */
  function finishStyle(fontStyle: Record<string, unknown>, parentFont: Record<string, unknown>, fontClass: "inherit" | "control" | "none"): Record<string, unknown> {
    // CSS `text-align: match-parent` computes to the parent's value, with start/end resolved against the
    // parent's direction (left-to-right: there is no `direction` property), so descendants inherit left/right.
    if (fontStyle.textAlign === "match-parent") fontStyle.textAlign = matchParentTextAlign(parentFont.textAlign);
    if (fontClass === "inherit") {
      const initial = initialFont();
      for (let index = 0; index < INHERITED_FONT.length; index++) {
        const key = INHERITED_FONT[index]!;
        if (fontStyle[key] !== undefined) continue;
        const value = parentFont[key] ?? initial[key];
        if (value !== undefined) fontStyle[key] = value;
      }
    } else if (fontClass === "control") {
      for (const key of CONTROL_FONT) {
        if (fontStyle[key] === undefined && parentFont[key] !== undefined) fontStyle[key] = parentFont[key];
      }
      fontStyle.fontFamily ??= theme.font.family;
    }
    let ownFont = parentFont;
    // A style has a few keys; INHERITED_FONT has thirteen.
    for (const key in fontStyle) {
      if (!INHERITED_FONT_SET.has(key)) continue;
      const value = fontStyle[key];
      if (value !== undefined && value !== parentFont[key]) {
        if (ownFont === parentFont) ownFont = { ...parentFont };
        ownFont[key] = value;
      }
    }
    return ownFont;
  }
  function visitComponent(child: VNode, path: string, group: string | undefined, position: Position | undefined): NativeNode[] {
    const type = child.type as Component;
    const info = (type as unknown as Record<symbol, MemoInfo<object> | undefined>)[MEMO];
    if (info && memoStore) return visitMemo(memoStore, info, child.props as object, path, group, position);
    if (collecting === 0 || (type as unknown as Record<symbol, unknown>)[TEXT_SLOT] !== true) {
      return visit(type(child.props), path, group, false, info?.template ? position : undefined);
    }
    const outerOwner = textOwner;
    textOwner = child;
    try {
      return visit(type(child.props), path, group, false, info?.template ? position : undefined);
    } finally {
      textOwner = outerOwner;
    }
  }
  function visit(child: Child, path: string, group?: string, adapterNative = false, position?: Position): NativeNode[] {
    if (child == null || typeof child === "boolean") return [];
    if (Array.isArray(child)) {
      // CSS `:first-child`/`:nth-child` count element children; text runs are not elements.
      let elements = 0;
      for (let index = 0; index < child.length; index++) {
        const item = child[index];
        if (typeof item === "object" && item !== null && !Array.isArray(item) && !isSignal(item)) elements++;
      }
      let seen = 0;
      let keysSeen: Map<string, number> | undefined;
      const out: NativeNode[] = [];
      for (let index = 0; index < child.length; index++) {
        const item = child[index];
        // Signals are text pieces too (`Clicks: {count}`).
        const primitive = isPrimitive(item) || isSignal(item);
        // CSS: a contiguous run of text children (`Mark {count} as read`) is one
        // anonymous box, not one per JSX expression; later pieces joined the first.
        if (primitive && index > 0 && (isPrimitive(child[index - 1]) || isSignal(child[index - 1]))) continue;
        const element = typeof item === "object" && item !== null && !Array.isArray(item) && !isSignal(item);
        const key = element ? (item as VNode).key : undefined;
        let piece: Child = item;
        if (primitive) {
          let end = index + 1;
          while (end < child.length && (isPrimitive(child[end]) || isSignal(child[end]))) end++;
          const run = child.slice(index, end);
          if (run.some(isSignal)) {
            const runPath = path + "/" + index;
            if (run.length === 1) {
              const nodes = visit(run[0] as Child, runPath, group);
              for (let n = 0; n < nodes.length; n++) out.push(nodes[n]!);
              continue;
            }
            // A run with a signal: one anonymous text bound to it.
            if (ids.has(runPath)) throw new Error(`Duplicate node id: ${runPath}`);
            ids.add(runPath); idLog.push(runPath);
            ids.delete(runPath);
            const bound = visit(Text({ id: runPath, children: run as never }), runPath, group);
            for (let n = 0; n < bound.length; n++) out.push(bound[n]!);
            continue;
          }
          let text = String(item);
          for (let next = index + 1; next < end; next++) text += String(child[next]);
          piece = text;
        }
        const at = element ? { index: seen++, count: elements } : undefined;
        let itemPath = path + "/" + (key != null ? "k:" + key : index);
        if (key != null) {
          // React: a repeated key is a warning, not a crash. Later copies get their own id and
          // the warning is shown once per path, so a render loop does not fail every frame.
          const seenKeys = keysSeen ??= new Map();
          const copies = seenKeys.get(itemPath) ?? 0;
          seenKeys.set(itemPath, copies + 1);
          if (copies > 0) {
            if (!warnedDuplicateKeys.has(itemPath)) {
              warnedDuplicateKeys.add(itemPath);
              console.warn(`[tarve] Duplicate key "${String(key)}" among the children at ${path}: keys should be unique; the copies are told apart by position.`);
            }
            itemPath += "#" + copies;
          }
        }
        const nodes = element && autoMemo && componentTrace === undefined && !((item as VNode).type as unknown as Record<symbol, unknown>)[MEMO]
          ? autoMemoItem(item as VNode, itemPath, group, at)
          : visit(piece, itemPath, group, false, at);
        for (let n = 0; n < nodes.length; n++) out.push(nodes[n]!);
      }
      return out;
    }
    if (typeof child === "string" || typeof child === "number") {
      if (ids.has(path)) throw new Error(`Duplicate node id: ${path}`);
      ids.add(path); idLog.push(path);
      // Anonymous text (a bare string child) inherits like any text node.
      ids.delete(path);
      return visit(Text({ id: path, children: String(child) }), path, group);
    }
    if (isSignal(child)) {
      // A bare signal child is anonymous text bound to it.
      if (ids.has(path)) throw new Error(`Duplicate node id: ${path}`);
      ids.add(path); idLog.push(path);
      ids.delete(path);
      return visit(Text({ id: path, children: child as never }), path, group);
    }
    if (child.type === Fragment || child.type === "fragment") return visit(child.props.children, path, group);
    if (!adapterNative) {
      for (const adapter of componentAdapters) {
        const adapted = adapter({ type: child.type, props: child.props, key: child.key });
        if (!adapted) continue;
        if (adapted === child) throw new Error("Component adapter returned the same VNode instance.");
        const adaptedIsNative = typeof adapted.type === "string" && kinds.has(adapted.type);
        return visit(adapted, path, group, adaptedIsNative);
      }
    }
    if (typeof child.type === "function") {
      if (componentTrace !== undefined) {
        const component = child;
        return componentTrace(child.type, child.props, path, () => visitComponent(component, path, group, position));
      }
      return visitComponent(child, path, group, position);
    }
    const isNativeVNode = adapterNative || _isNativeVNode(child);
    if (!isNativeVNode) {
      intrinsicContext.form = currentForm;
      const expanded = expandIntrinsic(child, path, intrinsicContext);
      if (expanded) {
        if (!expanded.form) return visit(expanded.element, path, group);
        const previous = currentForm;
        currentForm = expanded.form;
        try {
          return visit(expanded.element, path, group);
        } finally {
          currentForm = previous;
        }
      }
    }
    const isIntrinsicDiv = child.type === "div";
    const p = isIntrinsicDiv && (child.props.onClick || child.props.onLongPress) && child.props.focusable === undefined
      // HTML: a div with a click handler is clickable but not in the tab order.
      ? { ...child.props, focusable: false }
      : child.props;
    // Only buttons and pressables receive native clicks: a div with `onClick` (or `onLongPress`) is one.
    const nativeType = isIntrinsicDiv ? (p.onClick || p.onLongPress ? "pressable" : "view") : child.type;
    if (!kinds.has(nativeType)) throw new Error(`Unknown native component: ${child.type}`);
    const id = p.id ?? path;
    if (ids.has(id)) throw new Error(`Duplicate node id: ${id}`);
    ids.add(id); idLog.push(id);
    if (nativeType === "window") {
      if (windowOptions) throw new Error("This bootstrap supports one Window per app.");
      selectedTheme = p.theme ?? lightTheme;
      const width = p.width ?? 1120, height = p.height ?? 820;
      // The default minimum never exceeds the requested size (a small widget stays small).
      windowOptions = { title: p.title ?? "Tarve", width, height,
        minWidth: p.minWidth ?? Math.min(780, width), minHeight: p.minHeight ?? Math.min(580, height),
        background: resolveStyleString("background", p.style?.background ?? theme.colors.background, selectedTheme),
        decorations: !p.frameless, resizable: p.resizable ?? true, position: p.position ?? "center", debug,
          visible: visible && p.visible !== false };
        if (p.chrome === "none") windowOptions.chrome = "none";
        if (p.opacity !== undefined) {
          if (typeof p.opacity !== "number" || !Number.isFinite(p.opacity)) throw new RangeError("Window opacity must be a number from 0 to 1");
          if (p.opacity < 1) windowOptions.opacity = Math.max(0, p.opacity);
        }
      if (p.level && p.level !== "normal") windowOptions.level = p.level;
      if (p.maximized) windowOptions.maximized = true;
      if (p.skipTaskbar) windowOptions.skipTaskbar = true;
      if (p.activation === "never" || p.activation === "whileEditing") windowOptions.activation = p.activation;
      if (p.backdrop && p.backdrop !== "none") windowOptions.backdrop = p.backdrop;
      if (p.desktopWidget) {
        const { columns, rows } = p.desktopWidget;
        if (![columns, rows].every(n => Number.isInteger(n) && n >= 1 && n <= 16)) {
          throw new RangeError("desktopWidget columns and rows must be integers from 1 to 16");
        }
        Object.assign(windowOptions, { desktopWidget: { columns, rows }, decorations: false, resizable: false,
          level: p.level ?? "alwaysOnBottom", skipTaskbar: true });
      }
    }
    const hoverHandler = isIntrinsicDiv && (p.onMouseEnter || p.onMouseLeave)
      ? (entered: boolean) => {
          p.onHover?.(entered);
          if (entered) p.onMouseEnter?.();
          else p.onMouseLeave?.();
        }
      : p.onHover;
    const nodeHandlers = handlersOf(p, hoverHandler);
    if (nodeHandlers) handlers.set(id, nodeHandlers);
    const control = p.control ? { ...p.control } : undefined;
    const childGroup = control?.role === "radiogroup" || control?.role === "tablist" || control?.role === "navigation" || control?.role === "togglegroup"
      || control?.role === "tree" || control?.role === "grid" ? id : group;
    const semanticRoving = control && (control.role === "radio" || control.role === "tab" || control.role === "menuitem" || control.role === "toggle"
      || control.role === "treeitem" || control.role === "row");
    if ((semanticRoving || p.rovingGroup === true) && control) control.group = group;
    const rovingGroup = group && (p.rovingGroup === true || semanticRoving) ? group : undefined;
    const isText = nativeType === "text" || nativeType === "button";
    const isRichLeaf = nativeType === "markdown" || nativeType === "code" || nativeType === "diff";
    if (isRichLeaf && p.children != null) throw new Error(`${nativeType} is a native leaf and cannot have children.`);
    let rawStyle: Record<string, unknown>;
    if (isIntrinsicDiv) {
      const divShorthands: Record<string, unknown> = {};
      for (const key of DIV_SHORTHANDS) if (p[key] !== undefined) divShorthands[key] = p[key];
      rawStyle = { ...divShorthands, ...canonicalizeIntrinsicStyle(p.style) };
    } else rawStyle = { ...p.style };
    // Style values bound to signals: the current value now, and a binding that resolves the next ones.
    let nodeBindings: NodeBinding[] | undefined;
    for (const key in rawStyle) {
      const value = rawStyle[key];
      if (!isSignal(value)) continue;
      // Plain data, no closure: thousands of bound nodes hold one each.
      (nodeBindings ??= []).push({ signal: value, style: { key, theme: selectedTheme, viewport: [viewportWidth(), viewportHeight()] } });
      rawStyle[key] = value.value;
    }
    // CSS: `display: flex` lays a div's children in a row unless flex-direction says otherwise.
    if (isIntrinsicDiv && rawStyle.display === "flex" && rawStyle.direction === undefined) rawStyle.direction = "row";
    if (p.autoFocus === true && interactiveKinds.has(nativeType) && p.focusable !== false && !p.disabled) autoFocus.push(id);
    if ((interactiveKinds.has(nativeType) && p.focusable !== false) || control?.role === "otpSlot") {
      rawStyle.focusVisible = p.style?.focus === undefined && p.style?.focusVisible === undefined
        ? defaultFocusRing()
        : {
            outlineColor: theme.colors.ring,
            ...lightTheme.focusOutline,
            ...selectedTheme.focusOutline,
            ...focusOutlineOverrides(p.style?.focus),
            ...p.style?.focusVisible,
          };
      // OTP slots mirror a hidden input's caret. Pointer focus never sets
      // focus-visible, so without a plain focus ring a clicked OTP shows no
      // active slot at all.
      if (control?.role === "otpSlot") rawStyle.focus = { ...rawStyle.focusVisible as object, ...p.style?.focus };
    }
    const variants: VariantContext = { position, viewportWidth: viewportWidth(), viewportHeight: viewportHeight(), usedViewport, usedPosition };
    const folded = foldVariants(rawStyle, selectedTheme, variants);
    const parentFont = inheritedFont;
    const uaMargin = p.uaMargin as { block: number; inline?: number } | undefined;
    // Equal styles under the same inherited font come out equal: nodes share one (a list's
    // rows hold a handful of styles, not one each). The window's is its own (written below), and
    // so is a style bound to signals (a flush writes the new values into it).
    const shared = uaMargin || nativeType === "window" || nodeBindings ? undefined : resolveThemeStyleShared(folded, selectedTheme);
    const fontClass = INHERITING_TEXT.has(nativeType) ? "inherit" : TEXT_KINDS.has(nativeType) ? "control" : "none";
    let finalStyles: Map<string, FinalStyle> | undefined;
    let known: FinalStyle | undefined;
    if (shared) {
      let byFont = finalStyleCache.get(shared);
      if (!byFont) finalStyleCache.set(shared, byFont = new WeakMap());
      finalStyles = byFont.get(parentFont);
      if (!finalStyles) byFont.set(parentFont, finalStyles = new Map());
      known = finalStyles.get(fontClass);
    }
    let style: NativeNode["style"];
    if (known) {
      style = known.style;
      inheritedFont = known.font;
    } else {
      style = shared ? { ...shared } : resolveThemeStyle(folded, selectedTheme);
      if (!shared) {
        // The uncached path holds the caller's own nested objects: copied, so later writes to them show.
        if (style.padding && typeof style.padding === "object") style.padding = { ...style.padding };
        if (style.margin && typeof style.margin === "object") style.margin = { ...style.margin };
      }
      inheritedFont = finishStyle(style as Record<string, unknown>, parentFont, fontClass);
      // User-agent margins of HTML block elements (`uaMargin`: em vertically, px inline).
      if (uaMargin && style.margin === undefined) {
        const size = Number((style as Record<string, unknown>).fontSize ?? parentFont.fontSize ?? theme.font.size);
        const vertical = Math.round(uaMargin.block * size * 100) / 100;
        style.margin = { top: vertical, bottom: vertical, left: uaMargin.inline ?? 0, right: uaMargin.inline ?? 0 };
      }
      if (finalStyles) finalStyles.set(fontClass, { style, font: inheritedFont });
    }
    const imageSource = nativeType === "image" && p.src !== undefined
      ? serializeImageSource(p.src)
      : undefined;
    // Plain assignments instead of ~30 conditional object spreads per node:
    // on a 6,000-node first render the spreads alone cost ~10 ms.
    let children: NativeNode[];
    try {
      // Anonymous descendants are named from the nearest node, not the root: short,
      // stable ids that survive the subtree moving (a scrolled list row, a reordered key).
      children = isText || isRichLeaf ? NO_CHILDREN : visit(p.children, `${id}/children`, childGroup);
      // Most nodes are leaves: one shared, frozen empty list instead of one each.
      if (children.length === 0) children = NO_CHILDREN;
    } finally {
      inheritedFont = parentFont;
    }
    const node: NativeNode = { id, kind: nativeType as NativeNode["kind"], style, children };
    const optional = node as unknown as Record<string, unknown>;
    // A text bound to signals: its pieces now, and a binding per signal that writes the text again.
    const parts = isText ? signalParts(p.children) : undefined;
    const textChildren = parts ? boundText(parts) : p.children;
    if (parts) for (let index = 0; index < parts.length; index++) {
      const part = parts[index];
      if (isSignal(part)) (nodeBindings ??= []).push({ signal: part, text: parts });
    }
    if (nativeType === "text") {
      const inline = compileInline(textChildren, String(style.whiteSpace ?? "normal"), style as Record<string, unknown>, () => inlineContext(id, style as Record<string, unknown>));
      node.text = inline.text;
      if (inline.runs.length) node.runs = inline.runs;
      else if (collecting > 0 && !parts && textOwner !== undefined && textOwner.props.children === p.children) {
        // A plain text from a text component's own children: a slot its item can patch.
        slotOwners.push(textOwner); slotNodes.push(node);
        textOwner = undefined;
      }
    } else if (isText) node.text = textContent(textChildren);
    if (nativeType === "textarea" && p.richText !== undefined) {
      // A rich text area: its value styled by phrasing children, as runs over the value's text.
      const inline = compileInline(p.richText, "pre-wrap", style as Record<string, unknown>, () => inlineContext(id, style as Record<string, unknown>));
      if (inline.runs.length) node.runs = inline.runs;
    }
    if (nativeType === "code") node.text = p.code;
    if (nativeType === "markdown" || nativeType === "diff") node.source = p.source;
    if (p.language !== undefined) node.language = p.language;
    if (p.path !== undefined) node.path = p.path;
    if (p.dropTarget === undefined && (p.onDrop || p.onDragEnter || p.onDragLeave)) node.dropTarget = true;
    if (p.fileDropTarget === undefined && (p.onFileDrop || p.onFileDragEnter || p.onFileDragLeave)) node.fileDropTarget = true;
    if (p.onSize) node.reportSize = true;
    if (p.onLongPress) node.longPress = true;
    if (p.onPinch) node.pinch = true;
    if (p.onPointerMove || p.onPointerLeave) node.reportPointer = true;
    if (p.showLineNumbers !== undefined) node.showLineNumbers = p.showLineNumbers;
    if (p.wordDiff !== undefined) node.wordDiff = p.wordDiff;
    if (p.collapsedPaths !== undefined) node.collapsedPaths = [...p.collapsedPaths];
    if (p.maxLines !== undefined) node.maxLines = p.maxLines;
    if (p.highlight !== undefined) node.highlight = p.highlight;
    if (isRichLeaf) node.syntaxTheme = { ...selectedTheme.syntax, ...p.syntaxTheme };
    if (p.oldText !== undefined) node.oldText = p.oldText;
    if (p.newText !== undefined) node.newText = p.newText;
    if (p.svg !== undefined) node.svg = p.svg;
    if (control) {
      if (isSignal(control.value)) {
        const signal = control.value as Signal<unknown>;
        (nodeBindings ??= []).push({ signal, control: "value" });
        control.value = boundControlValue(signal.value, control);
      }
      node.control = control;
    }
    // CSS object-fit: a video keeps its ratio inside its box by default.
    if (nativeType === "video") node.fit = p.fit ?? "contain";
    if (nativeType === "surface" && p.native === true) node.native = true;
    if (imageSource && "path" in imageSource) {
      node.src = nativeAssetPath(imageSource.path);
      node.fit = p.fit ?? "cover";
    } else if (imageSource) {
      node.image = imageSource.image;
      node.fit = p.fit ?? "cover";
    }
    // Props has a few keys; COPIED_PROPS has fifteen.
    for (const key in p) if (COPIED_PROP_SET.has(key) && p[key] !== undefined) optional[key] = p[key];
    if (p.submitOnEnter !== undefined) node.submitOnEnter = p.submitOnEnter === true;
    if (p.readOnly !== undefined) node.readOnly = p.readOnly === true;
    if (rovingGroup) node.rovingGroup = rovingGroup;
    if (nativeType === "window" && p.onCloseRequest !== undefined) node.closeIntercept = true;
    if (p.motionFrom !== undefined) {
      node.motionFrom = typeof p.motionFrom.transform === "string"
        ? { ...p.motionFrom, transform: parseTransform(p.motionFrom.transform) }
        : { ...p.motionFrom };
    }
    if (nativeType === "input" || nativeType === "textarea") labelableTargets.set(id, id);
    if (nodeBindings) bindings.set(id, nodeBindings);
    nodes.set(id, node);
    return [node];
  }
  const roots = withRenderScope(renderScope, () => visit(element, "root"));
  if (memoStore) for (const path of memoStore.keys()) if (!memoSeen.has(path)) memoStore.delete(path);
  if (autoMemo && autoMemo.tries >= 64 && autoMemo.misses * 2 > autoMemo.tries) autoMemo.off = AUTO_MEMO_BACKOFF;
  for (const [targetId, labelIds] of labelAssociations) {
    const nativeTargetId = labelableTargets.get(targetId);
    if (!nativeTargetId) throw new Error(`label htmlFor references unknown or unsupported target: ${targetId}`);
    const target = nodes.get(nativeTargetId);
    if (!target) throw new Error(`label htmlFor target did not compile: ${targetId}`);
    target.labelledBy = [...new Set([...(target.labelledBy ?? []), ...labelIds])];
  }
  if (roots.length !== 1 || roots[0].kind !== "window" || !windowOptions) throw new Error("render() requires one Window root.");
  const titleBars = [...nodes.values()].filter(node => node.kind === "titlebar");
  if (titleBars.length > 1) throw new Error("Window can contain only one TitleBar.");
  if (titleBars.length === 1) {
    windowOptions.decorations = false;
    roots[0].style.borderWidth ??= 1;
    // A window painted darker or lighter than its theme (a dark app on the
    // default light theme) gets a hairline that reads on its own background.
    roots[0].style.borderColor ??= windowBorder(String(roots[0].style.background ?? ""), selectedTheme);
    roots[0].style.radius ??= theme.radius.md;
  } else if (!windowOptions.decorations) {
    // Frameless without a TitleBar (a desktop widget): the system edge still
    // draws, in a colour that suits the window instead of the light default.
    roots[0].style.borderColor ??= windowBorder(String(roots[0].style.background ?? ""), selectedTheme);
  }
  // The root reports its size so the app can re-render when the window crosses a breakpoint.
  if (usesViewport) roots[0].reportSize = true;
  setViewportHook(outerViewportHook);
  return { document: { version: PROTOCOL_VERSION, renderer, window: windowOptions, root: roots[0] }, handlers, nodes, media, usesViewport, ...bindings.size ? { bindings } : {}, ...autoFocus.length ? { autoFocus } : {} };
}
