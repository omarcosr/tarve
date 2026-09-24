import { REACT_FORWARD_REF, finiteNumber, reactSvgElementToTarve, record, type ComponentAdapter } from "./react-svg";

const WEIGHTS = new Set(["thin", "light", "regular", "bold", "fill", "duotone"]);

export const phosphorReactAdapter: ComponentAdapter = ({ type, props }) => {
  const component = record(type);
  if (component?.$$typeof !== REACT_FORWARD_REF || typeof component.render !== "function") return undefined;

  let rendered: unknown;
  try {
    rendered = (component.render as (props: Record<string, unknown>, ref: null) => unknown)({ ...props }, null);
  } catch {
    return undefined;
  }
  const renderedProps = record(record(rendered)?.props);
  if (!renderedProps || !(renderedProps.weights instanceof Map)) return undefined;
  const requestedWeight = typeof renderedProps.weight === "string" && WEIGHTS.has(renderedProps.weight)
    ? renderedProps.weight
    : "regular";
  const weightNode = renderedProps.weights.get(requestedWeight);
  if (!weightNode) return undefined;
  const size = finiteNumber(renderedProps.size) ?? 24;
  const color = typeof renderedProps.color === "string" ? renderedProps.color : "currentColor";
  const mirrored = renderedProps.mirrored === true;

  return reactSvgElementToTarve({
    type: "svg",
    props: {
      ...(typeof renderedProps.id === "string" ? { id: renderedProps.id } : {}),
      width: size,
      height: size,
      viewBox: "0 0 256 256",
      fill: color,
      color,
      ...(mirrored ? { transform: "translate(256 0) scale(-1 1)" } : {}),
      children: [renderedProps.children, weightNode],
    },
  });
};
