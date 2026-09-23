import { PROTOCOL_VERSION, type NativeNode, type Renderer, type SceneDocument, type ScrollPosition, type WindowOptions } from "../../protocol/src/index";
import { Fragment, type Child, type VNode } from "./jsx-runtime";
import { lightTheme, resolveThemeColor, resolveThemeStyle, theme, type ThemeDefinition } from "./theme";
import { nativeAssetPath } from "#tarve/assets";
import type { WindowCloseRequestEvent } from "./components";
export interface Handlers { onClick?: () => void; onContextMenu?: (position: { x: number; y: number }) => void; onOutsideClick?: () => void; onHover?: (value: boolean) => void; onChange?: (value: string) => void; onValueChange?: (value: number) => void; onScroll?: (offset: number, max: number) => void; onScrollPosition?: (position: ScrollPosition) => void; onEscape?: () => void; onKeyDown?: (key: string) => void; onBlur?: () => void; onCloseRequest?: (event: WindowCloseRequestEvent) => void }
export interface CompiledTree { document: SceneDocument; handlers: Map<string, Handlers>; nodes: Map<string, NativeNode> }
const kinds = new Set(["window", "titlebar", "view", "row", "column", "text", "button", "image", "scroll", "input", "textarea", "pressable", "icon", "slider", "splitter"]);
const interactiveKinds = new Set(["button", "input", "textarea", "pressable", "slider", "splitter"]);
function textContent(value: Child): string {
  if (Array.isArray(value)) return value.map(textContent).join("");
  if (value == null || typeof value === "boolean") return "";
  if (typeof value === "object") throw new Error("Text/Button children must be strings or numbers.");
  return String(value);
}
export function compileTree(element: VNode, debug = false, renderer: Renderer = "auto"): CompiledTree {
  const handlers = new Map<string, Handlers>();
  const ids = new Set<string>();
  const nodes = new Map<string, NativeNode>();
  let windowOptions: WindowOptions | undefined;
  let selectedTheme: ThemeDefinition = lightTheme;
  function visit(child: Child, path: string, group?: string): NativeNode[] {
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
    if (typeof child.type === "function") return visit(child.type(child.props), path, group);
    if (!kinds.has(child.type)) throw new Error(`Unknown native component: ${child.type}`);
    const p = child.props;
    const id = p.id ?? path;
    if (ids.has(id)) throw new Error(`Duplicate node id: ${id}`);
    ids.add(id);
    if (child.type === "window") {
      if (windowOptions) throw new Error("This bootstrap supports one Window per app.");
      selectedTheme = p.theme ?? lightTheme;
      windowOptions = { title: p.title ?? "Tarve", width: p.width ?? 1120, height: p.height ?? 820,
        minWidth: p.minWidth ?? 780, minHeight: p.minHeight ?? 580,
        background: resolveThemeColor(p.style?.background ?? theme.colors.background, selectedTheme),
        decorations: true, resizable: p.resizable ?? true, position: p.position ?? "center", debug };
    }
    handlers.set(id, { onClick: p.onClick, onContextMenu: p.onContextMenu, onOutsideClick: p.onOutsideClick, onHover: p.onHover, onChange: p.onChange, onValueChange: p.onValueChange, onScroll: p.onScroll, onScrollPosition: p.onScrollPosition, onEscape: p.onEscape, onKeyDown: p.onKeyDown, onBlur: p.onBlur, onCloseRequest: p.onCloseRequest });
    const control = p.control ? { ...p.control } : undefined;
    const childGroup = control?.role === "radiogroup" || control?.role === "tablist" || control?.role === "navigation" || control?.role === "togglegroup"
      || control?.role === "tree" || control?.role === "grid" ? id : group;
    const semanticRoving = control && (control.role === "radio" || control.role === "tab" || control.role === "menuitem" || control.role === "toggle"
      || control.role === "treeitem" || control.role === "row");
    if ((semanticRoving || p.rovingGroup === true) && control) control.group = group;
    const rovingGroup = group && (p.rovingGroup === true || semanticRoving) ? group : undefined;
    const isText = child.type === "text" || child.type === "button";
    const rawStyle = { ...p.style };
    if ((interactiveKinds.has(child.type) && p.focusable !== false) || control?.role === "otpSlot") {
      rawStyle.focus = {
        outlineColor: theme.colors.ring,
        ...lightTheme.focusOutline,
        ...selectedTheme.focusOutline,
        ...p.style?.focus,
      };
    }
    const style = resolveThemeStyle(rawStyle, selectedTheme);
    for (const key of ["padding", "margin"] as const) {
      if (style[key] && typeof style[key] === "object") style[key] = { ...style[key] };
    }
    const node: NativeNode = { id, kind: child.type as NativeNode["kind"], style,
      children: isText ? [] : visit(p.children, `${path}/children`, childGroup),
      ...(isText ? { text: textContent(p.children) } : {}),
      ...(child.type === "icon" ? { text: p.name } : {}),
      ...(control ? { control } : {}),
      ...(p.src !== undefined ? { src: nativeAssetPath(p.src), fit: p.fit ?? "cover" } : {}),
      ...(p.value !== undefined ? { value: p.value } : {}),
      ...(p.placeholder !== undefined ? { placeholder: p.placeholder } : {}),
      ...(p.inputType !== undefined ? { inputType: p.inputType } : {}),
      ...(p.scrollSpeed !== undefined ? { scrollSpeed: p.scrollSpeed } : {}),
      ...(p.scrollOrientation !== undefined ? { scrollOrientation: p.scrollOrientation } : {}),
      ...(p.disabled !== undefined ? { disabled: p.disabled } : {}),
      ...(p.modal !== undefined ? { modal: p.modal } : {}),
      ...(rovingGroup ? { rovingGroup } : {}),
      ...(p.portal !== undefined ? { portal: p.portal } : {}),
      ...(p.dismissOnOutside !== undefined ? { dismissOnOutside: p.dismissOnOutside } : {}),
      ...(child.type === "window" && p.onCloseRequest !== undefined ? { closeIntercept: true } : {}),
      ...(p.focusable !== undefined ? { focusable: p.focusable } : {}),
      ...(p.dragRegion !== undefined ? { dragRegion: p.dragRegion } : {}),
      ...(p.windowAction !== undefined ? { windowAction: p.windowAction } : {}),
    };
    nodes.set(id, node);
    return [node];
  }
  const roots = visit(element, "root");
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

/** null requests a structural replacement; an empty list means no native work is needed. */
export function diffTrees(previous: CompiledTree, next: CompiledTree): NativeNode[] | null {
  if (previous.nodes.size !== next.nodes.size || previous.document.root.id !== next.document.root.id) return null;
  const changed: NativeNode[] = [];
  for (const [id, node] of next.nodes) {
    const old = previous.nodes.get(id);
    if (!old || old.kind !== node.kind || old.children.length !== node.children.length
      || old.children.some((child, index) => child.id !== node.children[index].id)) return null;
    if (old.text !== node.text || old.src !== node.src || old.fit !== node.fit
      || old.value !== node.value || old.placeholder !== node.placeholder || old.inputType !== node.inputType || old.scrollSpeed !== node.scrollSpeed || old.scrollOrientation !== node.scrollOrientation || old.disabled !== node.disabled
      || old.modal !== node.modal || old.rovingGroup !== node.rovingGroup || old.portal !== node.portal || old.dismissOnOutside !== node.dismissOnOutside || old.closeIntercept !== node.closeIntercept || old.focusable !== node.focusable
      || old.dragRegion !== node.dragRegion || old.windowAction !== node.windowAction
      || !sameFields(old.control ?? {}, node.control ?? {})
      || !sameStyle(old.style, node.style)) {
      changed.push({ ...node, children: [] });
    }
  }
  return changed;
}
