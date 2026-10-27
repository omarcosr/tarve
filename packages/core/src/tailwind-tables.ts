import type { MotionEasing } from "./protocol";

export type Side = "top" | "right" | "bottom" | "left";

export const UNIT = 4;
export const BASE_FONT = 16;
export const SIDES: Record<string, readonly Side[] | "all"> = {
  "": "all", x: ["left", "right"], y: ["top", "bottom"], t: ["top"], r: ["right"], b: ["bottom"], l: ["left"],
  s: ["left"], e: ["right"],
};

export const SHADES = ["50", "100", "200", "300", "400", "500", "600", "700", "800", "900", "950"];
export const NAMED_COLORS: Record<string, string> = { white: "#ffffff", black: "#000000", transparent: "transparent" };

export const FONT_SIZES: Record<string, [number, number]> = {
  xs: [12, 16], sm: [14, 20], base: [16, 24], lg: [18, 28], xl: [20, 28], "2xl": [24, 32], "3xl": [30, 36],
  "4xl": [36, 40], "5xl": [48, 48], "6xl": [60, 60], "7xl": [72, 72], "8xl": [96, 96], "9xl": [128, 128],
};
export const FONT_WEIGHTS: Record<string, number> = {
  thin: 100, extralight: 200, light: 300, normal: 400, medium: 500, semibold: 600, bold: 700, extrabold: 800, black: 900,
};
export const FONT_FAMILIES: Record<string, string> = { sans: "system-ui", serif: "serif", mono: "monospace" };
export const LEADING: Record<string, number> = { none: 1, tight: 1.25, snug: 1.375, normal: 1.5, relaxed: 1.625, loose: 2 };
export const TRACKING: Record<string, number> = { tighter: -0.05, tight: -0.025, normal: 0, wide: 0.025, wider: 0.05, widest: 0.1 };
export const RADII: Record<string, number> = { none: 0, xs: 2, sm: 4, "": 4, md: 6, lg: 8, xl: 12, "2xl": 16, "3xl": 24, "4xl": 32, full: 9999 };
/** Tailwind 4's container scale (`--container-*`): `max-w-md`, `w-xs`, `min-w-sm`… */
export const CONTAINERS: Record<string, number> = {
  "3xs": 256, "2xs": 288, xs: 320, sm: 384, md: 448, lg: 512, xl: 576, "2xl": 672, "3xl": 768, "4xl": 896, "5xl": 1024, "6xl": 1152, "7xl": 1280,
};
export const SHADOWS: Record<string, string> = {
  "2xs": "0 1px #0000000d",
  xs: "0 1px 2px 0 #0000000d",
  sm: "0 1px 3px 0 #0000001a, 0 1px 2px -1px #0000001a",
  "": "0 1px 3px 0 #0000001a, 0 1px 2px -1px #0000001a",
  md: "0 4px 6px -1px #0000001a, 0 2px 4px -2px #0000001a",
  lg: "0 10px 15px -3px #0000001a, 0 4px 6px -4px #0000001a",
  xl: "0 20px 25px -5px #0000001a, 0 8px 10px -6px #0000001a",
  "2xl": "0 25px 50px -12px #00000040",
  none: "none",
};
/** Tailwind 4 text shadows; the protocol paints one layer, so the multi-layer sizes keep their widest layer. */
export const TEXT_SHADOWS: Record<string, string> = {
  "2xs": "0 1px 0 #00000026", xs: "0 1px 1px #00000033", sm: "0 2px 2px #00000013", md: "0 2px 4px #00000013", lg: "0 3px 6px #00000013", none: "none",
};
export const BLURS: Record<string, number> = { xs: 4, sm: 8, md: 12, lg: 16, xl: 24, "2xl": 40, "3xl": 64, none: 0 };
export const OBJECT_FITS = new Set(["fill", "contain", "cover", "none", "scale-down"]);
export const INSET_SHADOWS: Record<string, string> = {
  "2xs": "inset 0 1px #0000000d",
  xs: "inset 0 1px 1px #0000000d",
  sm: "inset 0 2px 4px #0000000d",
  none: "none",
};
export const EASINGS: Record<string, MotionEasing> = { linear: "linear", in: "easeIn", out: "easeOut", "in-out": "easeInOut" };
export const CURSORS = new Set(["auto", "none", "default", "pointer", "text", "vertical-text", "move", "grab", "grabbing", "not-allowed", "no-drop", "wait", "progress", "help", "crosshair", "copy", "alias", "context-menu", "cell", "zoom-in", "zoom-out", "col-resize", "row-resize", "ew-resize", "ns-resize", "nesw-resize", "nwse-resize", "all-scroll"]);
export const BORDER_STYLES = new Set(["solid", "dashed", "dotted", "double", "none", "hidden"]);
export const OVERFLOWS = new Set(["visible", "hidden", "clip", "auto", "scroll"]);
export const WHITESPACE = new Set(["normal", "nowrap", "pre", "pre-wrap", "pre-line"]);
export const STATE_VARIANTS: Record<string, "hover" | "focus" | "focusVisible" | "active" | "disabled" | "groupHover" | "focusWithin"> = {
  hover: "hover", focus: "focus", "focus-visible": "focusVisible", active: "active", disabled: "disabled",
  "group-hover": "groupHover", "focus-within": "focusWithin",
};
/** Variants the reconciler folds (theme, position among siblings, window size, system): each nests a full style, under its Style key. */
export const WRAPPER_VARIANTS: Record<string, string> = { dark: "dark", first: "first", last: "last", odd: "odd", even: "even", sm: "sm", md: "md", lg: "lg", xl: "xl", "2xl": "2xl", portrait: "portrait", landscape: "landscape", "pointer-coarse": "pointerCoarse", "pointer-fine": "pointerFine", "motion-reduce": "motionReduce", "motion-safe": "motionSafe" };
