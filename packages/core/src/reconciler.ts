import { PROTOCOL_VERSION, type NativeNode, type SceneDocument, type WindowOptions } from "../../protocol/src/index";
import { Fragment, type Child, type VNode } from "./jsx-runtime";
import { theme } from "./theme";
import { nativeAssetPath } from "#tarve/assets";
export interface Handlers { onClick?: () => void; onHover?: (value: boolean) => void; onChange?: (value: string) => void; onValueChange?: (value: number) => void; onEscape?: () => void }
export interface CompiledTree { document: SceneDocument; handlers: Map<string, Handlers>; nodes: Map<string, NativeNode> }
const kinds = new Set(["window", "view", "row", "column", "text", "button", "image", "scroll", "input", "pressable", "icon", "slider"]);
function textContent(value: Child): string {
  if (Array.isArray(value)) return value.map(textContent).join("");
  if (value == null || typeof value === "boolean") return "";
  if (typeof value === "object") throw new Error("Text/Button children must be strings or numbers.");
  return String(value);
}
export function compileTree(element: VNode, debug = false): CompiledTree {
  const handlers = new Map<string, Handlers>();
  const ids = new Set<string>();
  const nodes = new Map<string, NativeNode>();
  let windowOptions: WindowOptions | undefined;
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
      windowOptions = { title: p.title ?? "Tarve", width: p.width ?? 1120, height: p.height ?? 820,
        minWidth: p.minWidth ?? 780, minHeight: p.minHeight ?? 580, background: p.style?.background ?? theme.colors.background, debug };
    }
    handlers.set(id, { onClick: p.onClick, onHover: p.onHover, onChange: p.onChange, onValueChange: p.onValueChange, onEscape: p.onEscape });
    const control = p.control ? { ...p.control } : undefined;
    const childGroup = control?.role === "radiogroup" || control?.role === "tablist" ? id : group;
    if (control && (control.role === "radio" || control.role === "tab")) control.group = group;
    const isText = child.type === "text" || child.type === "button";
    const style = { ...p.style };
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
      ...(p.disabled !== undefined ? { disabled: p.disabled } : {}),
      ...(p.modal !== undefined ? { modal: p.modal } : {}),
      ...(p.focusable !== undefined ? { focusable: p.focusable } : {}),
    };
    nodes.set(id, node);
    return [node];
  }
  const roots = visit(element, "root");
  if (roots.length !== 1 || roots[0].kind !== "window" || !windowOptions) throw new Error("render() requires one Window root.");
  return { document: { version: PROTOCOL_VERSION, window: windowOptions, root: roots[0] }, handlers, nodes };
}

function sameFields(a: object, b: object): boolean {
  const keys = Object.keys(a);
  return keys.length === Object.keys(b).length && keys.every(key => Reflect.get(a, key) === Reflect.get(b, key));
}
function sameStyle(a: NativeNode["style"], b: NativeNode["style"]): boolean {
  const keys = Object.keys(a) as (keyof NativeNode["style"])[];
  return keys.length === Object.keys(b).length && keys.every(key => {
    const left = a[key], right = b[key];
    return left === right || (!!left && !!right && typeof left === "object" && typeof right === "object" && sameFields(left, right));
  });
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
      || old.value !== node.value || old.placeholder !== node.placeholder || old.disabled !== node.disabled
      || old.modal !== node.modal || old.focusable !== node.focusable
      || !sameFields(old.control ?? {}, node.control ?? {})
      || !sameStyle(old.style, node.style)) {
      changed.push({ ...node, children: [] });
    }
  }
  return changed;
}
