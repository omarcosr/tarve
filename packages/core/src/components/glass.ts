import type { GlassMaterial, Style } from "../protocol";
import type { VNode } from "../jsx-runtime";
import { theme } from "../theme";
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

export type GlassAppearance = "light" | "dark";

export interface GlassOptions {
  variant?: GlassVariant;
  /**
   * Tints the glass, the alpha being the strength: the prominent, coloured glass of a
   * primary action. A theme token with an alpha (`var(--primary)/85`) works too.
   */
  tint?: string;
  /** Light or dark glass. Default: follows the theme (its `card` colour veils, its `foreground` inks). */
  appearance?: GlassAppearance;
}

/**
 * The `glass` prop of Button, Toggle, ToggleGroup, Select, Switch and Input: `true` for the
 * `regular` material, a variant, or options.
 */
export type GlassProp = boolean | GlassVariant | GlassOptions;

export interface ResolvedGlass extends GlassOptions { variant: GlassVariant }

export function resolveGlass(glass: GlassProp | undefined): ResolvedGlass | undefined {
  if (!glass) return undefined;
  if (glass === true) return { variant: "regular" };
  if (typeof glass === "string") return { variant: glass };
  return { ...glass, variant: glass.variant ?? "regular" };
}

// Controls are small lenses: less frost and a deeper bend than a bar, so what is under them
// stays recognisable, and no drawn border, as the shader lights the rim itself.
const CONTROL_MATERIAL: Record<GlassVariant, GlassMaterial> = {
  regular: { blur: 10, saturate: 1.6, refraction: 30, highlight: 1, magnify: 0.1 },
  clear: { blur: 3, saturate: 1.35, refraction: 34, highlight: 1, magnify: 0.14 },
  tinted: { blur: 8, saturate: 1.5, refraction: 26, highlight: 0.9, magnify: 0.08 },
};

// Liquid Glass is a lens, not a frosted sheet: what is under it shows through, blurred, bent
// and saturated, under the faintest veil. Legibility comes from the frost and the saturation
// (they flatten detail into colour), not from painting the glass white.
const CONTROL_VEIL: Record<GlassAppearance, Record<GlassVariant, string>> = {
  light: { regular: "#ffffff38", clear: "#ffffff0d", tinted: "#ffffff24" },
  dark: { regular: "#00000059", clear: "#0000001a", tinted: "#00000038" },
};

const PRESS_GLOW = "radial-gradient(circle at 50% 50%, #ffffff47, #ffffff00 72%)";

/** The material one or two steps more liquid: the hover and press response of a control. */
function swell(material: GlassMaterial, step: number): GlassMaterial {
  return {
    ...material,
    refraction: (material.refraction ?? 0) + 6 * step,
    magnify: (material.magnify ?? 0) + 0.03 * step,
    highlight: Math.min(1, (material.highlight ?? 1) + 0.2 * step),
  };
}

/** The theme-following veil: the theme's card colour at an alpha (percent). */
const AUTO_VEIL: Record<GlassVariant, number> = { regular: 22, clear: 5, tinted: 14 };

function controlVeil(glass: ResolvedGlass, boost = 0): string {
      if (glass.appearance) {
        const veil = CONTROL_VEIL[glass.appearance][glass.variant];
        return boost ? over(glass.appearance === "dark" ? "#ffffff0f" : "#ffffff1f", veil) : veil;
      }
      return `${theme.colors.card}/${Math.min(100, AUTO_VEIL[glass.variant] + boost)}`;
}

/** The ink of text and icons on the glass. */
export function glassInk(glass: ResolvedGlass): string {
  if (glass.tint) return "#ffffff";
  return glass.appearance === "dark" ? "#ffffff" : glass.appearance === "light" ? "#1c1c1e" : theme.colors.foreground;
}

/** The ink of the glass at `percent` opacity: secondary text, hover washes, tracks. */
export function glassWash(glass: ResolvedGlass, percent: number): string {
  if (glass.appearance || glass.tint) {
    const base = glassInk(glass) === "#ffffff" ? "#ffffff" : "#1c1c1e";
    return `${base}${Math.round(percent * 2.55).toString(16).padStart(2, "0")}`;
  }
  return `${theme.colors.foreground}/${percent}`;
}

/**
 * The surface of a glass control: veil (or tint), control material, a soft shadow and the
 * liquid press, where the lens swells a little under the pointer.
 */
export function glassControl(glass: ResolvedGlass, radius: number, options: { shadow?: boolean; press?: boolean } = {}): Style {
  const tinted = glass.tint !== undefined;
  const veil = controlVeil(glass);
  const background = tinted ? over(glass.tint!, veil) : veil;
  const press = options.press ?? true;
  const material: GlassMaterial = { ...CONTROL_MATERIAL[tinted ? "tinted" : glass.variant], ...(glass.appearance === "dark" ? { highlight: 0.6 } : {}) };
  return {
    background,
    radius,
    glass: material,
    borderWidth: 0,
    // One wide, faint shadow: a tight one would trace a grey outline round the rim.
    boxShadow: options.shadow === false ? [] : [{ y: 4, blur: 18, color: glass.appearance === "dark" ? "#00000040" : "#00000012" }],
    foreground: glassInk(glass),
    // Glass moves on a spring: the press swells the lens and it settles with a soft overshoot.
    transition: { transform: { duration: 520, easing: "spring" }, glass: { duration: 520, easing: "spring" }, background: { duration: 240 } },
    // Under the pointer the lens itself responds: it bends deeper, magnifies more and its rim brightens.
    hover: { ...(tinted ? {} : { background: controlVeil(glass, 12) }), glass: swell(material, 1), ...(press ? { transform: "scale(1.02)" } : {}) },
    // Pressed, the glass lights up from within, brightest at its centre.
    ...(press ? { active: { glass: swell(material, 2), transform: "scale(1.07)", backgroundLayers: [PRESS_GLOW] } } : {}),
  };
}

/**
 * A drop of glass inside a glass control: what hover and selection show in a menu, a segmented
 * control or a tab bar (iOS 26 lifts the chosen item into its own lens rather than painting a
 * flat wash). `hover` is a faint lens, `selected` a brighter one that reads as the choice.
 */
export function glassLens(glass: ResolvedGlass, strength: "hover" | "selected"): Style {
  const selected = strength === "selected";
  // A drop is clear glass with its own rim: the same frost as the control it sits in (it reads
  // the backdrop from under that control), a breath of light, a deeper bend and more magnification.
  const veil = glass.appearance === "dark" ? (selected ? "#ffffff1f" : "#ffffff0f")
    : glass.appearance === "light" ? (selected ? "#ffffff4d" : "#ffffff26")
    : `${theme.colors.card}/${selected ? 30 : 15}`;
  return {
    background: veil,
    glass: { blur: 10, saturate: 1.6, refraction: selected ? 24 : 16, highlight: 1, magnify: selected ? 0.16 : 0.1 },
  };
}

/**
 * The drop of glass the pointer raises over an item of a glass control (a menu row, a segment):
 * lay it as the item's first child and mark the item `group`. It is always there, faded out and
 * a little shrunk, so hovering fades it in and springs it to size instead of switching it on.
 */
export function hoverLens(glass: ResolvedGlass, radius: number, inside?: { veil: string; blur: number }): VNode {
  const lens = glassLens(glass, "hover");
  return container("view", {
    style: {
      position: "absolute", top: 0, left: 0, right: 0, bottom: 0, radius, pointerEvents: "none",
      ...lens,
      // Inside a frostier surface (a popup) the drop takes that surface's frost and a lighter
      // veil, or what the surface hides (its own shadow) would show through the drop.
      ...(inside ? { background: over("#ffffff1f", inside.veil), glass: { ...(lens.glass as GlassMaterial), blur: inside.blur } } : {}),
      opacity: 0, transform: { scale: 0.86 },
      groupHover: { opacity: 1, transform: { scale: 1 } },
      transition: { opacity: { duration: 220, easing: "easeOut" }, transform: { duration: 520, easing: "spring" } },
    },
  });
}

/** The glass of a popup (a select's list, a menu): frostier than a control, so its text reads over anything. */
export function glassPopup(glass: ResolvedGlass, radius = 16): Style {
  const veil = popupVeil(glass);
  return popupStyle(glass, radius, veil);
}

/** The veil of a popup's glass. */
export function popupVeil(glass: ResolvedGlass): string {
  return glass.appearance ? (glass.appearance === "dark" ? "#1c1c1e73" : "#ffffff66") : `${theme.colors.card}/40`;
}

/** The frost of a popup's glass. */
export const POPUP_BLUR = 26;

function popupStyle(glass: ResolvedGlass, radius: number, veil: string): Style {
  return {
    background: veil,
    radius,
    glass: { blur: POPUP_BLUR, saturate: 1.4, refraction: 18, highlight: glass.appearance === "dark" ? 0.6 : 1, magnify: 0.04 },
    borderWidth: 0,
    boxShadow: [{ y: 14, blur: 40, color: glass.appearance === "dark" ? "#00000073" : "#00000029" }, { y: 2, blur: 6, color: "#0000001a" }],
    foreground: glassInk({ ...glass, tint: undefined }),
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
