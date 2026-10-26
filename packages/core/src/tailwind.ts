import type { Insets, Length, MotionEasing, Style, Transform, GradientSide, LinearGradient } from "./protocol";
import { theme } from "./theme";
import { PALETTE } from "./tailwind-palette";

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
const RADII: Record<string, number> = { none: 0, xs: 2, sm: 4, "": 4, md: 6, lg: 8, xl: 12, "2xl": 16, "3xl": 24, "4xl": 32, full: 9999 };
/** Tailwind 4's container scale (`--container-*`): `max-w-md`, `w-xs`, `min-w-sm`… */
const CONTAINERS: Record<string, number> = {
  "3xs": 256, "2xs": 288, xs: 320, sm: 384, md: 448, lg: 512, xl: 576, "2xl": 672, "3xl": 768, "4xl": 896, "5xl": 1024, "6xl": 1152, "7xl": 1280,
};
const SHADOWS: Record<string, string> = {
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
const TEXT_SHADOWS: Record<string, string> = {
  "2xs": "0 1px 0 #00000026", xs: "0 1px 1px #00000033", sm: "0 2px 2px #00000013", md: "0 2px 4px #00000013", lg: "0 3px 6px #00000013", none: "none",
};
const BLURS: Record<string, number> = { xs: 4, sm: 8, md: 12, lg: 16, xl: 24, "2xl": 40, "3xl": 64, none: 0 };
const OBJECT_FITS = new Set(["fill", "contain", "cover", "none", "scale-down"]);
const INSET_SHADOWS: Record<string, string> = {
  "2xs": "inset 0 1px #0000000d",
  xs: "inset 0 1px 1px #0000000d",
  sm: "inset 0 2px 4px #0000000d",
  none: "none",
};
const EASINGS: Record<string, MotionEasing> = { linear: "linear", in: "easeIn", out: "easeOut", "in-out": "easeInOut" };
const CURSORS = new Set(["auto", "default", "pointer", "text", "vertical-text", "move", "grab", "grabbing", "not-allowed", "no-drop", "wait", "progress", "help", "crosshair", "copy", "alias", "context-menu", "cell", "zoom-in", "zoom-out", "col-resize", "row-resize", "ew-resize", "ns-resize", "nesw-resize", "nwse-resize", "all-scroll"]);
const BORDER_STYLES = new Set(["solid", "dashed", "dotted", "double", "none", "hidden"]);
const OVERFLOWS = new Set(["visible", "hidden", "clip", "auto", "scroll"]);
const WHITESPACE = new Set(["normal", "nowrap", "pre", "pre-wrap", "pre-line"]);
const STATE_VARIANTS: Record<string, "hover" | "focus" | "focusVisible" | "active" | "disabled" | "groupHover" | "focusWithin"> = {
  hover: "hover", focus: "focus", "focus-visible": "focusVisible", active: "active", disabled: "disabled",
  "group-hover": "groupHover", "focus-within": "focusWithin",
};
/** Variants the reconciler folds (theme, position among siblings, window size, system): each nests a full style, under its Style key. */
const WRAPPER_VARIANTS: Record<string, string> = { dark: "dark", first: "first", last: "last", odd: "odd", even: "even", sm: "sm", md: "md", lg: "lg", xl: "xl", "2xl": "2xl", portrait: "portrait", landscape: "landscape", "pointer-coarse": "pointerCoarse", "pointer-fine": "pointerFine", "motion-reduce": "motionReduce", "motion-safe": "motionSafe" };

const STATIC: Record<string, Out> = {
  flex: { display: "flex" }, "inline-flex": { display: "flex" }, grid: { display: "grid" }, "inline-grid": { display: "grid" },
  block: { display: "block" }, hidden: { display: "none" },
  "flex-row": { direction: "row" }, "flex-row-reverse": { direction: "row-reverse" },
  "flex-col": { direction: "column" }, "flex-col-reverse": { direction: "column-reverse" },
  "flex-wrap": { wrap: true }, "flex-nowrap": { wrap: false },
  "flex-1": { flex: 1 }, "flex-auto": { flex: "1 1 auto" }, "flex-initial": { flex: "0 1 auto" }, "flex-none": { flex: "none" },
  grow: { grow: 1 }, "grow-0": { grow: 0 }, shrink: { shrink: 1 }, "shrink-0": { shrink: 0 },
  "flex-grow": { grow: 1 }, "flex-grow-0": { grow: 0 }, "flex-shrink": { shrink: 1 }, "flex-shrink-0": { shrink: 0 },
  "items-start": { align: "start" }, "items-center": { align: "center" }, "items-end": { align: "end" }, "items-stretch": { align: "stretch" }, "items-baseline": { align: "baseline" },
  "self-auto": { alignSelf: undefined }, "self-start": { alignSelf: "start" }, "self-center": { alignSelf: "center" }, "self-end": { alignSelf: "end" }, "self-stretch": { alignSelf: "stretch" }, "self-baseline": { alignSelf: "baseline" },
  "content-start": { alignContent: "start" }, "content-center": { alignContent: "center" }, "content-end": { alignContent: "end" }, "content-stretch": { alignContent: "stretch" },
  "content-between": { alignContent: "between" }, "content-around": { alignContent: "around" }, "content-evenly": { alignContent: "evenly" },
  "justify-items-start": { justifyItems: "start" }, "justify-items-center": { justifyItems: "center" }, "justify-items-end": { justifyItems: "end" }, "justify-items-stretch": { justifyItems: "stretch" },
  "justify-self-auto": { justifySelf: undefined }, "justify-self-start": { justifySelf: "start" }, "justify-self-center": { justifySelf: "center" }, "justify-self-end": { justifySelf: "end" }, "justify-self-stretch": { justifySelf: "stretch" },
  "place-items-start": { align: "start", justifyItems: "start" }, "place-items-center": { align: "center", justifyItems: "center" }, "place-items-end": { align: "end", justifyItems: "end" }, "place-items-stretch": { align: "stretch", justifyItems: "stretch" },
  "place-content-start": { alignContent: "start", justify: "start" }, "place-content-center": { alignContent: "center", justify: "center" }, "place-content-end": { alignContent: "end", justify: "end" },
  "place-content-between": { alignContent: "between", justify: "between" }, "place-content-around": { alignContent: "around", justify: "around" }, "place-content-evenly": { alignContent: "evenly", justify: "evenly" }, "place-content-stretch": { alignContent: "stretch", justify: "stretch" },
  "place-self-auto": { alignSelf: undefined, justifySelf: undefined }, "place-self-start": { alignSelf: "start", justifySelf: "start" }, "place-self-center": { alignSelf: "center", justifySelf: "center" }, "place-self-end": { alignSelf: "end", justifySelf: "end" }, "place-self-stretch": { alignSelf: "stretch", justifySelf: "stretch" },
  "justify-stretch": { justify: "stretch" }, "text-justify": { textAlign: "justify" },
  group: { group: true }, "pointer-events-none": { pointerEvents: "none" },
  "origin-center": { transform: { originX: 0.5, originY: 0.5 } }, "origin-top": { transform: { originX: 0.5, originY: 0 } }, "origin-top-right": { transform: { originX: 1, originY: 0 } },
  "origin-right": { transform: { originX: 1, originY: 0.5 } }, "origin-bottom-right": { transform: { originX: 1, originY: 1 } }, "origin-bottom": { transform: { originX: 0.5, originY: 1 } },
  "origin-bottom-left": { transform: { originX: 0, originY: 1 } }, "origin-left": { transform: { originX: 0, originY: 0.5 } }, "origin-top-left": { transform: { originX: 0, originY: 0 } },
  "justify-start": { justify: "start" }, "justify-center": { justify: "center" }, "justify-end": { justify: "end" }, "justify-between": { justify: "between" },
  "justify-around": { justify: "around" }, "justify-evenly": { justify: "evenly" },
  relative: { position: "relative" }, absolute: { position: "absolute" }, static: { position: "relative" },
  // Visually hidden, still in the tree for assistive technology, as Tailwind's `sr-only`.
  "sr-only": { position: "absolute", width: 1, height: 1, padding: 0, margin: -1, overflow: "hidden", whiteSpace: "nowrap" },
  "pointer-events-auto": { pointerEvents: "auto" }, "transition-none": { transition: undefined },
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
  "outline-none": { outlineStyle: "none" }, "outline-hidden": { outlineStyle: "none" }, "outline-solid": { outlineStyle: "solid" }, "outline-dashed": { outlineStyle: "dashed" }, "outline-dotted": { outlineStyle: "dotted" },
  "line-clamp-none": { lineClamp: undefined },
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

function setInsets(out: Out, key: "padding" | "margin" | "borderWidth", sides: readonly Side[] | "all", value: number | "auto"): void {
  if (sides === "all") { out[key] = value; return; }
  const current = out[key] as Insets | "auto" | undefined;
  const next: Record<string, number | "auto"> = typeof current === "number" || current === "auto"
    ? { top: current, right: current, bottom: current, left: current }
    : { ...(current ?? {}) };
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
    // CSS auto margins (`mx-auto` centres a box); padding has no auto.
    if (value === "auto" && key === "margin") { setInsets(out, key, sides, "auto"); return; }
    const resolved = length(value, false);
    if (typeof resolved === "number") setInsets(out, key, sides, negative ? -resolved : resolved);
  };
}

/** Widths also take the container scale (`w-xs` = 20rem). */
function containerHandler(key: string, allowAuto = true): Handler {
  const plain = lengthHandler(key, allowAuto);
  return (out, value, negative) => {
    const named = CONTAINERS[value];
    if (named !== undefined) out[key] = named; else plain(out, value, negative);
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
  w: containerHandler("width"), h: lengthHandler("height"),
  "min-w": containerHandler("minWidth", false), "min-h": lengthHandler("minHeight", false),
  "max-h": lengthHandler("maxHeight", false),
  "max-w": (out, value) => {
    if (value === "none") { out.maxWidth = undefined; return; }
    const resolved = CONTAINERS[value] ?? length(value, false);
    if (resolved !== undefined) out.maxWidth = resolved;
  },
  // Logical offsets, read left-to-right.
  start: offsetHandler(["left"]), end: offsetHandler(["right"]),
  // `space-x-*`/`space-y-*` put margins between siblings; a flex gap is the same spacing.
  "space-x": lengthHandler("columnGap", false), "space-y": lengthHandler("rowGap", false),
  object: (out, value) => { if (OBJECT_FITS.has(value)) out.objectFit = value; },
  animate: (out, value) => { if (value === "spin") out.spin = 1000; else if (value === "none") out.spin = undefined; },
  "backdrop-blur": (out, value) => {
    const blur = value === "" ? 8 : BLURS[value] ?? px(arbitrary(value) ?? "");
    if (blur !== undefined) setGlass(out, { blur });
  },
  "backdrop-saturate": (out, value) => { const n = number(value); if (n !== undefined) setGlass(out, { saturate: n / 100 }); },
  "text-shadow": (out, value) => {
    const named = TEXT_SHADOWS[value];
    if (named !== undefined) { out.textShadow = named; return; }
    const c = color(value);
    if (c !== undefined) pendingShadow(out).text = c;
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
    const angle = /^linear-(\d+)$/.exec(value);
    if (angle) { gradientOf(out).angle = Number(angle[1]); return; }
    if (value === "radial") { gradientOf(out).shape = "radial"; return; }
    const conic = /^conic(?:-(\d+))?$/.exec(value);
    if (conic) { gradientOf(out).shape = "conic"; gradientOf(out).angle = conic[1] ? Number(conic[1]) : 0; return; }
    const resolved = color(value);
    if (resolved !== undefined) out.background = resolved;
  },
  from: (out, value) => gradientStop(out, "from", value),
  via: (out, value) => gradientStop(out, "via", value),
  to: (out, value) => gradientStop(out, "stop", value),
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
    if (named !== undefined) { out.boxShadow = named; return; }
    const c = color(value);
    if (c !== undefined) pendingShadow(out).box = c;
  },
  "inset-shadow": (out, value) => {
    const named = INSET_SHADOWS[value] ?? arbitrary(value);
    if (named !== undefined) { out.boxShadow = named; return; }
    const c = color(value);
    if (c !== undefined) pendingShadow(out).box = c;
  },
  cursor: (out, value) => { if (CURSORS.has(value)) out.cursor = value; },
  overflow: (out, value) => { if (OVERFLOWS.has(value)) out.overflow = value; },
  "overflow-x": (out, value) => { if (OVERFLOWS.has(value)) out.overflowX = value; },
  "overflow-y": (out, value) => { if (OVERFLOWS.has(value)) out.overflowY = value; },
  scale: (out, value, negative) => {
    const n = number(value);
    if (n !== undefined) setTransform(out, { scale: (negative ? -n : n) / (arbitrary(value) !== undefined ? 1 : 100) });
  },
  rotate: (out, value, negative) => {
    const raw = arbitrary(value) ?? value;
    const n = /^(-?\d*\.?\d+)(deg)?$/.exec(raw);
    if (n) setTransform(out, { rotate: negative ? -Number(n[1]) : Number(n[1]) });
  },
  "skew-x": (out, value, negative) => { const n = number(value); if (n !== undefined) setTransform(out, { skewX: negative ? -n : n }); },
  "skew-y": (out, value, negative) => { const n = number(value); if (n !== undefined) setTransform(out, { skewY: negative ? -n : n }); },
  skew: (out, value, negative) => { const n = number(value); if (n !== undefined) setTransform(out, { skewX: negative ? -n : n, skewY: negative ? -n : n }); },
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
    const raw = arbitrary(value) ?? value;
    if (raw === "auto") { out.aspectRatio = undefined; return; }
    const ratio = /^(\d*\.?\d+)\s*\/\s*(\d*\.?\d+)$/.exec(raw);
    const resolved = ratio ? Number(ratio[1]) / Number(ratio[2]) : number(raw);
    if (resolved !== undefined) out.aspectRatio = resolved;
  },
  ring: (out, value) => {
    if (value === "") { out.outlineWidth = 1; out.outlineStyle = "solid"; return; }
    const width = px(arbitrary(value) ?? value);
    if (width !== undefined) { out.outlineWidth = width; out.outlineStyle = "solid"; return; }
    const resolved = color(value);
    if (resolved !== undefined) out.outlineColor = resolved;
  },
  "ring-offset": (out, value) => { const n = px(arbitrary(value) ?? value); if (n !== undefined) out.outlineOffset = n; },
  outline: (out, value) => {
    if (value === "") { out.outlineWidth = 1; out.outlineStyle = "solid"; return; }
    const width = px(arbitrary(value) ?? value);
    if (width !== undefined) { out.outlineWidth = width; out.outlineStyle = "solid"; return; }
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
  if (fixed && !negative) {
    // `origin-*` joins the transform instead of replacing it.
    if (fixed.transform) { setTransform(out, fixed.transform as Transform); return; }
    Object.assign(out, fixed);
    return;
  }
  for (const prefix of PREFIXES) {
    if (token === prefix) { HANDLERS[prefix](out, "", negative); return; }
    if (token.startsWith(prefix + "-")) { HANDLERS[prefix](out, token.slice(prefix.length + 1), negative); return; }
  }
}

function compile(classes: string): Out {
  const out: Out = {};
  const wrappers: Out[] = [out];
  for (const token of classes.split(/\s+/)) {
    if (!token) continue;
    const parts = splitVariants(token);
    const utility = parts.pop()!;
    // Wrapper variants (`dark:`, `md:`, `first:`) nest in order; a state variant (`hover:`) goes last,
    // inside them. Variants the native tree has no notion of (`print:`, `peer-*`) drop the class.
    let target = out;
    let state: (typeof STATE_VARIANTS)[string] | undefined;
    let supported = true;
    for (const variant of parts) {
      if (Object.hasOwn(WRAPPER_VARIANTS, variant)) {
        const key = WRAPPER_VARIANTS[variant]!, next = (target[key] as Out | undefined) ?? (target[key] = {});
        if (!wrappers.includes(next)) wrappers.push(next);
        target = next;
      } else if (STATE_VARIANTS[variant]) state = STATE_VARIANTS[variant];
      else supported = false;
    }
    if (!supported) continue;
    if (state) target = (target[state] as Out | undefined) ?? (target[state] = {});
    applyUtility(target, utility);
  }
  for (const wrapper of wrappers) finishGradients(wrapper);
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
  for (const state of ["hover", "focus", "focusVisible", "active", "disabled", "groupHover", "focusWithin", "dark", "first", "last", "odd", "even", "sm", "md", "lg", "xl", "2xl", "portrait", "landscape", "pointerCoarse", "pointerFine", "motionReduce", "motionSafe"] as const) {
    if (compiled[state] && style[state]) merged[state] = { ...(compiled[state] as Out), ...(style[state] as Out) };
  }
  return merged;
}
const GRADIENT = "\0gradient";
const TRANSITION = "\0transition";
const GRADIENT_SIDES: Record<string, GradientSide> = {
  t: "top", tr: "top right", r: "right", br: "bottom right", b: "bottom", bl: "bottom left", l: "left", tl: "top left",
};
interface PendingGradient {
  to?: GradientSide; angle?: number; shape?: "radial" | "conic";
  from?: string; via?: string; stop?: string;
  fromAt?: number; viaAt?: number; stopAt?: number;
}

/** `from-red-500` sets a stop's colour, `from-10%` its position. */
function gradientStop(out: Out, stop: "from" | "via" | "stop", value: string): void {
  const position = /^(\d*\.?\d+)%$/.exec(value);
  if (position) { gradientOf(out)[`${stop}At`] = Number(position[1]) / 100; return; }
  const c = color(value);
  if (c !== undefined) gradientOf(out)[stop] = c;
}

const SHADOW = "\0shadow";
interface PendingShadow { box?: string; text?: string }
function pendingShadow(out: Out): PendingShadow {
  return (out[SHADOW] as PendingShadow | undefined) ?? (out[SHADOW] = {});
}

/** `shadow-red-500` recolours the shadow layers (Tailwind's `--tw-shadow-color` replaces the default black). */
function finishShadow(out: Out): void {
  const pending = out[SHADOW] as PendingShadow | undefined;
  if (!pending) return;
  delete out[SHADOW];
  const recolour = (shadow: string, colour: string) => shadow.replace(/#[0-9a-f]{6,8}\b/gi, colour);
  if (pending.box !== undefined && typeof out.boxShadow === "string" && out.boxShadow !== "none") out.boxShadow = recolour(out.boxShadow, pending.box);
  if (pending.text !== undefined && typeof out.textShadow === "string") out.textShadow = recolour(out.textShadow, pending.text);
}

function setGlass(out: Out, patch: { blur?: number; saturate?: number }): void {
  out.glass = { blur: 0, ...(typeof out.glass === "object" && out.glass ? out.glass as object : {}), ...patch };
}

function gradientOf(out: Out): PendingGradient {
  return (out[GRADIENT] as PendingGradient | undefined) ?? (out[GRADIENT] = {});
}

function finishGradient(out: Out): void {
  const pending = out[GRADIENT] as PendingGradient | undefined;
  if (!pending) return;
  delete out[GRADIENT];
  if (pending.from === undefined && pending.via === undefined && pending.stop === undefined) return;
  const from = pending.from ?? "transparent";
  const stops = [{ color: from, offset: pending.fromAt ?? 0 }];
  if (pending.via !== undefined) stops.push({ color: pending.via, offset: pending.viaAt ?? 0.5 });
  // Tailwind 4's implicit end stop is transparent (`--tw-gradient-to: #0000`).
  stops.push({ color: pending.stop ?? "transparent", offset: pending.stopAt ?? 1 });
  if (pending.shape === "radial") out.background = { type: "radial", stops };
  else if (pending.shape === "conic") out.background = { type: "conic", from: pending.angle ?? 0, stops };
  else if (pending.angle !== undefined) out.background = { type: "linear", angle: pending.angle, stops } satisfies LinearGradient;
  else out.background = { type: "linear", to: pending.to ?? "bottom", stops } satisfies LinearGradient;
}

function finishGradients(out: Out): void {
  finishGradient(out);
  finishTransition(out);
  finishShadow(out);
  for (const state of Object.values(STATE_VARIANTS)) {
    if (!out[state]) continue;
    finishGradient(out[state] as Out);
    finishTransition(out[state] as Out);
    finishShadow(out[state] as Out);
  }
}
type Corner = "topLeft" | "topRight" | "bottomRight" | "bottomLeft";
const CORNERS: Record<string, readonly Corner[]> = {
  t: ["topLeft", "topRight"], r: ["topRight", "bottomRight"], b: ["bottomRight", "bottomLeft"], l: ["topLeft", "bottomLeft"],
  s: ["topLeft", "bottomLeft"], e: ["topRight", "bottomRight"],
  tl: ["topLeft"], tr: ["topRight"], br: ["bottomRight"], bl: ["bottomLeft"],
  ss: ["topLeft"], se: ["topRight"], es: ["bottomLeft"], ee: ["bottomRight"],
};


