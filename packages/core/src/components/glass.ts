import type { GlassMaterial, Style } from "../protocol";
import type { VNode } from "../jsx-runtime";
import { container, type ViewProps } from "./layout";

export type GlassVariant = "regular" | "clear" | "tinted";

export interface GlassProps extends ViewProps {
  /**
   * `regular`: frosted, legible over anything (toolbars, tab bars). `clear`: barely
   * tinted, for controls over media. `tinted`: `tint` shows through strongly.
   */
  variant?: GlassVariant;
  /** Tint colour; the alpha is the strength. Defaults per variant to a white or dark veil. */
  tint?: string;
  /** Light or dark appearance of the rim and veil. Default `light`. */
  appearance?: "light" | "dark";
  /** Corner radius. Default 26 (a capsule when the box is 52 px tall). */
  radius?: number;
  /** Overrides of the material: blur, saturate, refraction, highlight. */
  material?: Partial<GlassMaterial>;
  /** Outer shadow under the glass. Default on. */
  shadow?: boolean;
}

const MATERIAL: Record<GlassVariant, GlassMaterial> = {
  regular: { blur: 24, saturate: 1.7, refraction: 10, highlight: 0.9 },
  clear: { blur: 10, saturate: 1.3, refraction: 14, highlight: 0.7 },
  tinted: { blur: 20, saturate: 1.5, refraction: 8, highlight: 0.6 },
};

const VEIL: Record<"light" | "dark", Record<GlassVariant, string>> = {
  light: { regular: "#ffffff8c", clear: "#ffffff26", tinted: "#ffffff40" },
  dark: { regular: "#1c1c1ea6", clear: "#00000026", tinted: "#1c1c1e59" },
};

/** The rim, inner light and drop shadow of iOS 26 glass, for a given radius and appearance. */
export function glassChrome(appearance: "light" | "dark", shadow: boolean): Style {
  const light = appearance === "light";
  return {
    borderWidth: 1,
    borderColor: light ? "#ffffff73" : "#ffffff2e",
    boxShadow: [
      // The bright line along the top inside edge and the darker one along the bottom.
      { inset: true, y: 1, blur: 1, color: light ? "#ffffffb3" : "#ffffff40" },
      { inset: true, y: -1, blur: 1, color: light ? "#0000001a" : "#00000066" },
      ...(shadow ? [{ y: 10, blur: 30, color: light ? "#00000033" : "#00000080" }, { y: 2, blur: 6, color: "#0000001f" }] : []),
    ],
  };
}

/**
 * A container made of Liquid Glass: what scrolls behind it shows through blurred,
 * bent at the rounded edge, under a light veil, with a bright rim. Compose like a
 * `View`; controls inside keep their own look.
 */
export function Glass({ variant = "regular", tint, appearance = "light", radius = 26, material, shadow = true, style, ...props }: GlassProps): VNode {
  const glass: GlassMaterial = { ...MATERIAL[variant], ...material };
  return container("view", {
    ...props,
    style: {
      background: tint ?? VEIL[appearance][variant],
      radius,
      glass,
      ...glassChrome(appearance, shadow),
      ...style,
    },
  });
}
