import { PROTOCOL_VERSION, type NativeNode, type Renderer, type SceneDocument, type ScrollPosition, type TreeMutation, type VirtualListMeasurement, type WindowOptions } from "../../protocol/src/index";
import { Fragment, _isNativeVNode, type Child, type IntrinsicAnchorProps, type VNode } from "./jsx-runtime";
import { lightTheme, resolveThemeColor, resolveThemeStyle, theme, type ThemeDefinition } from "./theme";
import { nativeAssetPath } from "#tarve/assets";
import type { WindowCloseRequestEvent } from "./components";
import type { ComponentAdapter } from "./component-adapter";
import { canonicalizeIntrinsicStyle } from "./intrinsic-style";
import { Text } from "./components/text";
import { Image, serializeImageSource } from "./components/image";
import { Input, TextArea } from "./components/input";
import { Button } from "./components/button";
import { Link } from "./components/link";
import { Svg } from "./components/svg";
import { Select } from "./select";
import { Progress, Separator } from "./controls";
import { Label } from "./form-controls";
import { withRenderScope } from "./render-scope";
export interface Handlers { onClick?: () => void; onMarkdownLink?: (href: string) => void; onDiffToggleFile?: (path: string) => void; onDiffShowMore?: (hidden: number, path?: string) => void; onDiffLineClick?: (event: { text: string; path?: string; oldLine?: number; newLine?: number }) => void; onHighlight?: (event: { matchCount: number }) => void; onContextMenu?: (position: { x: number; y: number }) => void; onOutsideClick?: () => void; onHover?: (value: boolean) => void; onChange?: (value: string) => void; onValueChange?: (value: number) => void; onScroll?: (offset: number, max: number) => void; onScrollPosition?: (position: ScrollPosition) => void; onVirtualListLayout?: (items: VirtualListMeasurement[]) => void; onVirtualListScrollToItem?: (index: number, offset: number) => void; onVirtualListFocus?: (key: string | null) => void; onEscape?: () => void; onKeyDown?: (key: string) => void; onBlur?: () => void; onCloseRequest?: (event: WindowCloseRequestEvent) => void }
export interface CompiledTree { document: SceneDocument; handlers: Map<string, Handlers>; nodes: Map<string, NativeNode> }
const kinds = new Set(["window", "titlebar", "view", "row", "column", "text", "markdown", "code", "diff", "button", "image", "svg", "scroll", "input", "textarea", "pressable", "slider", "splitter"]);
const interactiveKinds = new Set(["button", "input", "textarea", "pressable", "slider", "splitter"]);
const svgIntrinsicElements = new Set(["path", "circle", "ellipse", "g", "line", "polygon", "polyline", "rect"]);
const headingPreset = {
  h1: { size: 32, weight: 700 },
  h2: { size: 24, weight: 700 },
  h3: { size: 20, weight: 600 },
  h4: { size: 18, weight: 600 },
  h5: { size: 16, weight: 600 },
  h6: { size: 14, weight: 600 },
} as const;

function focusOutlineOverrides(style: NonNullable<NativeNode["style"]["focus"]> | undefined) {
  if (!style) return {};
  const { outlineWidth, outlineColor, outlineOffset, outlineRadius, outlineStyle } = style;
  return Object.fromEntries(
    Object.entries({ outlineWidth, outlineColor, outlineOffset, outlineRadius, outlineStyle })
      .filter(([, value]) => value !== undefined),
  );
}
function textContent(value: Child): string {
  if (Array.isArray(value)) return value.map(textContent).join("");
  if (value == null || typeof value === "boolean") return "";
  if (typeof value === "object") throw new Error("Text/Button children must be strings or numbers.");
  return String(value);
}
export function compileTree(
  element: VNode,
  debug = false,
  renderer: Renderer = "auto",
  componentAdapters: readonly ComponentAdapter[] = [],
  renderScope?: object,
  visible = true,
): CompiledTree {
  const handlers = new Map<string, Handlers>();
  const ids = new Set<string>();
  const nodes = new Map<string, NativeNode>();
  const labelAssociations = new Map<string, string[]>();
  const labelableTargets = new Map<string, string>();
  let windowOptions: WindowOptions | undefined;
  let selectedTheme: ThemeDefinition = lightTheme;
  function visit(child: Child, path: string, group?: string, adapterNative = false): NativeNode[] {
    if (child == null || typeof child === "boolean") return [];
    if (Array.isArray(child)) return child.flatMap((item, index) => {
      const key = typeof item === "object" && item && !Array.isArray(item) ? item.key : undefined;
      return visit(item, `${path}/${key != null ? `k:${key}` : index}`, group);
    });
    if (typeof child === "string" || typeof child === "number") {
      if (ids.has(path)) throw new Error(`Duplicate node id: ${path}`);
      ids.add(path);
      const node: NativeNode = { id: path, kind: "text", style: {}, text: String(child), children: [] };
      nodes.set(path, node);
      return [node];
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
    if (typeof child.type === "function") return visit(child.type(child.props), path, group);
    const isNativeVNode = adapterNative || _isNativeVNode(child);
    if (!isNativeVNode && child.type in headingPreset) {
      const props = child.props as Parameters<typeof Text>[0];
      const preset = headingPreset[child.type as keyof typeof headingPreset];
      return visit(Text({
        ...props,
        size: props.size ?? preset.size,
        weight: props.weight ?? preset.weight,
        style: canonicalizeIntrinsicStyle(props.style),
      }), path, group);
    }
    if (!isNativeVNode && (child.type === "span" || child.type === "p")) {
      const props = child.props as Parameters<typeof Text>[0];
      return visit(Text({ ...props, style: canonicalizeIntrinsicStyle(props.style) }), path, group);
    }
    if (!isNativeVNode && child.type === "img") {
      const props = child.props as Parameters<typeof Image>[0];
      return visit(Image({ ...props, style: canonicalizeIntrinsicStyle(props.style) }), path, group);
    }
    if (!isNativeVNode && child.type === "input") {
      const props = child.props as Parameters<typeof Input>[0];
      return visit(Input({ ...props, style: canonicalizeIntrinsicStyle(props.style) }), path, group);
    }
    if (!isNativeVNode && child.type === "textarea") {
      const props = child.props as Parameters<typeof TextArea>[0];
      return visit(TextArea({ ...props, style: canonicalizeIntrinsicStyle(props.style) }), path, group);
    }
    if (!isNativeVNode && child.type === "button") {
      const props = child.props as Parameters<typeof Button>[0];
      return visit(Button({ ...props, style: canonicalizeIntrinsicStyle(props.style) }), path, group);
    }
    if (!isNativeVNode && child.type === "a") {
      const { ariaLabel, style, ...props } = child.props as IntrinsicAnchorProps;
      return visit(Link({
        ...props,
        label: ariaLabel,
        style: canonicalizeIntrinsicStyle(style),
      }), path, group);
    }
    if (!isNativeVNode && child.type === "svg") {
      const props = child.props as Parameters<typeof Svg>[0];
      return visit(Svg({ ...props, style: canonicalizeIntrinsicStyle(props.style) }), path, group);
    }
    if (!isNativeVNode && typeof child.type === "string" && svgIntrinsicElements.has(child.type)) {
      throw new Error(`SVG element <${child.type}> must be a child of <svg>.`);
    }
    if (!isNativeVNode && child.type === "label") {
      const { htmlFor, ...rawProps } = child.props;
      const id = rawProps.id ?? path;
      if (htmlFor) {
        const labels = labelAssociations.get(String(htmlFor)) ?? [];
        labels.push(String(id));
        labelAssociations.set(String(htmlFor), labels);
      }
      const props = rawProps as Parameters<typeof Label>[0];
      return visit(Label({ ...props, id: String(id), style: canonicalizeIntrinsicStyle(props.style) }), path, group);
    }
    if (!isNativeVNode && child.type === "select") {
      const { children, onChange, onValueChange, ...rawProps } = child.props;
      const id = String(rawProps.id ?? path);
      const optionNodes = Array.isArray(children) ? children.flat(Infinity) : [children];
      const options = optionNodes
        .filter(option => option != null && option !== false && option !== true)
        .map(option => {
          if (typeof option !== "object" || Array.isArray(option) || option.type !== "option") {
            throw new Error("select children must be option elements.");
          }
          if (option.props.value === undefined) throw new Error("option requires a value.");
          return {
            value: String(option.props.value),
            label: textContent(option.props.children),
            disabled: option.props.disabled === true,
          };
        });
      labelableTargets.set(id, `${id}-trigger`);
      const props = rawProps as Omit<Parameters<typeof Select>[0], "options" | "id" | "onValueChange">;
      return visit(Select({
        ...props,
        id,
        options,
        style: canonicalizeIntrinsicStyle(props.style),
        onValueChange: (value) => {
          onValueChange?.(value);
          onChange?.(value);
        },
      }), path, group);
    }
    if (!isNativeVNode && child.type === "option") {
      throw new Error("option must be a direct child of select.");
    }
    if (!isNativeVNode && child.type === "progress") {
      const props = child.props as Parameters<typeof Progress>[0];
      return visit(Progress({ ...props, style: canonicalizeIntrinsicStyle(props.style) }), path, group);
    }
    if (!isNativeVNode && child.type === "hr") {
      const props = child.props as Parameters<typeof Separator>[0];
      return visit(Separator({ ...props, style: canonicalizeIntrinsicStyle(props.style) }), path, group);
    }
    const isIntrinsicDiv = child.type === "div";
    const nativeType = isIntrinsicDiv ? "view" : child.type;
    if (!kinds.has(nativeType)) throw new Error(`Unknown native component: ${child.type}`);
    const p = child.props;
    const id = p.id ?? path;
    if (ids.has(id)) throw new Error(`Duplicate node id: ${id}`);
    ids.add(id);
    if (nativeType === "window") {
      if (windowOptions) throw new Error("This bootstrap supports one Window per app.");
      selectedTheme = p.theme ?? lightTheme;
      windowOptions = { title: p.title ?? "Tarve", width: p.width ?? 1120, height: p.height ?? 820,
        minWidth: p.minWidth ?? 780, minHeight: p.minHeight ?? 580,
        background: resolveThemeColor(p.style?.background ?? theme.colors.background, selectedTheme),
        decorations: true, resizable: p.resizable ?? true, position: p.position ?? "center", debug, visible };
    }
    const hoverHandler = isIntrinsicDiv && (p.onMouseEnter || p.onMouseLeave)
      ? (entered: boolean) => {
          p.onHover?.(entered);
          if (entered) p.onMouseEnter?.();
          else p.onMouseLeave?.();
        }
      : p.onHover;
    handlers.set(id, { onClick: p.onClick, onMarkdownLink: p.onMarkdownLink, onDiffToggleFile: p.onToggleFile, onDiffShowMore: p.onShowMore, onDiffLineClick: p.onLineClick, onHighlight: p.onHighlight, onContextMenu: p.onContextMenu, onOutsideClick: p.onOutsideClick, onHover: hoverHandler, onChange: p.onChange, onValueChange: p.onValueChange, onScroll: p.onScroll, onScrollPosition: p.onScrollPosition, onVirtualListLayout: p.onVirtualListLayout, onVirtualListScrollToItem: p.onVirtualListScrollToItem, onVirtualListFocus: p.onVirtualListFocus, onEscape: p.onEscape, onKeyDown: p.onKeyDown, onBlur: p.onBlur, onCloseRequest: p.onCloseRequest });
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
    const divShorthands = isIntrinsicDiv
      ? Object.fromEntries(
          Object.entries({ gap: p.gap, padding: p.padding, flex: p.flex, align: p.align, justify: p.justify })
            .filter(([, value]) => value !== undefined),
        )
      : {};
    const rawStyle = isIntrinsicDiv
      ? { ...divShorthands, ...canonicalizeIntrinsicStyle(p.style) }
      : { ...p.style };
    if ((interactiveKinds.has(nativeType) && p.focusable !== false) || control?.role === "otpSlot") {
      rawStyle.focusVisible = {
        outlineColor: theme.colors.ring,
        ...lightTheme.focusOutline,
        ...selectedTheme.focusOutline,
        ...focusOutlineOverrides(p.style?.focus),
        ...p.style?.focusVisible,
      };
    }
    const style = resolveThemeStyle(rawStyle, selectedTheme);
    for (const key of ["padding", "margin"] as const) {
      if (style[key] && typeof style[key] === "object") style[key] = { ...style[key] };
    }
    const imageSource = nativeType === "image" && p.src !== undefined
      ? serializeImageSource(p.src)
      : undefined;
    const node: NativeNode = { id, kind: nativeType as NativeNode["kind"], style,
      children: isText || isRichLeaf ? [] : visit(p.children, `${path}/children`, childGroup),
      ...(isText ? { text: textContent(p.children) } : {}),
      ...(nativeType === "code" ? { text: p.code } : {}),
      ...(nativeType === "markdown" || nativeType === "diff" ? { source: p.source } : {}),
      ...(p.language !== undefined ? { language: p.language } : {}),
      ...(p.path !== undefined ? { path: p.path } : {}),
      ...(p.showLineNumbers !== undefined ? { showLineNumbers: p.showLineNumbers } : {}),
      ...(p.wordDiff !== undefined ? { wordDiff: p.wordDiff } : {}),
      ...(p.collapsedPaths !== undefined ? { collapsedPaths: [...p.collapsedPaths] } : {}),
      ...(p.maxLines !== undefined ? { maxLines: p.maxLines } : {}),
      ...(p.highlight !== undefined ? { highlight: p.highlight } : {}),
      ...(isRichLeaf ? { syntaxTheme: { ...selectedTheme.syntax, ...p.syntaxTheme } } : {}),
      ...(p.oldText !== undefined ? { oldText: p.oldText } : {}),
      ...(p.newText !== undefined ? { newText: p.newText } : {}),
      ...(p.svg !== undefined ? { svg: p.svg } : {}),
      ...(control ? { control } : {}),
      ...(imageSource && "path" in imageSource
        ? { src: nativeAssetPath(imageSource.path), fit: p.fit ?? "cover" }
        : imageSource ? { image: imageSource.image, fit: p.fit ?? "cover" } : {}),
      ...(p.value !== undefined ? { value: p.value } : {}),
      ...(p.placeholder !== undefined ? { placeholder: p.placeholder } : {}),
      ...(p.inputType !== undefined ? { inputType: p.inputType } : {}),
      ...(p.scrollSpeed !== undefined ? { scrollSpeed: p.scrollSpeed } : {}),
      ...(p.scrollOrientation !== undefined ? { scrollOrientation: p.scrollOrientation } : {}),
      ...(p.virtualList !== undefined ? { virtualList: p.virtualList } : {}),
      ...(p.disabled !== undefined ? { disabled: p.disabled } : {}),
      ...(p.modal !== undefined ? { modal: p.modal } : {}),
      ...(rovingGroup ? { rovingGroup } : {}),
      ...(p.portal !== undefined ? { portal: p.portal } : {}),
      ...(p.dismissOnOutside !== undefined ? { dismissOnOutside: p.dismissOnOutside } : {}),
      ...(nativeType === "window" && p.onCloseRequest !== undefined ? { closeIntercept: true } : {}),
      ...(p.focusable !== undefined ? { focusable: p.focusable } : {}),
      ...(p.dragRegion !== undefined ? { dragRegion: p.dragRegion } : {}),
      ...(p.windowAction !== undefined ? { windowAction: p.windowAction } : {}),
    };
    if (nativeType === "input" || nativeType === "textarea") labelableTargets.set(id, id);
    nodes.set(id, node);
    return [node];
  }
  const roots = withRenderScope(renderScope, () => visit(element, "root"));
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
    roots[0].style.borderColor ??= selectedTheme.colors.border;
    roots[0].style.radius ??= theme.radius.md;
  }
  return { document: { version: PROTOCOL_VERSION, renderer, window: windowOptions, root: roots[0] }, handlers, nodes };
}

function sameValue(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (!a || !b || typeof a !== "object" || typeof b !== "object") return false;
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
    return a.every((value, index) => sameValue(value, b[index]));
  }
  const left = a as Record<string, unknown>;
  const right = b as Record<string, unknown>;
  const keys = Object.keys(left);
  return keys.length === Object.keys(right).length && keys.every(key => sameValue(left[key], right[key]));
}
function sameFields(a: object, b: object): boolean {
  return sameValue(a, b);
}
function sameStyle(a: NativeNode["style"], b: NativeNode["style"]): boolean {
  return sameValue(a, b);
}

function sameChildren(a: NativeNode, b: NativeNode): boolean {
  return a.children.length === b.children.length
    && a.children.every((child, index) => child.id === b.children[index]?.id);
}

function nodePropertiesChanged(old: NativeNode, node: NativeNode): boolean {
  return old.text !== node.text || old.source !== node.source || old.language !== node.language || old.path !== node.path
    || old.showLineNumbers !== node.showLineNumbers || !sameValue(old.syntaxTheme, node.syntaxTheme)
    || old.wordDiff !== node.wordDiff || !sameValue(old.collapsedPaths, node.collapsedPaths) || old.maxLines !== node.maxLines
    || old.oldText !== node.oldText || old.newText !== node.newText
    || old.src !== node.src || old.fit !== node.fit || !sameValue(old.svg, node.svg)
    || old.value !== node.value || old.placeholder !== node.placeholder || old.inputType !== node.inputType || old.scrollSpeed !== node.scrollSpeed || old.scrollOrientation !== node.scrollOrientation || !sameValue(old.virtualList, node.virtualList) || old.disabled !== node.disabled
    || old.modal !== node.modal || old.rovingGroup !== node.rovingGroup || old.portal !== node.portal || old.dismissOnOutside !== node.dismissOnOutside || !sameValue(old.labelledBy, node.labelledBy) || old.closeIntercept !== node.closeIntercept || old.focusable !== node.focusable
    || old.dragRegion !== node.dragRegion || old.windowAction !== node.windowAction
    || !sameValue(old.highlight, node.highlight)
    || !sameFields(old.control ?? {}, node.control ?? {})
    || !sameStyle(old.style, node.style);
}

function flatNode(node: NativeNode): NativeNode {
  return { ...node, children: [] };
}

/** null requests a structural replacement; an empty list means no native work is needed. */
export function diffTrees(previous: CompiledTree, next: CompiledTree): NativeNode[] | null {
  if (previous.nodes.size !== next.nodes.size || previous.document.root.id !== next.document.root.id) return null;
  const changed: NativeNode[] = [];
  for (const [id, node] of next.nodes) {
    const old = previous.nodes.get(id);
    if (!old || old.kind !== node.kind || !sameChildren(old, node)) return null;
    if (nodePropertiesChanged(old, node)) changed.push(flatNode(node));
  }
  return changed;
}

/**
 * Computes one atomic retained-tree mutation batch. A null result is reserved for
 * identity-incompatible replacements (root ID or an existing keyed node kind changed).
 */
export function diffTreeMutations(previous: CompiledTree, next: CompiledTree): TreeMutation[] | null {
  if (previous.document.root.id !== next.document.root.id) return null;

  const creates: TreeMutation[] = [];
  const patches: TreeMutation[] = [];
  const children: TreeMutation[] = [];
  const removes: TreeMutation[] = [];

  for (const [id, node] of next.nodes) {
    const old = previous.nodes.get(id);
    if (!old) {
      creates.push({ type: "create", node: flatNode(node) });
      if (node.children.length > 0) {
        children.push({ type: "children", id, children: node.children.map(child => child.id) });
      }
      continue;
    }
    if (old.kind !== node.kind) return null;
    if (nodePropertiesChanged(old, node)) patches.push({ type: "patch", node: flatNode(node) });
    if (!sameChildren(old, node)) {
      children.push({ type: "children", id, children: node.children.map(child => child.id) });
    }
  }

  for (const id of previous.nodes.keys()) {
    if (!next.nodes.has(id)) removes.push({ type: "remove", id });
  }

  return [...creates, ...patches, ...children, ...removes];
}
