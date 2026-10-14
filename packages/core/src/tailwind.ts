import type { Insets, Length, MotionEasing, Style, Transform, GradientSide, LinearGradient } from "./protocol";
import { theme } from "./theme";

/**
 * Tailwind utility classes compiled to Tarve styles, with no CSS and no DOM.
 * `className="flex items-center gap-2 p-4 bg-zinc-900 hover:bg-zinc-800"`
 * becomes the equivalent `style` object at the JSX call site; `tw()` does the
 * same for component `style` props. Only what the native protocol can paint is
 * mapped: there are no media queries, so responsive (`md:`) and `dark:`
 * variants are dropped, and per-corner radii fall back to nothing.
 */

type Out = Record<string, unknown>;
type Side = "top" | "right" | "bottom" | "left";

const UNIT = 4;
const BASE_FONT = 16;
const SIDES: Record<string, readonly Side[] | "all"> = {
  "": "all", x: ["left", "right"], y: ["top", "bottom"], t: ["top"], r: ["right"], b: ["bottom"], l: ["left"],
  s: ["left"], e: ["right"],
};

const PALETTE: Record<string, string> = {
  slate: "f8fafc f1f5f9 e2e8f0 cbd5e1 94a3b8 64748b 475569 334155 1e293b 0f172a 020617",
  gray: "f9fafb f3f4f6 e5e7eb d1d5db 9ca3af 6b7280 4b5563 374151 1f2937 111827 030712",
  zinc: "fafafa f4f4f5 e4e4e7 d4d4d8 a1a1aa 71717a 52525b 3f3f46 27272a 18181b 09090b",
  neutral: "fafafa f5f5f5 e5e5e5 d4d4d4 a3a3a3 737373 525252 404040 262626 171717 0a0a0a",
  stone: "fafaf9 f5f5f4 e7e5e4 d6d3d1 a8a29e 78716c 57534e 44403c 292524 1c1917 0c0a09",
  red: "fef2f2 fee2e2 fecaca fca5a5 f87171 ef4444 dc2626 b91c1c 991b1b 7f1d1d 450a0a",
  orange: "fff7ed ffedd5 fed7aa fdba74 fb923c f97316 ea580c c2410c 9a3412 7c2d12 431407",
  amber: "fffbeb fef3c7 fde68a fcd34d fbbf24 f59e0b d97706 b45309 92400e 78350f 451a03",
  yellow: "fefce8 fef9c3 fef08a fde047 facc15 eab308 ca8a04 a16207 854d0e 713f12 422006",
  lime: "f7fee7 ecfccb d9f99d bef264 a3e635 84cc16 65a30d 4d7c0f 3f6212 365314 1a2e05",
  green: "f0fdf4 dcfce7 bbf7d0 86efac 4ade80 22c55e 16a34a 15803d 166534 14532d 052e16",
  emerald: "ecfdf5 d1fae5 a7f3d0 6ee7b7 34d399 10b981 059669 047857 065f46 064e3b 022c22",
  teal: "f0fdfa ccfbf1 99f6e4 5eead4 2dd4bf 14b8a6 0d9488 0f766e 115e59 134e4a 042f2e",
  cyan: "ecfeff cffafe a5f3fc 67e8f9 22d3ee 06b6d4 0891b2 0e7490 155e75 164e63 083344",
  sky: "f0f9ff e0f2fe bae6fd 7dd3fc 38bdf8 0ea5e9 0284c7 0369a1 075985 0c4a6e 082f49",
  blue: "eff6ff dbeafe bfdbfe 93c5fd 60a5fa 3b82f6 2563eb 1d4ed8 1e40af 1e3a8a 172554",
  indigo: "eef2ff e0e7ff c7d2fe a5b4fc 818cf8 6366f1 4f46e5 4338ca 3730a3 312e81 1e1b4b",
  violet: "f5f3ff ede9fe ddd6fe c4b5fd a78bfa 8b5cf6 7c3aed 6d28d9 5b21b6 4c1d95 2e1065",
  purple: "faf5ff f3e8ff e9d5ff d8b4fe c084fc a855f7 9333ea 7e22ce 6b21a8 581c87 3b0764",
  fuchsia: "fdf4ff fae8ff f5d0fe f0abfc e879f9 d946ef c026d3 a21caf 86198f 701a75 4a044e",
  pink: "fdf2f8 fce7f3 fbcfe8 f9a8d4 f472b6 ec4899 db2777 be185d 9d174d 831843 500724",
  rose: "fff1f2 ffe4e6 fecdd3 fda4af fb7185 f43f5e e11d48 be123c 9f1239 881337 4c0519",
};
const SHADES = ["50", "100", "200", "300", "400", "500", "600", "700", "800", "900", "950"];
const NAMED_COLORS: Record<string, string> = { white: "#ffffff", black: "#000000", transparent: "transparent" };

const FONT_SIZES: Record<string, [number, number]> = {
  xs: [12, 16], sm: [14, 20], base: [16, 24], lg: [18, 28], xl: [20, 28], "2xl": [24, 32], "3xl": [30, 36],
  "4xl": [36, 40], "5xl": [48, 48], "6xl": [60, 60], "7xl": [72, 72], "8xl": [96, 96], "9xl": [128, 128],
};
const FONT_WEIGHTS: Record<string, number> = {
  thin: 100, extralight: 200, light: 300, normal: 400, medium: 500, semibold: 600, bold: 700, extrabold: 800, black: 900,
};
const FONT_FAMILIES: Record<string, string> = { sans: "system-ui", serif: "serif", mono: "monospace" };
const LEADING: Record<string, number> = { none: 1, tight: 1.25, snug: 1.375, normal: 1.5, relaxed: 1.625, loose: 2 };
const TRACKING: Record<string, number> = { tighter: -0.05, tight: -0.025, normal: 0, wide: 0.025, wider: 0.05, widest: 0.1 };
const RADII: Record<string, number> = { none: 0, sm: 2, "": 4, md: 6, lg: 8, xl: 12, "2xl": 16, "3xl": 24, full: 9999 };
const MAX_WIDTHS: Record<string, number> = {
  xs: 320, sm: 384, md: 448, lg: 512, xl: 576, "2xl": 672, "3xl": 768, "4xl": 896, "5xl": 1024, "6xl": 1152, "7xl": 1280,
};
const SHADOWS: Record<string, string> = {
  sm: "0 1px 2px 0 #0000000d",
  "": "0 1px 3px 0 #0000001a, 0 1px 2px -1px #0000001a",
  md: "0 4px 6px -1px #0000001a, 0 2px 4px -2px #0000001a",
  lg: "0 10px 15px -3px #0000001a, 0 4px 6px -4px #0000001a",
  xl: "0 20px 25px -5px #0000001a, 0 8px 10px -6px #0000001a",
  "2xl": "0 25px 50px -12px #00000040",
  inner: "inset 0 2px 4px 0 #0000000d",
  none: "none",
};
const EASINGS: Record<string, MotionEasing> = { linear: "linear", in: "easeIn", out: "easeOut", "in-out": "easeInOut" };
const CURSORS = new Set(["auto", "default", "pointer", "text", "vertical-text", "move", "grab", "grabbing", "not-allowed", "no-drop", "wait", "progress", "help", "crosshair", "copy", "alias", "context-menu", "cell", "zoom-in", "zoom-out", "col-resize", "row-resize", "ew-resize", "ns-resize", "nesw-resize", "nwse-resize", "all-scroll"]);
const BORDER_STYLES = new Set(["solid", "dashed", "dotted", "double", "none", "hidden"]);
const OVERFLOWS = new Set(["visible", "hidden", "clip", "auto", "scroll"]);
const WHITESPACE = new Set(["normal", "nowrap", "pre", "pre-wrap", "pre-line"]);
const STATE_VARIANTS: Record<string, "hover" | "focus" | "focusVisible" | "active" | "disabled"> = {
  hover: "hover", focus: "focus", "focus-visible": "focusVisible", active: "active", disabled: "disabled",
};

const STATIC: Record<string, Out> = {
  flex: { display: "flex" }, "inline-flex": { display: "flex" }, grid: { display: "grid" }, "inline-grid": { display: "grid" },
  block: { display: "block" }, hidden: { display: "none" },
  "flex-row": { direction: "row" }, "flex-row-reverse": { direction: "row-reverse" },
  "flex-col": { direction: "column" }, "flex-col-reverse": { direction: "column-reverse" },
  "flex-wrap": { wrap: true }, "flex-nowrap": { wrap: false },
  "flex-1": { flex: 1 }, "flex-auto": { flex: "1 1 auto" }, "flex-initial": { flex: "0 1 auto" }, "flex-none": { flex: "none" },
  grow: { grow: 1 }, "grow-0": { grow: 0 }, shrink: { shrink: 1 }, "shrink-0": { shrink: 0 },
  "flex-grow": { grow: 1 }, "flex-grow-0": { grow: 0 }, "flex-shrink": { shrink: 1 }, "flex-shrink-0": { shrink: 0 },
  "items-start": { align: "start" }, "items-center": { align: "center" }, "items-end": { align: "end" }, "items-stretch": { align: "stretch" },
  "justify-start": { justify: "start" }, "justify-center": { justify: "center" }, "justify-end": { justify: "end" }, "justify-between": { justify: "between" },
  "justify-around": { justify: "around" }, "justify-evenly": { justify: "evenly" },
  relative: { position: "relative" }, absolute: { position: "absolute" },
  italic: { fontStyle: "italic" }, "not-italic": { fontStyle: "normal" },
  "text-left": { textAlign: "start" }, "text-start": { textAlign: "start" }, "text-center": { textAlign: "center" },
  "text-right": { textAlign: "end" }, "text-end": { textAlign: "end" },
  "text-ellipsis": { textOverflow: "ellipsis" }, "text-clip": { textOverflow: "clip" },
  truncate: { overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" },
  uppercase: { textTransform: "uppercase" }, lowercase: { textTransform: "lowercase" },
  capitalize: { textTransform: "capitalize" }, "normal-case": { textTransform: "none" },
  underline: { textDecoration: "underline" }, overline: { textDecoration: "overline" },
  "line-through": { textDecoration: "line-through" }, "no-underline": { textDecoration: "none" },
  "decoration-solid": { textDecorationStyle: "solid" }, "decoration-double": { textDecorationStyle: "double" },
  "decoration-dotted": { textDecorationStyle: "dotted" }, "decoration-dashed": { textDecorationStyle: "dashed" }, "decoration-wavy": { textDecorationStyle: "wavy" },
  "tabular-nums": { fontVariantNumeric: "tabular-nums" }, "normal-nums": { fontVariantNumeric: "normal" },
  "slashed-zero": { fontVariantNumeric: "slashed-zero" },
  "select-none": { userSelect: "none" }, "select-text": { userSelect: "text" }, "select-all": { userSelect: "all" }, "select-auto": { userSelect: "auto" },
  "aspect-square": { aspectRatio: 1 }, "aspect-video": { aspectRatio: 16 / 9 },
  "col-span-full": { gridColumn: "1 / -1" }, "row-span-full": { gridRow: "1 / -1" },
  "outline-none": { outlineStyle: "none" }, "outline-solid": { outlineStyle: "solid" }, "outline-dashed": { outlineStyle: "dashed" }, "outline-dotted": { outlineStyle: "dotted" },
  "line-clamp-none": { lineClamp: undefined },
  "transition-none": { transition: undefined },
  "shadow-none": { boxShadow: "none" },
};

function arbitrary(value: string): string | undefined {
  return value.length > 2 && value.startsWith("[") && value.endsWith("]") ? value.slice(1, -1).replace(/_/g, " ") : undefined;
}

function px(raw: string): number | undefined {
  const match = /^(-?\d*\.?\d+)(px|rem|em)?$/.exec(raw);
  if (!match) return undefined;
  const number = Number(match[1]);
  return match[2] === "rem" || match[2] === "em" ? number * BASE_FONT : number;
}

/** A spacing-scale value as px, or a length (`full`, `1/2`, `auto`, `[50%]`). */
function length(value: string, allowAuto = true): Length | undefined {
  const raw = arbitrary(value);
  if (raw !== undefined) return /^-?\d*\.?\d+%$/.test(raw) ? raw as `${number}%` : px(raw);
  if (value === "full") return "100%";
  if (value === "auto") return allowAuto ? "auto" : undefined;
  if (value === "px") return 1;
  const fraction = /^(\d+)\/(\d+)$/.exec(value);
  if (fraction) return `${Math.round((Number(fraction[1]) / Number(fraction[2])) * 1e6) / 1e4}%`;
  const number = /^\d*\.?\d+$/.test(value) ? Number(value) : undefined;
  return number === undefined ? undefined : number * UNIT;
}

function number(value: string): number | undefined {
  const raw = arbitrary(value) ?? value;
  return /^-?\d*\.?\d+$/.test(raw) ? Number(raw) : undefined;
}

function alpha(hex: string, opacity: number): string {
  const channel = Math.round(Math.max(0, Math.min(1, opacity)) * 255).toString(16).padStart(2, "0");
  return (hex.length === 4 ? "#" + [...hex.slice(1)].map(c => c + c).join("") : hex) + channel;
}

const camel = (name: string) => name.replace(/-([a-z])/g, (_, c: string) => c.toUpperCase());

/** Palette (`red-500`, `white`, `red-500/50`), theme token (`primary`, `muted-foreground`) or arbitrary colour. */
function color(value: string): string | undefined {
  const raw = arbitrary(value);
  if (raw !== undefined) return raw;
  const slash = value.lastIndexOf("/");
  // `[#fff]/50`: an arbitrary colour with an opacity modifier.
  if (slash > 0 && value[slash - 1] === "]") {
    const inner = arbitrary(value.slice(0, slash));
    const opacity = number(value.slice(slash + 1));
    if (inner === undefined || opacity === undefined) return undefined;
    return inner.startsWith("#") ? alpha(inner, opacity / 100) : inner;
  }
  const opacity = slash > 0 ? number(value.slice(slash + 1)) : undefined;
  const name = slash > 0 && opacity !== undefined ? value.slice(0, slash) : value;
  let resolved = NAMED_COLORS[name];
  if (resolved === undefined) {
    const dash = name.lastIndexOf("-");
    const family = PALETTE[name.slice(0, dash)];
    const shade = SHADES.indexOf(name.slice(dash + 1));
    if (family && shade >= 0) resolved = "#" + family.split(" ")[shade];
  }
  if (resolved === undefined) resolved = (theme.colors as Record<string, string>)[camel(name)];
  if (resolved === undefined || opacity === undefined) return resolved;
  // Theme tokens resolve per theme later; the reconciler applies the opacity then.
  if (resolved.startsWith("var(")) return `${resolved}/${Math.max(0, Math.min(100, opacity))}`;
  return resolved.startsWith("#") ? alpha(resolved, opacity / 100) : resolved;
}

function setInsets(out: Out, key: "padding" | "margin" | "borderWidth", sides: readonly Side[] | "all", value: number): void {
  if (sides === "all") { out[key] = value; return; }
  const current = out[key] as Insets | undefined;
  const next = typeof current === "number" ? { top: current, right: current, bottom: current, left: current } : { ...(current ?? {}) };
  for (const side of sides) next[side] = value;
  out[key] = next;
}

function setTransform(out: Out, patch: Transform): void {
  out.transform = { ...(typeof out.transform === "object" && out.transform ? out.transform as Transform : {}), ...patch };
}

/**
 * Transition pieces collect until the class list is compiled: as in CSS, `duration-*`,
 * `delay-*` and `ease-*` only animate once there is a duration (`transition` brings
 * Tailwind's 150ms ease-in-out; `duration-*` alone animates everything, CSS's default).
 */
function setTransition(out: Out, patch: { duration?: number; delay?: number; easing?: MotionEasing }): void {
  out[TRANSITION] = { ...(out[TRANSITION] as object | undefined), ...patch };
}

function finishTransition(out: Out): void {
  const pending = out[TRANSITION] as { duration?: number; delay?: number; easing?: MotionEasing } | undefined;
  if (!pending) return;
  delete out[TRANSITION];
  if (pending.duration === undefined || pending.duration <= 0) return;
  out.transition = { all: pending };
}

function fontSizeOf(out: Out): number {
  return typeof out.fontSize === "number" ? out.fontSize : theme.font.size || BASE_FONT;
}

type Handler = (out: Out, value: string, negative: boolean) => void;

function insetHandler(key: "padding" | "margin", sides: readonly Side[] | "all"): Handler {
  return (out, value, negative) => {
    const resolved = length(value, false);
    if (typeof resolved === "number") setInsets(out, key, sides, negative ? -resolved : resolved);
  };
}

function lengthHandler(key: string, allowAuto = true): Handler {
  return (out, value, negative) => {
    const resolved = length(value, allowAuto);
    if (resolved !== undefined) out[key] = negative && typeof resolved === "number" ? -resolved : resolved;
  };
}

function offsetHandler(keys: readonly string[]): Handler {
  return (out, value, negative) => {
    const resolved = length(value);
    if (resolved === undefined) return;
    for (const key of keys) out[key] = negative && typeof resolved === "number" ? -resolved : resolved;
  };
}

function borderSideHandler(sides: readonly Side[]): Handler {
  return (out, value) => {
    const width = value === "" ? 1 : px(arbitrary(value) ?? value);
    if (width !== undefined) setInsets(out, "borderWidth", sides, width);
  };
}

const HANDLERS: Record<string, Handler> = {
  p: insetHandler("padding", "all"), m: insetHandler("margin", "all"),
  w: lengthHandler("width"), h: lengthHandler("height"),
  "min-w": lengthHandler("minWidth", false), "min-h": lengthHandler("minHeight", false),
  "max-h": lengthHandler("maxHeight", false),
  "max-w": (out, value) => {
    if (value === "none") { out.maxWidth = undefined; return; }
    const named = MAX_WIDTHS[value];
    const resolved = named ?? length(value, false);
    if (resolved !== undefined) out.maxWidth = resolved;
  },
  size: (out, value) => {
    const resolved = length(value);
    if (resolved !== undefined) { out.width = resolved; out.height = resolved; }
  },
  gap: lengthHandler("gap", false), "gap-x": lengthHandler("columnGap", false), "gap-y": lengthHandler("rowGap", false),
  top: offsetHandler(["top"]), right: offsetHandler(["right"]), bottom: offsetHandler(["bottom"]), left: offsetHandler(["left"]),
  inset: offsetHandler(["top", "right", "bottom", "left"]), "inset-x": offsetHandler(["left", "right"]), "inset-y": offsetHandler(["top", "bottom"]),
  z: (out, value, negative) => {
    const resolved = number(value);
    if (resolved !== undefined) out.zIndex = negative ? -resolved : resolved;
  },
  flex: (out, value) => {
    const raw = arbitrary(value);
    if (raw !== undefined) out.flex = /^\d+$/.test(raw) ? Number(raw) : raw;
  },
  grow: (out, value) => { const n = number(value); if (n !== undefined) out.grow = n; },
  shrink: (out, value) => { const n = number(value); if (n !== undefined) out.shrink = n; },
  basis: lengthHandler("basis"),
  "grid-cols": (out, value) => {
    const raw = arbitrary(value);
    if (raw !== undefined) out.columns = raw;
    else if (/^\d+$/.test(value)) out.columns = Number(value);
  },
  "grid-rows": (out, value) => {
    const raw = arbitrary(value);
    if (raw !== undefined) out.rows = raw;
    else if (/^\d+$/.test(value)) out.rows = Number(value);
  },
  "col-span": (out, value) => { if (/^\d+$/.test(value)) out.gridColumn = `span ${value}`; },
  "row-span": (out, value) => { if (/^\d+$/.test(value)) out.gridRow = `span ${value}`; },
  "col-start": (out, value) => { if (/^\d+$/.test(value)) out.gridColumn = Number(value); },
  "row-start": (out, value) => { if (/^\d+$/.test(value)) out.gridRow = Number(value); },
  text: (out, value) => {
    // `text-sm/6`: font size with its own line height (a scale step or a `leading-*` name).
    const slash = value.indexOf("/");
    const size = FONT_SIZES[slash > 0 ? value.slice(0, slash) : value];
    if (size) {
      out.fontSize = size[0];
      out.lineHeight = Math.round((size[1] / size[0]) * 1000) / 1000;
      if (slash > 0) HANDLERS.leading!(out, value.slice(slash + 1), false);
      return;
    }
    const raw = arbitrary(value);
    if (raw !== undefined) {
      const resolved = px(raw);
      if (resolved !== undefined) out.fontSize = resolved;
      else out.foreground = raw;
      return;
    }
    const resolved = color(value);
    if (resolved !== undefined) out.foreground = resolved;
  },
  font: (out, value) => {
    const weight = FONT_WEIGHTS[value];
    if (weight !== undefined) { out.fontWeight = weight; return; }
    const raw = arbitrary(value);
    if (raw !== undefined) { if (/^\d+$/.test(raw)) out.fontWeight = Number(raw); else out.fontFamily = raw; return; }
    const family = FONT_FAMILIES[value];
    if (family !== undefined) out.fontFamily = family;
  },
  leading: (out, value) => {
    const named = LEADING[value];
    if (named !== undefined) { out.lineHeight = named; return; }
    const raw = arbitrary(value);
    if (raw !== undefined && /^\d*\.?\d+$/.test(raw)) { out.lineHeight = Number(raw); return; }
    const resolved = length(raw ?? value, false);
    if (typeof resolved === "number") out.lineHeight = Math.round((resolved / fontSizeOf(out)) * 1000) / 1000;
  },
  tracking: (out, value, negative) => {
    const em = TRACKING[value];
    if (em !== undefined) { out.letterSpacing = Math.round(em * fontSizeOf(out) * 100) / 100; return; }
    const raw = arbitrary(value) ?? "";
    const ems = /^(-?\d*\.?\d+)em$/.exec(raw);
    const resolved = ems ? Math.round(Number(ems[1]) * fontSizeOf(out) * 100) / 100 : px(raw);
    if (resolved !== undefined) out.letterSpacing = negative ? -resolved : resolved;
  },
  "line-clamp": (out, value) => {
    const n = number(value);
    if (n !== undefined) { out.lineClamp = n; out.overflow = "hidden"; }
  },
  whitespace: (out, value) => { if (WHITESPACE.has(value)) out.whiteSpace = value; },
  bg: (out, value) => {
    const direction = /^(?:gradient|linear)-to-(t|tr|r|br|b|bl|l|tl)$/.exec(value);
    if (direction) { gradientOf(out).to = GRADIENT_SIDES[direction[1]!]; return; }
    const resolved = color(value);
    if (resolved !== undefined) out.background = resolved;
  },
  from: (out, value) => { const c = color(value); if (c !== undefined) gradientOf(out).from = c; },
  via: (out, value) => { const c = color(value); if (c !== undefined) gradientOf(out).via = c; },
  to: (out, value) => { const c = color(value); if (c !== undefined) gradientOf(out).stop = c; },
  border: (out, value) => {
    if (value === "") { setInsets(out, "borderWidth", "all", 1); return; }
    if (BORDER_STYLES.has(value)) { out.borderStyle = value; return; }
    const dash = value.indexOf("-");
    const head = dash < 0 ? value : value.slice(0, dash);
    const sides = head.length === 1 ? SIDES[head] : undefined;
    if (sides && sides !== "all" && (dash < 0 || /^(\d|\[)/.test(value.slice(dash + 1)))) {
      borderSideHandler(sides)(out, dash < 0 ? "" : value.slice(dash + 1), false);
      return;
    }
    const width = px(arbitrary(value) ?? value);
    if (width !== undefined) { setInsets(out, "borderWidth", "all", width); return; }
    const resolved = color(value);
    if (resolved !== undefined) out.borderColor = resolved;
  },
  rounded: (out, value) => {
    // `rounded-t-lg`: a side or corner prefix, then the size (`rounded-t` alone is the default size).
    const dash = value.indexOf("-");
    const head = dash < 0 ? value : value.slice(0, dash);
    const corners = CORNERS[head];
    const size = corners ? (dash < 0 ? "" : value.slice(dash + 1)) : value;
    const resolved = RADII[size] ?? px(arbitrary(size) ?? "");
    if (resolved === undefined) return;
    if (!corners) { out.radius = resolved; return; }
    const current = out.radius;
    const next: Record<Corner, number> = typeof current === "number"
      ? { topLeft: current, topRight: current, bottomRight: current, bottomLeft: current }
      : { topLeft: 0, topRight: 0, bottomRight: 0, bottomLeft: 0, ...(current as Partial<Record<Corner, number>> | undefined) };
    for (const corner of corners) next[corner] = resolved;
    const values = Object.values(next);
    out.radius = values.every(v => v === values[0]) ? values[0] : next;
  },
  opacity: (out, value) => {
    const n = number(value);
    if (n !== undefined) out.opacity = arbitrary(value) !== undefined ? n : n / 100;
  },
  shadow: (out, value) => {
    const named = SHADOWS[value] ?? arbitrary(value);
    if (named !== undefined) out.boxShadow = named;
  },
  cursor: (out, value) => { if (CURSORS.has(value)) out.cursor = value; },
  overflow: (out, value) => { if (OVERFLOWS.has(value)) out.overflow = value; },
  "overflow-x": (out, value) => { if (OVERFLOWS.has(value)) out.overflowX = value; },
  "overflow-y": (out, value) => { if (OVERFLOWS.has(value)) out.overflowY = value; },
  scale: (out, value, negative) => {
    const n = number(value);
    if (n !== undefined) setTransform(out, { scale: (negative ? -n : n) / (arbitrary(value) !== undefined ? 1 : 100) });
  },
  "scale-x": (out, value) => { const n = number(value); if (n !== undefined) setTransform(out, { scaleX: n / 100 }); },
  "scale-y": (out, value) => { const n = number(value); if (n !== undefined) setTransform(out, { scaleY: n / 100 }); },
  "translate-x": (out, value, negative) => {
    const resolved = length(value, false);
    if (typeof resolved === "number") setTransform(out, { x: negative ? -resolved : resolved });
  },
  "translate-y": (out, value, negative) => {
    const resolved = length(value, false);
    if (typeof resolved === "number") setTransform(out, { y: negative ? -resolved : resolved });
  },
  transition: (out) => setTransition(out, { duration: 150, easing: "easeInOut" }),
  duration: (out, value) => { const n = number(value); if (n !== undefined) setTransition(out, { duration: n }); },
  delay: (out, value) => { const n = number(value); if (n !== undefined) setTransition(out, { delay: n }); },
  ease: (out, value) => { const easing = EASINGS[value]; if (easing) setTransition(out, { easing }); },
  aspect: (out, value) => {
    const raw = arbitrary(value);
    if (raw === undefined) { if (value === "auto") out.aspectRatio = undefined; return; }
    const ratio = /^(\d*\.?\d+)\s*\/\s*(\d*\.?\d+)$/.exec(raw);
    out.aspectRatio = ratio ? Number(ratio[1]) / Number(ratio[2]) : number(raw);
  },
  ring: (out, value) => {
    if (value === "") { out.outlineWidth = 3; out.outlineStyle = "solid"; return; }
    const width = px(arbitrary(value) ?? value);
    if (width !== undefined) { out.outlineWidth = width; out.outlineStyle = "solid"; return; }
    const resolved = color(value);
    if (resolved !== undefined) out.outlineColor = resolved;
  },
  "ring-offset": (out, value) => { const n = px(arbitrary(value) ?? value); if (n !== undefined) out.outlineOffset = n; },
  outline: (out, value) => {
    const width = px(arbitrary(value) ?? value);
    if (width !== undefined) { out.outlineWidth = width; return; }
    const resolved = color(value);
    if (resolved !== undefined) out.outlineColor = resolved;
  },
  "outline-offset": (out, value) => { const n = px(arbitrary(value) ?? value); if (n !== undefined) out.outlineOffset = n; },
  stroke: (out, value) => { const n = number(value); if (n !== undefined) out.strokeWidth = n; },
  placeholder: (out, value) => { const c = color(value); if (c !== undefined) out.placeholderColor = c; },
  caret: (out, value) => { const c = color(value); if (c !== undefined) out.caretColor = c; },
  selection: (out, value) => { const c = color(value); if (c !== undefined) out.selectionColor = c; },
};

for (const [suffix, sides] of Object.entries(SIDES)) {
  if (suffix === "") continue;
  HANDLERS[`p${suffix}`] = insetHandler("padding", sides);
  HANDLERS[`m${suffix}`] = insetHandler("margin", sides);
}

const PREFIXES = Object.keys(HANDLERS).sort((a, b) => b.length - a.length);

/** Splits on `:` outside brackets: `hover:bg-[rgb(0_0_0)]` → `["hover", "bg-[rgb(0_0_0)]"]`. */
function splitVariants(token: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i < token.length; i++) {
    const c = token[i];
    if (c === "[") depth++;
    else if (c === "]") depth--;
    else if (c === ":" && depth === 0) { parts.push(token.slice(start, i)); start = i + 1; }
  }
  parts.push(token.slice(start));
  return parts;
}

function applyUtility(out: Out, utility: string): void {
  const negative = utility.startsWith("-");
  const token = negative ? utility.slice(1) : utility;
  const fixed = STATIC[token];
  if (fixed && !negative) { Object.assign(out, fixed); return; }
  for (const prefix of PREFIXES) {
    if (token === prefix) { HANDLERS[prefix](out, "", negative); return; }
    if (token.startsWith(prefix + "-")) { HANDLERS[prefix](out, token.slice(prefix.length + 1), negative); return; }
  }
}

function compile(classes: string): Out {
  const out: Out = {};
  for (const token of classes.split(/\s+/)) {
    if (!token) continue;
    const parts = splitVariants(token);
    const utility = parts.pop()!;
    // Variants the native tree has no notion of (breakpoints, group-hover:) drop the class.
    let dark = false;
    let state: (typeof STATE_VARIANTS)[string] | undefined;
    let supported = true;
    for (const variant of parts) {
      if (variant === "dark") dark = true;
      else if (STATE_VARIANTS[variant]) state = STATE_VARIANTS[variant];
      else supported = false;
    }
    if (!supported) continue;
    let target = dark ? (out.dark as Out | undefined) ?? (out.dark = {}) : out;
    if (state) target = (target[state] as Out | undefined) ?? (target[state] = {});
    applyUtility(target, utility);
  }
  finishGradients(out);
  if (out.dark) finishGradients(out.dark as Out);
  return out;
}

const cache = new Map<string, Out>();

/**
 * Tailwind utility classes as a Tarve style. Falsy arguments are skipped, so it
 * composes like `clsx`: `tw("p-4", active && "bg-primary")`. Later classes win.
 */
export function tw(...classes: readonly (string | false | null | undefined)[]): Style {
  const joined = classes.filter((value): value is string => typeof value === "string" && value.length > 0).join(" ");
  let compiled = cache.get(joined);
  if (!compiled) {
    if (cache.size > 4096) cache.clear();
    compiled = compile(joined);
    for (const key of Object.keys(compiled)) if (compiled[key] === undefined) delete compiled[key];
    cache.set(joined, compiled);
  }
  return { ...compiled } as Style;
}

const ALIASES: Record<string, keyof Style> = {
  backgroundColor: "background", color: "foreground", borderRadius: "radius", flexDirection: "direction",
  alignItems: "align", justifyContent: "justify",
};

/** `className` compiled under an explicit `style`: inline wins, as it does in CSS. */
export function styleWithClassName(className: string, style: Record<string, unknown> | undefined): Record<string, unknown> {
  const compiled = tw(className) as Out;
  if (!style) return compiled;
  for (const alias of Object.keys(ALIASES)) if (style[alias] !== undefined) delete compiled[ALIASES[alias]];
  const merged: Out = { ...compiled, ...style };
  for (const state of ["hover", "focus", "focusVisible", "active", "disabled", "dark"] as const) {
    if (compiled[state] && style[state]) merged[state] = { ...(compiled[state] as Out), ...(style[state] as Out) };
  }
  return merged;
}
const GRADIENT = "\0gradient";
const TRANSITION = "\0transition";
const GRADIENT_SIDES: Record<string, GradientSide> = {
  t: "top", tr: "top right", r: "right", br: "bottom right", b: "bottom", bl: "bottom left", l: "left", tl: "top left",
};
interface PendingGradient { to?: GradientSide; from?: string; via?: string; stop?: string }

function gradientOf(out: Out): PendingGradient {
  return (out[GRADIENT] as PendingGradient | undefined) ?? (out[GRADIENT] = {});
}

function finishGradient(out: Out): void {
  const pending = out[GRADIENT] as PendingGradient | undefined;
  if (!pending) return;
  delete out[GRADIENT];
  if (pending.from === undefined && pending.via === undefined && pending.stop === undefined) return;
  const from = pending.from ?? "transparent";
  const stops = [{ color: from, offset: 0 }];
  if (pending.via !== undefined) stops.push({ color: pending.via, offset: 0.5 });
  // Tailwind's implicit end stop is the start colour at alpha 0, not transparent black.
  stops.push({ color: pending.stop ?? fade(from), offset: 1 });
  out.background = { type: "linear", to: pending.to ?? "bottom", stops } satisfies LinearGradient;
}

function fade(color: string): string {
  if (color.startsWith("#")) return alpha(color.slice(0, 7), 0);
  if (color.startsWith("var(")) return `${color.replace(/\/\d+$/, "")}/0`;
  return "transparent";
}

function finishGradients(out: Out): void {
  finishGradient(out);
  finishTransition(out);
  for (const state of Object.values(STATE_VARIANTS)) {
    if (!out[state]) continue;
    finishGradient(out[state] as Out);
    finishTransition(out[state] as Out);
  }
}
type Corner = "topLeft" | "topRight" | "bottomRight" | "bottomLeft";
const CORNERS: Record<string, readonly Corner[]> = {
  t: ["topLeft", "topRight"], r: ["topRight", "bottomRight"], b: ["bottomRight", "bottomLeft"], l: ["topLeft", "bottomLeft"],
  s: ["topLeft", "bottomLeft"], e: ["topRight", "bottomRight"],
  tl: ["topLeft"], tr: ["topRight"], br: ["bottomRight"], bl: ["bottomLeft"],
  ss: ["topLeft"], se: ["topRight"], es: ["bottomLeft"], ee: ["bottomRight"],
};


