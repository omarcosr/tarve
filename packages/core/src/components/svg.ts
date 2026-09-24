import type { SvgAttributes, SvgNode } from "../../../protocol/src/index";
import { Fragment, jsx, type BaseProps, type Child, type VNode } from "../jsx-runtime";
import { theme } from "../theme";

const SVG_ELEMENT = "__tarve_svg_element";

export interface SvgProps extends BaseProps {
  size?: number;
  width?: number;
  height?: number;
  viewBox?: string | readonly [number, number, number, number];
  color?: string;
  fill?: string;
  stroke?: string;
  strokeWidth?: number;
  strokeLinecap?: "butt" | "round" | "square";
  strokeLinejoin?: "miter" | "round" | "bevel";
  nodes?: readonly SvgNode[];
}

interface SvgElementProps {
  [key: string]: SvgAttributes[string] | undefined;
}

export interface PathProps extends SvgElementProps { d: string }
export interface CircleProps extends SvgElementProps { cx: number | string; cy: number | string; r: number | string }
export interface EllipseProps extends SvgElementProps { cx: number | string; cy: number | string; rx: number | string; ry: number | string }
export interface LineProps extends SvgElementProps { x1: number | string; y1: number | string; x2: number | string; y2: number | string }
export interface PolylineProps extends SvgElementProps { points: string }
export interface PolygonProps extends SvgElementProps { points: string }
export interface RectProps extends SvgElementProps {
  x?: number | string; y?: number | string; width: number | string; height: number | string;
  rx?: number | string; ry?: number | string;
}

function element(tag: SvgNode[0], attrs: SvgElementProps): VNode {
  const clean: SvgAttributes = {};
  for (const [key, value] of Object.entries(attrs)) {
    if (value !== undefined) clean[key] = value;
  }
  return jsx(SVG_ELEMENT, { tag, attrs: clean });
}

export const Path = (props: PathProps): VNode => element("path", props);
export const Circle = (props: CircleProps): VNode => element("circle", props);
export const Ellipse = (props: EllipseProps): VNode => element("ellipse", props);
export const Line = (props: LineProps): VNode => element("line", props);
export const Polyline = (props: PolylineProps): VNode => element("polyline", props);
export const Polygon = (props: PolygonProps): VNode => element("polygon", props);
export const SvgRect = (props: RectProps): VNode => element("rect", props);

function collect(value: Child, result: SvgNode[]): void {
  if (value == null || typeof value === "boolean") return;
  if (Array.isArray(value)) {
    for (const child of value) collect(child, result);
    return;
  }
  if (typeof value === "string" || typeof value === "number") throw new Error("Svg cannot contain text nodes.");
  if (value.type === Fragment || value.type === "fragment") {
    collect(value.props.children, result);
    return;
  }
  if (typeof value.type === "function") {
    collect(value.type(value.props), result);
    return;
  }
  if (value.type !== SVG_ELEMENT) throw new Error("Svg children must be Path, Circle, Ellipse, Line, Polyline, Polygon or SvgRect.");
  result.push([value.props.tag as SvgNode[0], { ...value.props.attrs }]);
}

function normalizeViewBox(viewBox: SvgProps["viewBox"]): readonly [number, number, number, number] {
  if (!viewBox) return [0, 0, 24, 24];
  if (Array.isArray(viewBox)) {
    if (viewBox.length !== 4 || viewBox.some(value => !Number.isFinite(value))) throw new Error("Svg viewBox must contain four finite numbers.");
    return [viewBox[0], viewBox[1], viewBox[2], viewBox[3]];
  }
  const values = String(viewBox).trim().split(/[\s,]+/).map(Number);
  if (values.length !== 4 || values.some(value => !Number.isFinite(value))) throw new Error("Invalid Svg viewBox: " + viewBox);
  return values as [number, number, number, number];
}

function xmlEscape(value: SvgAttributes[string]): string {
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

function serializeSvg(
  viewBox: readonly [number, number, number, number],
  fill: string,
  stroke: string,
  strokeWidth: number,
  strokeLinecap: "butt" | "round" | "square",
  strokeLinejoin: "miter" | "round" | "bevel",
  nodes: readonly SvgNode[],
): string {
  const [, , width, height] = viewBox;
  if (!(width > 0) || !(height > 0)) throw new Error("Svg viewBox width/height must be positive.");
  return [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}"`,
    ` viewBox="${viewBox.join(" ")}" color="#000000" data-tarve-current-color="1"`,
    ` fill="${xmlEscape(fill)}" stroke="${xmlEscape(stroke)}" stroke-width="${strokeWidth}"`,
    ` stroke-linecap="${strokeLinecap}" stroke-linejoin="${strokeLinejoin}">`,
    nodes.map(serializeSvgNode).join(""),
    "</svg>",
  ].join("");
}

export function Svg({
  size, width, height, viewBox, color = theme.colors.foreground, fill = "none", stroke = "currentColor",
  strokeWidth = 2, strokeLinecap = "round", strokeLinejoin = "round", nodes = [], children, style, ...props
}: SvgProps): VNode {
  const elements = [...nodes];
  collect(children, elements);
  const normalizedViewBox = normalizeViewBox(viewBox);
  return jsx("svg", {
    ...props,
    style: { width: size ?? width ?? 24, height: size ?? height ?? 24, shrink: 0, foreground: color, ...style },
    svg: serializeSvg(normalizedViewBox, fill, stroke, strokeWidth, strokeLinecap, strokeLinejoin, elements),
  });
}

export type { SvgAttributes, SvgNode };
