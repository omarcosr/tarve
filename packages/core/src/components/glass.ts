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
  /**
   * Tint colour laid over the variant's veil; the alpha is the strength. `regular` stays
   * frosted under it, `clear` shows it nearly alone. A gradient string passes through as is.
   */
  tint?: string;
  /** Light or dark appearance of the rim and veil. Default `light`. */
  appearance?: "light" | "dark";
  /** Corner radius. Default 26 (a capsule when the box is 52 px tall). */
  radius?: number;
  /** Overrides of the material: blur, saturate, refraction, highlight. */
  material?: Partial<GlassMaterial>;
  /** Outer shadow under the glass. Default on. */
  shadow?: boolean;
  /**
   * Glass boxes with the same key fuse like drops of liquid: where two come within
   * `blend` px of each other their shapes bridge smoothly, as one surface. The first
   * box of the key in tree order paints the surface: its tint, material and `blend`
   * are the surface's, the others contribute only their shape (up to 8 per key).
   */
  merge?: string;
  /** How far apart in px two merged boxes start bridging; read from the first box of the key. Default 32. */
  blend?: number;
}

// Little blur: what makes it glass is the lens, not the frost. The edge bends the
// backdrop over the corner radius, the flat part enlarges it slightly.
const MATERIAL: Record<GlassVariant, GlassMaterial> = {
  regular: { blur: 8, saturate: 1.6, refraction: 22, highlight: 1, magnify: 0.06 },
  clear: { blur: 2, saturate: 1.25, refraction: 28, highlight: 1, magnify: 0.1 },
  tinted: { blur: 6, saturate: 1.5, refraction: 18, highlight: 0.9, magnify: 0.06 },
};

const VEIL: Record<"light" | "dark", Record<GlassVariant, string>> = {
  light: { regular: "#ffffff59", clear: "#ffffff14", tinted: "#ffffff33" },
  dark: { regular: "#1c1c1e8c", clear: "#00000014", tinted: "#1c1c1e4d" },
};

/** `#rgb`/`#rrggbb`/`#rrggbbaa` as [r, g, b, a] in 0–1; undefined for anything else. */
function hexChannels(color: string): [number, number, number, number] | undefined {
  const hex = color.trim().replace(/^#/, "");
  const full = hex.length === 3 ? [...hex].map(c => c + c).join("") + "ff" : hex.length === 6 ? hex + "ff" : hex;
  if (!/^[0-9a-f]{8}$/i.test(full)) return undefined;
  const channel = (at: number) => Number.parseInt(full.slice(at, at + 2), 16) / 255;
  return [channel(0), channel(2), channel(4), channel(6)];
}

/** `top` composited over `bottom` (source-over); `top` unchanged when either is not a hex colour. */
export function over(top: string, bottom: string): string {
  const a = hexChannels(top);
  const b = hexChannels(bottom);
  if (!a || !b) return top;
  const alpha = a[3] + b[3] * (1 - a[3]);
  if (alpha <= 0) return "#00000000";
  const hex = (value: number) => Math.round(Math.min(1, Math.max(0, value)) * 255).toString(16).padStart(2, "0");
  const mix = (index: number) => (a[index]! * a[3] + b[index]! * b[3] * (1 - a[3])) / alpha;
  return `#${hex(mix(0))}${hex(mix(1))}${hex(mix(2))}${hex(alpha)}`;
}

/** The rim, inner light and drop shadow of iOS 26 glass, for a given radius and appearance. */
export function glassChrome(appearance: "light" | "dark", shadow: boolean): Style {
  const light = appearance === "light";
  return {
    borderWidth: 1,
    borderColor: light ? "#ffffff59" : "#ffffff26",
    boxShadow: [
      // The bright line along the top inside edge and the darker one along the bottom.
      { inset: true, y: 1, blur: 1, color: light ? "#ffffff80" : "#ffffff33" },
      { inset: true, y: -1, blur: 1, color: light ? "#00000014" : "#00000059" },
      ...(shadow ? [{ y: 10, blur: 30, color: light ? "#00000033" : "#00000080" }, { y: 2, blur: 6, color: "#0000001f" }] : []),
    ],
  };
}

/** The complete style of a glass surface: veil, material, radius and chrome. */
export function glassSurface(variant: GlassVariant, appearance: "light" | "dark", options: { tint?: string; radius?: number; material?: Partial<GlassMaterial>; shadow?: boolean; merge?: string; blend?: number } = {}): Style {
  return {
    // The tint sits on the veil, so a tinted `regular` box stays frosted and legible.
    background: options.tint ? over(options.tint, VEIL[appearance][variant]) : VEIL[appearance][variant],
    radius: options.radius ?? 26,
    // Dark glass reflects less: the same highlight reads harsh on a dark veil.
    glass: {
      ...MATERIAL[variant],
      ...(appearance === "dark" ? { highlight: 0.55 } : {}),
      ...(options.merge ? { merge: options.merge, blend: options.blend ?? 32 } : {}),
      ...options.material,
    },
    // A merged box has no outline of its own: its silhouette is the fused surface's,
    // which the shader lights (rim and reflections); a border or shadow would trace the
    // box through the bridge.
    ...(options.merge ? { borderWidth: 0, boxShadow: [] } : glassChrome(appearance, options.shadow ?? true)),
  };
}

/**
 * A container made of Liquid Glass: what scrolls behind it shows through blurred,
 * bent at the rounded edge, under a light veil, with a bright rim. Compose like a
 * `View`; controls inside keep their own look.
 */
export function Glass({ variant = "regular", tint, appearance = "light", radius = 26, material, shadow = true, merge, blend, style, ...props }: GlassProps): VNode {
  return container("view", {
    ...props,
    style: { ...glassSurface(variant, appearance, { tint, radius, material, shadow, merge, blend }), ...style },
  });
}
