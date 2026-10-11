import type { StateStyle, Style } from "../../protocol/src/index";
import type { IntrinsicStateStyle, IntrinsicStyle } from "./jsx-runtime";

function canonicalizeStateStyle(style: IntrinsicStateStyle | undefined): StateStyle | undefined {
  if (!style) return undefined;
  const result = { ...style } as IntrinsicStateStyle & Record<string, unknown>;
  if (result.background === undefined && result.backgroundColor !== undefined) result.background = result.backgroundColor;
  if (result.foreground === undefined && result.color !== undefined) result.foreground = result.color;
  delete result.backgroundColor;
  delete result.color;
  return result as StateStyle;
}

export function canonicalizeIntrinsicStyle(style: IntrinsicStyle | undefined): Style {
  const result = { ...style } as IntrinsicStyle & Record<string, unknown>;
  if (result.direction === undefined && result.flexDirection !== undefined) result.direction = result.flexDirection;
  if (result.background === undefined && result.backgroundColor !== undefined) result.background = result.backgroundColor;
  if (result.foreground === undefined && result.color !== undefined) result.foreground = result.color;
  if (result.radius === undefined && result.borderRadius !== undefined) result.radius = result.borderRadius;
  delete result.borderRadius;
  const edge = (value: unknown) => value === "flex-start" ? "start" : value === "flex-end" ? "end" : value === "space-between" ? "between" : value;
  if (result.align === undefined && result.alignItems !== undefined) result.align = edge(result.alignItems) as Style["align"];
  if (result.justify === undefined && result.justifyContent !== undefined) result.justify = edge(result.justifyContent) as Style["justify"];
  delete result.alignItems;
  delete result.justifyContent;
  delete result.objectFit;
  delete result.flexDirection;
  delete result.backgroundColor;
  delete result.color;
  for (const state of ["hover", "focus", "focusVisible", "active", "disabled"] as const) {
    const canonical = canonicalizeStateStyle(style?.[state]);
    if (canonical) result[state] = canonical;
  }
  return result as Style;
}
