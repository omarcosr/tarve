import type { Style as ProtocolStyle } from "../../protocol/src/index";

export type Style = ProtocolStyle;

const stateKeys = ["hover", "focus", "focusVisible", "active", "disabled"] as const;

function mergeStyles(styles: readonly (ProtocolStyle | null | undefined | false)[]): ProtocolStyle {
  const result: ProtocolStyle = {};
  for (const style of styles) {
    if (!style) continue;
    const previousStates = Object.fromEntries(
      stateKeys.map(key => [key, result[key]]),
    ) as Pick<ProtocolStyle, (typeof stateKeys)[number]>;
    Object.assign(result, style);
    for (const key of stateKeys) {
      if (style[key]) result[key] = { ...previousStates[key], ...style[key] };
    }
  }
  return result;
}

/** Typed style helpers. `create` is allocation-free; `merge` deep-merges visual state objects. */
export const Style = {
  create<const T extends ProtocolStyle | Record<string, ProtocolStyle>>(value: T): T {
    return value;
  },
  merge(...styles: (ProtocolStyle | null | undefined | false)[]): ProtocolStyle {
    return mergeStyles(styles);
  },
} as const;
