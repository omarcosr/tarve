import { REACT_FORWARD_REF, finiteNumber, reactSvgElementToTarve, record, type ComponentAdapter, type SvgAttributes, type SvgNode } from "./react-svg";

const SVG_ELEMENTS = new Set(["path", "circle", "ellipse", "g", "line", "polygon", "polyline", "rect"]);
type LucideData = {
  node: readonly unknown[];
  size?: number;
  width?: number;
  height?: number;
};

function normalizeNode(value: unknown, nonScalingStroke: boolean): SvgNode | undefined {
  if (!Array.isArray(value) || value.length < 2) return undefined;
  const [tag, rawAttrs, rawChildren] = value;
  if (typeof tag !== "string" || !SVG_ELEMENTS.has(tag)) return undefined;
  const attrsRecord = record(rawAttrs);
  if (!attrsRecord) return undefined;
  const attrs: SvgAttributes = {};
  for (const [name, rawValue] of Object.entries(attrsRecord)) {
    if (name === "key") continue;
    if (typeof rawValue === "string" || typeof rawValue === "number") attrs[name] = rawValue;
  }
  if (nonScalingStroke) attrs.vectorEffect = "non-scaling-stroke";

  if (rawChildren === undefined) return [tag as SvgNode[0], attrs];
  if (!Array.isArray(rawChildren)) return undefined;
  const children: SvgNode[] = [];
  for (const child of rawChildren) {
    const normalized = normalizeNode(child, nonScalingStroke);
    if (!normalized) return undefined;
    children.push(normalized);
  }
  return [tag as SvgNode[0], attrs, children];
}

function lucideData(value: unknown): LucideData | undefined {
  const candidate = record(value);
  if (!candidate || !Array.isArray(candidate.node)) return undefined;
  return {
    node: candidate.node,
    size: finiteNumber(candidate.size),
    width: finiteNumber(candidate.width),
    height: finiteNumber(candidate.height),
  };
}

export const lucideReactAdapter: ComponentAdapter = ({ type, props }) => {
  const component = record(type);
  if (component?.$$typeof !== REACT_FORWARD_REF || typeof component.render !== "function") return undefined;

  let rendered: unknown;
  try {
    rendered = (component.render as (props: Record<string, unknown>, ref: null) => unknown)({ ...props }, null);
  } catch {
    return undefined;
  }
  const renderedProps = record(record(rendered)?.props);
  const icon = lucideData(renderedProps?.icon);
  if (!renderedProps || !icon) return undefined;

  const nodes: SvgNode[] = [];
  for (const child of icon.node) {
    const node = normalizeNode(child, renderedProps.nonScalingStroke === true);
    if (!node) return undefined;
    nodes.push(node);
  }

  const baseWidth = icon.size ?? icon.width ?? 24;
  const baseHeight = icon.size ?? icon.height ?? 24;
  const size = finiteNumber(renderedProps.size);
  const width = finiteNumber(renderedProps.width) ?? size ?? baseWidth;
  const height = finiteNumber(renderedProps.height) ?? size ?? baseHeight;
  const requestedStrokeWidth = finiteNumber(renderedProps.strokeWidth) ?? 2;
  const strokeWidth = renderedProps.absoluteStrokeWidth === true
    ? requestedStrokeWidth * baseWidth / (size ?? width)
    : requestedStrokeWidth;
  const explicitColor = typeof renderedProps.color === "string" ? renderedProps.color : undefined;

  return reactSvgElementToTarve({
    type: "svg",
    props: {
      ...(typeof renderedProps.id === "string" ? { id: renderedProps.id } : {}),
      width,
      height,
      viewBox: `0 0 ${baseWidth} ${baseHeight}`,
      color: explicitColor ?? "currentColor",
      fill: typeof renderedProps.fill === "string" ? renderedProps.fill : "none",
      stroke: typeof renderedProps.stroke === "string" ? renderedProps.stroke : "currentColor",
      strokeWidth,
      strokeLinecap: renderedProps.strokeLinecap === "butt" || renderedProps.strokeLinecap === "square" ? renderedProps.strokeLinecap : "round",
      strokeLinejoin: renderedProps.strokeLinejoin === "miter" || renderedProps.strokeLinejoin === "bevel" ? renderedProps.strokeLinejoin : "round",
      children: nodes.map(([tag, attrs, children]) => ({
        type: tag,
        props: { ...attrs, ...(children ? { children: toReactLike(children) } : {}) },
      })),
    },
  });
};

function toReactLike(nodes: readonly SvgNode[]): unknown[] {
  return nodes.map(([tag, attrs, children]) => ({
    type: tag,
    props: { ...attrs, ...(children ? { children: toReactLike(children) } : {}) },
  }));
}
