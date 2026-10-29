import { PROTOCOL_VERSION, type NativeNode, type Renderer, type SceneDocument, type WindowOptions } from "./protocol";
import { Fragment, _isNativeVNode, type Child, type Component, type VNode } from "./jsx-runtime";
import { lightTheme, resolveStyleString, resolveThemeStyle, theme, type ThemeDefinition } from "./theme";
import { nativeAssetPath } from "#tarve/assets";
import type { ComponentAdapter } from "./component-adapter";
import { canonicalizeIntrinsicStyle } from "./intrinsic-style";
import { Text } from "./components/text";
import { serializeImageSource } from "./components/image";
import { parseTransform } from "./css-shadow";
import { withRenderScope } from "./render-scope";
import { MEMO, type MemoInfo } from "./memo";
import { openExternal } from "./bridge";
import { compileInline, type InlineContext } from "./inline-text";
import type { MediaRequest } from "./media-element";
import type { FormContext } from "./html-elements";
import { DIV_SHORTHANDS, expandIntrinsic, textContent } from "./reconciler/intrinsics";
import { sameValue } from "./reconciler/diff";
import { environmentKey, initialViewport, setViewportHook } from "./viewport";
import { BREAKPOINTS, foldVariants, luminance, type Position, type VariantContext } from "./reconciler/variants";

const isPrimitive = (child: Child): child is string | number => typeof child === "string" || typeof child === "number";




import { handlersOf, type Handlers } from "./reconciler/handlers";

export { diffTrees, diffTreeMutations } from "./reconciler/diff";
export type { Handlers } from "./reconciler/handlers";

function windowBorder(background: string, selected: ThemeDefinition): string {
  const own = luminance(background), themed = luminance(selected.colors.background);
  if (own === null || themed === null || (own < 0.5) === (themed < 0.5)) return selected.colors.border;
  return own < 0.5 ? "#ffffff1f" : "#0000001f";
}

export interface CompiledTree {
  document: SceneDocument; handlers: Map<string, Handlers>; nodes: Map<string, NativeNode>; media?: Map<string, MediaRequest>;
  /** Some style carried a window-width breakpoint: the app re-renders when the width changes. */
  usesViewport?: boolean;
  /** `viewport()` read the exact size: any resize re-renders (set by the app). */
  readsViewportSize?: boolean;
  /** The environment key the render read (viewport.ts), when it read one: a change re-renders. */
  environment?: string;
}
const kinds = new Set(["window", "titlebar", "view", "row", "column", "text", "markdown", "code", "diff", "button", "image", "svg", "scroll", "input", "textarea", "pressable", "slider", "splitter", "video"]);
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
const INHERITED_FONT = ["fontFamily", "fontStyle", "letterSpacing", "wordSpacing", "fontVariantNumeric", "fontFeatureSettings", "fontSize", "fontWeight", "lineHeight", "foreground", "textAlign", "textTransform", "whiteSpace"] as const;
const INHERITED_FONT_SET: ReadonlySet<string> = new Set(INHERITED_FONT);
/** Inherited font values that controls (buttons, inputs, code) take too. */
const CONTROL_FONT = ["fontFamily", "fontStyle", "letterSpacing", "wordSpacing", "textTransform"] as const;
/** Kinds whose text takes every inherited value; controls keep their own size, weight and colour. */
const INHERITING_TEXT = new Set(["text", "markdown"]);
const TEXT_KINDS = new Set(["text", "button", "input", "textarea", "markdown", "code", "diff"]);

/** Props copied to the native node unchanged when they are set. */
const COPIED_PROPS = [
  "value", "placeholder", "inputType", "scrollSpeed", "scrollOrientation", "virtualList", "disabled", "modal",
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
  ids: string[];
  nodes: [string, NativeNode][];
  handlers: [string, Handlers][];
  media: [string, MediaRequest][];
  /** Memoized components inside this one, kept alive when it is reused. */
  nested: string[];
  idSet?: Set<string>;
  /** The breakpoint, orientation and environment the subtree was styled for, when it read them (currentBreakpoint). */
  breakpoint?: string;
  /** "index/count" of the list position a template's element was styled for (first/last/odd/even). */
  position?: string;
}
const memoStores = new WeakMap<object, Map<string, MemoEntry>>();

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
export function invalidateMemos(renderScope: object, id: string): void {
  const store = memoStores.get(renderScope);
  if (!store) return;
  for (const [path, entry] of store) {
    entry.idSet ??= new Set(entry.ids);
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
  let memoStore: Map<string, MemoEntry> | undefined;
  if (renderScope) {
    memoStore = memoStores.get(renderScope);
    if (!memoStore) memoStores.set(renderScope, memoStore = new Map());
  }
  const memoSeen = new Set<string>();
  /** What compiling a subtree registered: the ids claimed since `mark` and their nodes, handlers and media. */
  function claimedSince(mark: number): Pick<MemoEntry, "ids" | "nodes" | "handlers" | "media"> {
    // Anonymous text logs its id twice (claimed, released, claimed again by its Text): keep one.
    const own = [...new Set(idLog.slice(mark))].filter(id => ids.has(id));
    const pick = <T>(map: Map<string, T>) => {
      const out: [string, T][] = [];
      for (const id of own) { const value = map.get(id); if (value !== undefined) out.push([id, value]); }
      return out;
    };
    return { ids: own, nodes: pick(nodes), handlers: pick(handlers), media: pick(media) };
  }
  function added(set: Set<string>, skip: number): string[] {
    // Only reached on a cache miss; Sets iterate in insertion order.
    const out: string[] = [];
    let index = 0;
    for (const value of set) if (index++ >= skip) out.push(value);
    return out;
  }
  function restore<T>(map: Map<string, T>, entries: [string, T][]): void {
    for (let index = 0; index < entries.length; index++) {
      const entry = entries[index]!;
      map.set(entry[0], entry[1]);
    }
  }
  function visitMemo(store: Map<string, MemoEntry>, info: MemoInfo<object>, props: object, path: string, group?: string, position?: Position): NativeNode[] {
    const at = position ? position.index + "/" + position.count : "";
    memoSeen.add(path);
    const previous = store.get(path);
    if (previous && previous.render === info.render && previous.group === group && previous.theme === selectedTheme
      && previous.form === currentForm && sameValue(previous.font, inheritedFont)
      // A subtree with breakpoint styles is reused only at the breakpoint it was styled for.
      && (previous.breakpoint === undefined || previous.breakpoint === currentBreakpoint(previous.breakpoint.includes("x")))
      && (previous.position === undefined || previous.position === at)
      && info.equal(previous.props, props)) {
      // It still depends on the width: the root must keep reporting resizes.
      if (previous.breakpoint !== undefined) usesViewport = true;
      // Indexed loops without destructuring: this is the whole cost of a reused subtree.
      const previousIds = previous.ids;
      for (let index = 0; index < previousIds.length; index++) {
        const id = previousIds[index]!;
        if (ids.has(id)) throw new Error(`Duplicate node id: ${id}`);
        ids.add(id); idLog.push(id);
      }
      restore(nodes, previous.nodes);
      restore(handlers, previous.handlers);
      restore(media, previous.media);
      // Memoized components nested in a reused subtree stay cached too.
      for (let index = 0; index < previous.nested.length; index++) memoSeen.add(previous.nested[index]!);
      previous.props = props;
      return previous.result;
    }
    const seenBefore = memoSeen.size;
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
        nested: added(memoSeen, seenBefore),
        ...readViewport ? { breakpoint: currentBreakpoint(readExact) } : {},
        ...readPosition && at ? { position: at } : {},
      });
    } else store.delete(path);
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
  function visitComponent(child: VNode, path: string, group: string | undefined, position: Position | undefined): NativeNode[] {
    const type = child.type as Component;
    const info = (type as unknown as Record<symbol, MemoInfo<object> | undefined>)[MEMO];
    if (info && memoStore) return visitMemo(memoStore, info, child.props as object, path, group, position);
    return visit(type(child.props), path, group, false, info?.template ? position : undefined);
  }
  function visit(child: Child, path: string, group?: string, adapterNative = false, position?: Position): NativeNode[] {
    if (child == null || typeof child === "boolean") return [];
    if (Array.isArray(child)) {
      // CSS `:first-child`/`:nth-child` count element children; text runs are not elements.
      let elements = 0;
      for (let index = 0; index < child.length; index++) {
        const item = child[index];
        if (typeof item === "object" && item !== null && !Array.isArray(item)) elements++;
      }
      let seen = 0;
      const out: NativeNode[] = [];
      for (let index = 0; index < child.length; index++) {
        const item = child[index];
        const primitive = typeof item === "string" || typeof item === "number";
        // CSS: a contiguous run of text children (`Mark {count} as read`) is one
        // anonymous box, not one per JSX expression; later pieces joined the first.
        if (primitive && index > 0 && isPrimitive(child[index - 1])) continue;
        const element = typeof item === "object" && item !== null && !Array.isArray(item);
        const key = element ? (item as VNode).key : undefined;
        let piece: Child = item;
        if (primitive) {
          let text = String(item);
          for (let next = index + 1; next < child.length && isPrimitive(child[next]); next++) text += String(child[next]);
          piece = text;
        }
        const at = element ? { index: seen++, count: elements } : undefined;
        const nodes = visit(piece, path + "/" + (key != null ? "k:" + key : index), group, false, at);
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
        decorations: !p.frameless, resizable: p.resizable ?? true, position: p.position ?? "center", debug, visible };
      if (p.level && p.level !== "normal") windowOptions.level = p.level;
      if (p.maximized) windowOptions.maximized = true;
      if (p.skipTaskbar) windowOptions.skipTaskbar = true;
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
    // CSS: `display: flex` lays a div's children in a row unless flex-direction says otherwise.
    if (isIntrinsicDiv && rawStyle.display === "flex" && rawStyle.direction === undefined) rawStyle.direction = "row";
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
    const style = resolveThemeStyle(foldVariants(rawStyle, selectedTheme, variants), selectedTheme);
    if (style.padding && typeof style.padding === "object") style.padding = { ...style.padding };
    if (style.margin && typeof style.margin === "object") style.margin = { ...style.margin };
    const imageSource = nativeType === "image" && p.src !== undefined
      ? serializeImageSource(p.src)
      : undefined;
    const parentFont = inheritedFont;
    const fontStyle = style as Record<string, unknown>;
    if (INHERITING_TEXT.has(nativeType)) {
      const initial = initialFont();
      for (let index = 0; index < INHERITED_FONT.length; index++) {
        const key = INHERITED_FONT[index]!;
        if (fontStyle[key] !== undefined) continue;
        const value = parentFont[key] ?? initial[key];
        if (value !== undefined) fontStyle[key] = value;
      }
    } else if (TEXT_KINDS.has(nativeType)) {
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
    inheritedFont = ownFont;
    // User-agent margins of HTML block elements (`uaMargin`: em vertically, px inline).
    const uaMargin = p.uaMargin as { block: number; inline?: number } | undefined;
    if (uaMargin && style.margin === undefined) {
      const size = Number(fontStyle.fontSize ?? parentFont.fontSize ?? theme.font.size);
      const vertical = Math.round(uaMargin.block * size * 100) / 100;
      style.margin = { top: vertical, bottom: vertical, left: uaMargin.inline ?? 0, right: uaMargin.inline ?? 0 };
    }
    // Plain assignments instead of ~30 conditional object spreads per node:
    // on a 6,000-node first render the spreads alone cost ~10 ms.
    let children: NativeNode[];
    try {
      // Anonymous descendants are named from the nearest node, not the root: short,
      // stable ids that survive the subtree moving (a scrolled list row, a reordered key).
      children = isText || isRichLeaf ? [] : visit(p.children, `${id}/children`, childGroup);
    } finally {
      inheritedFont = parentFont;
    }
    const node: NativeNode = { id, kind: nativeType as NativeNode["kind"], style, children };
    const optional = node as unknown as Record<string, unknown>;
    if (nativeType === "text") {
      const inline = compileInline(p.children, String(style.whiteSpace ?? "normal"), style as Record<string, unknown>, () => inlineContext(id, style as Record<string, unknown>));
      node.text = inline.text;
      if (inline.runs.length) node.runs = inline.runs;
    } else if (isText) node.text = textContent(p.children);
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
    if (control) node.control = control;
    // CSS object-fit: a video keeps its ratio inside its box by default.
    if (nativeType === "video") node.fit = p.fit ?? "contain";
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
    if (rovingGroup) node.rovingGroup = rovingGroup;
    if (nativeType === "window" && p.onCloseRequest !== undefined) node.closeIntercept = true;
    if (p.motionFrom !== undefined) {
      node.motionFrom = typeof p.motionFrom.transform === "string"
        ? { ...p.motionFrom, transform: parseTransform(p.motionFrom.transform) }
        : { ...p.motionFrom };
    }
    if (nativeType === "input" || nativeType === "textarea") labelableTargets.set(id, id);
    nodes.set(id, node);
    return [node];
  }
  const roots = withRenderScope(renderScope, () => visit(element, "root"));
  if (memoStore) for (const path of memoStore.keys()) if (!memoSeen.has(path)) memoStore.delete(path);
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
  return { document: { version: PROTOCOL_VERSION, renderer, window: windowOptions, root: roots[0] }, handlers, nodes, media, usesViewport };
}
