export type SvgElementName = "path" | "circle" | "ellipse" | "g" | "line" | "polygon" | "polyline" | "rect";
export type SvgAttributes = Record<string, string | number>;
export type SvgNode =
  | readonly [SvgElementName, SvgAttributes]
  | readonly [SvgElementName, SvgAttributes, readonly SvgNode[]];
export interface TarveVNode {
  type: string | ((props: Record<string, any>) => TarveVNode);
  props: Record<string, any>;
  key?: string | number;
}
export interface ComponentAdapterInput {
  type: unknown;
  props: Readonly<Record<string, unknown>>;
  key?: string | number;
}
export type ComponentAdapter = (component: ComponentAdapterInput) => TarveVNode | undefined;

export const REACT_FORWARD_REF = Symbol.for("react.forward_ref");
const REACT_FRAGMENT = Symbol.for("react.fragment");
const SVG_ELEMENTS = new Set(["path", "circle", "ellipse", "g", "line", "polygon", "polyline", "rect"]);

export type RecordLike = Record<PropertyKey, unknown>;

export function record(value: unknown): RecordLike | undefined {
  return value !== null && typeof value === "object" ? value as RecordLike : undefined;
}

export function finiteNumber(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim() !== "" && Number.isFinite(Number(value))) return Number(value);
  return undefined;
}

function normalizeAttributes(value: unknown): SvgAttributes | undefined {
  const source = record(value);
  if (!source) return undefined;
  const attrs: SvgAttributes = {};
  for (const [name, rawValue] of Object.entries(source)) {
    if (name === "key" || name === "ref" || name === "children" || name === "className") continue;
    if (typeof rawValue === "string" || typeof rawValue === "number") attrs[name] = rawValue;
  }
  return attrs;
}

function collectReactSvgNodes(value: unknown, result: SvgNode[]): boolean {
  if (value == null || typeof value === "boolean") return true;
  if (Array.isArray(value)) return value.every(child => collectReactSvgNodes(child, result));
  const element = record(value);
  if (!element) return false;
  const type = element.type;
  const props = record(element.props);
  if (!props) return false;
  if (type === REACT_FRAGMENT) return collectReactSvgNodes(props.children, result);
  if (type === "title") return true;
  if (typeof type !== "string" || !SVG_ELEMENTS.has(type)) return false;
  const attrs = normalizeAttributes(props);
  if (!attrs) return false;
  const children: SvgNode[] = [];
  if (!collectReactSvgNodes(props.children, children)) return false;
  result.push(children.length
    ? [type as SvgNode[0], attrs, children]
    : [type as SvgNode[0], attrs]);
  return true;
}

function linecap(value: unknown): "butt" | "round" | "square" {
  return value === "round" || value === "square" ? value : "butt";
}

function linejoin(value: unknown): "miter" | "round" | "bevel" {
  return value === "round" || value === "bevel" ? value : "miter";
}

function xmlEscape(value: string | number): string {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("\"", "&quot;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}

function svgAttributeName(name: string): string {
  return name.replace(/[A-Z]/g, match => `-${match.toLowerCase()}`);
}

function serializeSvgNode([tag, attrs, children]: SvgNode): string {
  const attributes = Object.entries(attrs)
    .filter(([name]) => name !== "key")
    .map(([name, value]) => `${svgAttributeName(name)}="${xmlEscape(value)}"`)
    .join(" ");
  if (children?.length) {
    return `<${tag}${attributes ? ` ${attributes}` : ""}>${children.map(serializeSvgNode).join("")}</${tag}>`;
  }
  return `<${tag}${attributes ? ` ${attributes}` : ""}/>`;
}

function createSvgVNode(options: {
  id?: string;
  width: number;
  height: number;
  viewBox: string;
  color: string;
  fill: string;
  stroke: string;
  strokeWidth: number;
  strokeLinecap: "butt" | "round" | "square";
  strokeLinejoin: "miter" | "round" | "bevel";
  nodes: readonly SvgNode[];
}): TarveVNode {
  const viewBox = options.viewBox.trim().split(/[\s,]+/).map(Number);
  if (viewBox.length !== 4 || viewBox.some(value => !Number.isFinite(value)) || !(viewBox[2] > 0) || !(viewBox[3] > 0)) {
    throw new TypeError(`Invalid SVG viewBox: ${options.viewBox}`);
  }
  const svg = [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${viewBox[2]}" height="${viewBox[3]}"`,
    ` viewBox="${viewBox.join(" ")}" color="#000000" data-tarve-current-color="1"`,
    ` fill="${xmlEscape(options.fill)}" stroke="${xmlEscape(options.stroke)}" stroke-width="${options.strokeWidth}"`,
    ` stroke-linecap="${options.strokeLinecap}" stroke-linejoin="${options.strokeLinejoin}">`,
    options.nodes.map(serializeSvgNode).join(""),
    "</svg>",
  ].join("");
  return {
    type: "svg",
    props: {
      ...(options.id ? { id: options.id } : {}),
      style: { width: options.width, height: options.height, shrink: 0, foreground: options.color },
      svg,
    },
  };
}

export function reactSvgElementToTarve(value: unknown): TarveVNode | undefined {
  const element = record(value);
  const props = record(element?.props);
  if (element?.type !== "svg" || !props) return undefined;

  const nodes: SvgNode[] = [];
  if (!collectReactSvgNodes(props.children, nodes)) return undefined;
  const transform = typeof props.transform === "string" ? props.transform : undefined;
  const drawableNodes: readonly SvgNode[] = transform ? [["g", { transform }, nodes]] : nodes;
  const viewBox = typeof props.viewBox === "string" ? props.viewBox : "0 0 24 24";
  const viewBoxParts = viewBox.trim().split(/[\s,]+/).map(Number);
  const intrinsicWidth = viewBoxParts.length === 4 && Number.isFinite(viewBoxParts[2]) ? viewBoxParts[2] : 24;
  const intrinsicHeight = viewBoxParts.length === 4 && Number.isFinite(viewBoxParts[3]) ? viewBoxParts[3] : 24;
  const width = finiteNumber(props.width) ?? intrinsicWidth;
  const height = finiteNumber(props.height) ?? intrinsicHeight;
  const explicitColor = typeof props.color === "string" ? props.color : undefined;

  return createSvgVNode({
    ...(typeof props.id === "string" ? { id: props.id } : {}),
    width,
    height,
    viewBox,
    color: explicitColor && explicitColor !== "currentColor" ? explicitColor : "var(--foreground)",
    fill: typeof props.fill === "string" ? props.fill : "black",
    stroke: typeof props.stroke === "string" ? props.stroke : "none",
    strokeWidth: finiteNumber(props.strokeWidth) ?? 1,
    strokeLinecap: linecap(props.strokeLinecap),
    strokeLinejoin: linejoin(props.strokeLinejoin),
    nodes: drawableNodes,
  });
}

/** Generic adapter for React icon components whose forwardRef renders a static <svg>. */
export const reactSvgAdapter: ComponentAdapter = ({ type, props }) => {
  const component = record(type);
  if (component?.$$typeof !== REACT_FORWARD_REF || typeof component.render !== "function") return undefined;
  try {
    return reactSvgElementToTarve(
      (component.render as (props: Record<string, unknown>, ref: null) => unknown)({ ...props }, null),
    );
  } catch {
    return undefined;
  }
};
