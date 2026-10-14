/**
 * Parity with the real Tailwind CSS 4 compiler: every class below is compiled by
 * `tailwindcss` itself and its declarations are compared, one by one, with what
 * `tw()` produces, after both sides are reduced to the same CSS vocabulary
 * (theme variables and `calc()` resolved, rem → px at 16px, `oklch()` and
 * `color-mix()` → hex, Tarve's `justify: "between"` → `justify-content: space-between`, …). Known, intentional differences are listed
 * in `DIVERGENCES` and asserted too, so a change on either side shows up.
 */
import { describe, expect, test } from "bun:test";
import postcss from "postcss";
import { compile } from "@tailwindcss/node";
import { oklchToHex } from "../../../scripts/tailwind-palette";
import { tw } from "./tailwind";
import { theme } from "./theme";
import type { Style, StateStyle } from "./protocol";

type Decls = Record<string, string>;
type Variant = "base" | "hover" | "focus" | "focusVisible" | "active" | "disabled" | "dark";
type Compiled = Partial<Record<Variant, Decls>>;

/** Tarve lays text out at the theme's font size; Tailwind's `em` values are read against it. */
const FONT = theme.font.size;
const REM = 16;

const CLASSES = [
  // spacing
  "p-4", "px-2", "py-0.5", "pt-px", "pb-8", "m-0", "-mt-2", "mx-3", "ml-1.5", "mx-auto", "m-auto", "ms-2", "me-4", "space-x-4", "space-y-2",
  // sizing
  "w-full", "w-1/2", "w-3/4", "w-64", "w-xs", "w-lg", "h-10", "h-screen", "min-w-0", "min-w-sm", "max-w-md", "max-w-3xs", "max-w-none", "size-12", "min-h-40",
  // flex
  "flex", "inline-flex", "block", "hidden", "flex-col", "flex-row-reverse", "flex-wrap", "flex-nowrap",
  "flex-1", "flex-auto", "flex-initial", "flex-none", "grow", "grow-0", "shrink", "shrink-0", "basis-1/2",
  "items-start", "items-center", "items-end", "items-stretch",
  "justify-start", "justify-center", "justify-end", "justify-between", "justify-around", "justify-evenly",
  "gap-2", "gap-px", "gap-x-6", "gap-y-2",
  // grid
  "grid", "grid-cols-4", "col-span-2", "col-span-full", "row-span-3",
  // position
  "relative", "absolute", "static", "inset-0", "inset-x-0", "inset-y-2", "top-1/2", "-left-2", "right-4", "bottom-0", "start-2", "end-0", "z-10", "-z-10", "z-50", "sr-only",
  // typography
  "text-xs", "text-sm", "text-base", "text-lg", "text-xl", "text-2xl", "text-4xl",
  "font-thin", "font-light", "font-normal", "font-medium", "font-semibold", "font-bold", "font-black",
  "font-sans", "font-serif", "font-mono", "italic", "not-italic",
  "leading-none", "leading-tight", "leading-normal", "leading-6", "tracking-tight", "tracking-wide", "tracking-widest",
  "text-left", "text-center", "text-right", "uppercase", "lowercase", "capitalize", "normal-case",
  "underline", "overline", "line-through", "no-underline", "decoration-wavy", "decoration-dotted",
  "truncate", "text-ellipsis", "text-clip", "line-clamp-2", "whitespace-nowrap", "whitespace-pre-wrap",
  // colours
  "bg-red-500", "bg-zinc-900", "bg-slate-50", "bg-emerald-950", "bg-white", "bg-black", "bg-transparent",
  "text-white", "text-slate-400", "text-rose-700", "border-blue-200", "bg-red-500/50", "text-white/80", "border-black/10",
  // borders and radii
  "border", "border-0", "border-2", "border-4", "border-t", "border-b-0", "border-x-4", "border-l-2",
  "border-solid", "border-dashed", "border-dotted", "border-double", "border-none",
  "rounded", "rounded-none", "rounded-xs", "rounded-sm", "rounded-md", "rounded-lg", "rounded-xl", "rounded-2xl", "rounded-3xl", "rounded-4xl", "rounded-full",
  "rounded-t-lg", "rounded-b-2xl", "rounded-l-md", "rounded-r-full", "rounded-tl-xl", "rounded-br-sm",
  // effects
  "shadow-2xs", "shadow-xs", "shadow-sm", "shadow", "shadow-md", "shadow-lg", "shadow-xl", "shadow-2xl", "shadow-none",
  "inset-shadow-2xs", "inset-shadow-xs", "inset-shadow-sm", "outline-hidden",
  "opacity-0", "opacity-50", "opacity-100", "ring", "ring-2", "ring-4", "ring-offset-2", "ring-blue-500", "outline", "outline-2", "outline-red-500",
  "text-shadow-2xs", "text-shadow-xs", "backdrop-blur", "backdrop-blur-sm", "backdrop-blur-xl", "backdrop-saturate-150", "animate-spin", "object-cover", "object-contain",
  // transforms and transitions
  "scale-95", "scale-110", "scale-x-50", "-translate-y-1", "translate-x-2",
  "transition", "transition-colors", "duration-300", "duration-75", "delay-150", "ease-linear", "ease-in", "ease-out", "ease-in-out",
  // interactivity and misc
  "cursor-pointer", "cursor-not-allowed", "cursor-grab", "select-none", "select-text", "select-all",
  "overflow-hidden", "overflow-visible", "overflow-auto", "overflow-x-scroll", "aspect-video", "aspect-square", "aspect-3/2", "pointer-events-auto",
  // arbitrary values
  "p-[10px]", "w-[200px]", "w-[50%]", "h-[2rem]", "bg-[#123456]", "text-[13px]", "text-[#fff]", "rounded-[6px]", "z-[100]", "gap-[3px]",
  "opacity-[0.3]", "tracking-[0.2em]", "leading-[1.2]", "scale-[1.02]",
  // variants
  "hover:bg-red-600", "hover:text-white", "hover:-translate-y-1", "hover:shadow-lg", "focus:ring-2", "focus-visible:ring-4",
  "active:scale-95", "active:opacity-80", "disabled:opacity-50", "disabled:cursor-not-allowed",
  "dark:text-white", "dark:bg-zinc-900", "dark:border-zinc-700", "dark:hover:bg-zinc-800",
];

/** Combinations whose effect only exists together (Tailwind composes them through custom properties). */
const COMPOSITES: string[][] = [
  ["bg-linear-to-r", "from-violet-500", "to-amber-400"],
  ["bg-gradient-to-br", "from-sky-400", "via-fuchsia-500", "to-blue-700"],
  ["bg-linear-to-t", "from-black"],
  ["bg-linear-45", "from-red-500", "to-blue-500"],
  ["bg-linear-to-r", "from-red-500", "from-10%", "via-green-500", "via-30%", "to-blue-500", "to-90%"],
];
/** Colour modifiers that only read with the shadow they recolour. */
const SHADOW_COMPOSITES: string[][] = [
  ["shadow-lg", "shadow-red-500"],
  ["shadow-md", "shadow-blue-500/50"],
  ["inset-shadow-sm", "inset-shadow-black/20"],
  ["text-shadow-xs", "text-shadow-white"],
];

/**
 * Where Tarve deliberately differs, with the reason. The test asserts that these
 * are the only properties that disagree, so a divergence never widens unnoticed.
 */
const DIVERGENCES: Record<string, string[]> = {
  "transition": ["transition-property"],        // Tailwind lists the animatable properties; Tarve transitions what it can animate (`all`).
  "transition-colors": ["transition-property"],
  "h-screen": ["height"],                        // No viewport unit on a native window; the class is ignored.
  "inline-flex": ["display"],                    // No inline formatting context; an inline-flex box is a flex box.
  "static": ["position"],                        // Taffy has no static; relative without offsets is the same box.
  // `space-*` puts a margin on every child but the first; a flex gap is that spacing without touching the children.
  "space-x-4": ["margin-left", "margin-right", "--tw-space-x-reverse", "column-gap"],
  "space-y-2": ["margin-top", "margin-bottom", "--tw-space-y-reverse", "row-gap"],
  "font-sans": ["font-family"],                  // Tarve names one generic family that appears in Tailwind's stack (checked below).
  "font-serif": ["font-family"],
  "font-mono": ["font-family"],
  // CSS animates nothing without a duration; Tarve stores no transition at all then (`transition` or `duration-*` brings one).
  "delay-150": ["transition-delay"],
  "ease-linear": ["transition-timing-function"],
  "ease-in": ["transition-timing-function"],
  "ease-out": ["transition-timing-function"],
  "ease-in-out": ["transition-timing-function"],
};

/** Theme variables (`--color-red-500`, `--spacing`, …) and the `--tw-*` defaults of the compiled sheet. */
let variables = new Map<string, string>();

async function compileTailwind(classes: string[]): Promise<Map<string, Compiled>> {
  const compiler = await compile(
    `@import "tailwindcss/theme.css" layer(theme);\n@import "tailwindcss/utilities.css" layer(utilities);\n@custom-variant dark (&:where(.dark, .dark *));`,
    { base: process.cwd(), onDependency() {} },
  );
  const root = postcss.parse(compiler.build(classes));
  variables = new Map();
  root.walkRules(rule => {
    if (!/^(:root, :host|\*, ::before, ::after, ::backdrop)$/.test(rule.selector)) return;
    rule.walkDecls(decl => { if (decl.prop.startsWith("--")) variables.set(decl.prop, decl.value.replace(/\s+/g, " ")); });
  });
  const out = new Map<string, Compiled>();
  root.walkRules(rule => {
    // `.space-x-4 { :where(& > :not(:last-child)) { … } }`: the nested rule belongs to its class.
    let owner: postcss.Rule | undefined = rule.selector.startsWith(".") || rule.selector.startsWith(":where(.") ? rule : undefined;
    if (!owner && rule.selector.includes("&")) {
      for (let node = rule.parent as postcss.Node | undefined; node; node = node.parent as postcss.Node | undefined) {
        if (node.type === "rule" && (node as postcss.Rule).selector.startsWith(".")) { owner = node as postcss.Rule; break; }
      }
    }
    if (!owner) return;
    // Nested rules: a utility inside `@media (hover: hover)`; `@supports` blocks carry the modern value, their siblings the fallback.
    let modern = false, forcedColors = false;
    for (let node = rule.parent as postcss.Node | undefined; node; node = node.parent as postcss.Node | undefined) {
      if (node.type === "atrule") {
        const at = node as postcss.AtRule;
        if (at.name === "supports") modern = true;
        if (at.name === "media" && at.params.includes("forced-colors")) forcedColors = true;
      }
    }
    if (forcedColors) return;
    for (const selector of owner.selectors) {
      const parsed = parseSelector(selector);
      if (!parsed) continue;
      const decls: Decls = {};
      rule.each(node => {
        if (node.type === "decl") decls[node.prop] = node.value;
        else if (node.type === "atrule" && node.name === "supports") {
          node.walkDecls(decl => { decls[decl.prop] = decl.value; }); // the modern value wins
        }
      });
      const entry = out.get(parsed.className) ?? {};
      entry[parsed.variant] = modern ? { ...entry[parsed.variant], ...decls } : { ...decls, ...entry[parsed.variant] };
      out.set(parsed.className, entry);
    }
  });
  return out;
}

function parseSelector(selector: string): { className: string; variant: Variant } | undefined {
  // `.hover\:bg-red-600:hover`, `.dark\:text-white:where(.dark, .dark *)`
  const match = /^(?::where\()?\.((?:\\.|[^\s:.>)])+)(.*)$/.exec(selector);
  if (!match) return undefined;
  const className = match[1]!.replace(/\\(.)/g, "$1");
  const rest = match[2]!;
  let variant: Variant = "base";
  if (rest.includes(":hover")) variant = "hover";
  else if (rest.includes(":focus-visible")) variant = "focusVisible";
  else if (rest.includes(":focus")) variant = "focus";
  else if (rest.includes(":active")) variant = "active";
  else if (rest.includes(":disabled")) variant = "disabled";
  if (rest.includes(":where(.dark, .dark *)")) variant = variant === "base" ? "dark" : variant; // dark:hover: → hover inside dark
  return { className, variant };
}

const hex2 = (n: number) => Math.round(n).toString(16).padStart(2, "0");

/** `var(--x, fallback)` → the sheet's value, recursively; unknown variables keep their fallback. */
function substitute(value: string, depth = 0): string {
  if (depth > 10) return value;
  const next = value.replace(/var\((--[\w-]+)(?:,\s*([^()]*(?:\([^()]*\)[^()]*)*))?\)/g, (_, name: string, fallback?: string) => {
    const known = variables.get(name);
    if (known !== undefined && known !== "initial") return known;
    return fallback ?? "";
  });
  return next === value ? next : substitute(next, depth + 1);
}

/** Tailwind 4 arithmetic: `calc(var(--spacing) * 4)`, `calc(1 / 2 * 100%)`, `calc(1.25 / 0.875)`, `calc(2px + 0px)`. */
function evaluateCalc(value: string): string {
  return value.replace(/calc\(([^()]*)\)/g, (_, body: string) => {
    const expr = body.trim();
    const percent = expr.includes("%");
    const numeric = expr.replace(/(-?\d*\.?\d+)rem/g, (_, n) => String(Number(n) * REM)).replace(/(-?\d*\.?\d+)(px|%|ms)/g, "$1");
    if (!/^[\d.\s*+\/-]+$/.test(numeric)) return `calc(${body})`;
    const result = Function(`"use strict"; return (${numeric});`)() as number;
    const rounded = Math.round(result * 10000) / 10000;
    return percent ? `${rounded}%` : String(rounded);
  });
}

/** One CSS vocabulary for both sides: px numbers, hex colours, Tailwind keywords. */
function normalize(prop: string, raw: string): string {
  let value = evaluateCalc(substitute(raw.trim()));
  value = value.replace(/\s*var\(--tw-gradient-(?:from|via|to)-position\)/g, "");
  value = value.replace(/oklch\([^()]*\)/g, m => oklchToHex(m));
  value = value.replace(/rgb\((\d+) (\d+) (\d+)(?: \/ ([\d.]+|var\([^)]*\)))?\)/g, (_, r, g, b, a) => {
    const alpha = a === undefined || String(a).startsWith("var(") ? 1 : Number(a);
    return `#${hex2(+r)}${hex2(+g)}${hex2(+b)}${alpha === 1 ? "" : hex2(alpha * 255)}`;
  });
  value = value.replace(/\btransparent\b/g, "#00000000");
  // `color-mix(in oklab, <colour> 50%, transparent)` → the colour at that alpha; shadows nest one inside another.
  for (let previous = ""; previous !== value;) {
    previous = value;
    value = value.replace(/color-mix\(in (?:oklab|srgb), ([^,()]+?) ([\d.]+)%, (?:transparent|#00000000)\)/g, (_, color: string, pct: string) => {
      const base = normalize("color", color);
      if (!base.startsWith("#")) return base;
      const own = base.length === 9 ? parseInt(base.slice(7), 16) / 255 : 1;
      const alpha = own * (Number(pct) / 100);
      return alpha >= 0.999 ? base.slice(0, 7) : `${base.slice(0, 7)}${hex2(alpha * 255)}`;
    });
  }
  value = value.replace(/#([0-9a-f]{3,4})\b/gi, (_, d: string) => "#" + [...d].map(c => c + c).join(""));
  value = value.replace(/#[0-9a-f]{8}\b/gi, m => m.endsWith("ff") ? m.slice(0, 7) : m);
  value = value.replace(/(-?\d*\.?\d+)rem/g, (_, n) => `${Number(n) * REM}`);
  value = value.replace(/(-?\d*\.?\d+)em/g, (_, n) => `${Math.round(Number(n) * FONT * 100) / 100}`);
  value = value.replace(/(-?\d*\.?\d+)px/g, "$1");
  if (prop === "opacity" || prop.startsWith("--tw-scale")) value = value.replace(/^(-?\d*\.?\d+)%$/, (_, n) => String(Number(n) / 100));
  if (prop === "text-align") value = value === "left" ? "start" : value === "right" ? "end" : value;
  if (prop === "flex") value = expandFlex(value);
  if (/radius$/.test(prop)) value = value.replace(/^calc\(infinity \* 1\)$/, "9999");
  if (prop === "grid-column" || prop === "grid-row") value = value.replace(/^span (\d+) \/ span \1$/, "span $1");
  if (prop === "aspect-ratio") { const [a, b] = value.split("/").map(Number); value = String(b ? a! / b : a); }
  if (prop === "--tw-shadow" && value === "0 0 #00000000") value = "none";
  if (prop === "--tw-ring-shadow") {
    const width = /0 0 0 (\d+(?:\.\d+)?) /.exec(value);
    value = width ? width[1]! : value;
  }
  if (prop === "transition-timing-function") {
    value = { "cubic-bezier(0.4, 0, 0.2, 1)": "easeInOut", "cubic-bezier(0.4, 0, 1, 1)": "easeIn", "cubic-bezier(0, 0, 0.2, 1)": "easeOut", linear: "linear" }[value] ?? value;
  }
  if (prop === "transition-duration" || prop === "transition-delay") value = value.replace(/ms$/, "");
  return value.replace(/\s+/g, " ").replace(/\.(\d*?)0+(?=\D|$)/g, (_, d) => d ? `.${d}` : "").replace(/^(-?)\./, "$10.");
}

/** CSS `flex` shorthand → `grow shrink basis`, so `auto`, `1`, `0 auto` and `1 1 0%` compare as what they mean. */
function expandFlex(value: string): string {
  if (value === "none") return "0 0 auto";
  if (value === "auto") return "1 1 auto";
  if (value === "initial") return "0 1 auto";
  const parts = value.split(" ");
  if (parts.length === 1) return /^\d*\.?\d+$/.test(value) ? `${value} 1 0` : `1 1 ${value}`;
  if (parts.length === 2) return /^\d*\.?\d+$/.test(parts[1]!) ? `${parts[0]} ${parts[1]} 0` : `${parts[0]} 1 ${parts[1]}`;
  return value.replace(/\b0%$/, "0");
}

/** Tailwind 4 writes logical shorthands; Tarve has physical sides. */
const LOGICAL: Record<string, string[]> = {
  "padding-inline": ["padding-left", "padding-right"], "padding-block": ["padding-top", "padding-bottom"],
  "margin-inline": ["margin-left", "margin-right"], "margin-block": ["margin-top", "margin-bottom"],
  "inset-inline": ["left", "right"], "inset-block": ["top", "bottom"],
  "border-inline-width": ["border-left-width", "border-right-width"], "border-block-width": ["border-top-width", "border-bottom-width"],
  "padding-inline-start": ["padding-left"], "padding-inline-end": ["padding-right"],
  "margin-inline-start": ["margin-left"], "margin-inline-end": ["margin-right"],
  "margin-block-start": ["margin-top"], "margin-block-end": ["margin-bottom"],
  "inset-inline-start": ["left"], "inset-inline-end": ["right"],
};

/** Properties Tailwind emits for bookkeeping; the compared value lives elsewhere. */
const IGNORED = new Set([
  "--tw-bg-opacity", "--tw-text-opacity", "--tw-border-opacity", "--tw-ring-opacity", "--tw-shadow-colored",
  "--tw-ring-offset-shadow", "--tw-gradient-stops", "--tw-gradient-position", "transform", "translate", "scale", "box-shadow",
  "-webkit-box-orient", "-webkit-user-select", "--tw-ring-inset", "background-image", "--tw-border-style",
  "--tw-leading", "--tw-font-weight", "--tw-tracking", "--tw-duration", "--tw-ease", "--tw-scale-z", "--tw-outline-style",
  "border-top-style", "border-right-style", "border-bottom-style", "border-left-style", "border-inline-style", "border-block-style",
  "-webkit-backdrop-filter", "backdrop-filter", "--tw-text-shadow-color", "--tw-shadow-color", "--tw-inset-shadow-color",
  "clip", "border-width", "clip-path",
]);

function expected(compiled: Decls): Decls {
  const out: Decls = {};
  for (const [prop, value] of Object.entries(compiled)) {
    if (IGNORED.has(prop)) continue;
    if (prop === "display" && value === "-webkit-box") continue;
    if (prop === "border-style" && value === "var(--tw-border-style)") continue; // `border` sets the width; the style is the default
    if (prop === "max-width" && value === "none") continue; // Tarve: no maxWidth at all
    if (prop === "inset") { for (const side of SIDES) out[side] = normalize(side, value); continue; } // Tarve has no shorthand
    if (LOGICAL[prop]) { for (const side of LOGICAL[prop]) out[side] = normalize(side, value); continue; }
    out[prop] = normalize(prop, value);
  }
  // Tailwind writes line-height in px next to the font size; Tarve keeps a multiple of it.
  if (out["line-height"] !== undefined && Number(out["line-height"]) > 4) {
    const font = Number(out["font-size"] ?? FONT);
    out["line-height"] = String(Math.round((Number(out["line-height"]) / font) * 1000) / 1000);
  }
  return out;
}

const SIDES = ["top", "right", "bottom", "left"] as const;
type Side = (typeof SIDES)[number];
const CORNERS: Record<string, string> = { topLeft: "top-left", topRight: "top-right", bottomRight: "bottom-right", bottomLeft: "bottom-left" };

function insets(prop: string, value: Style["padding"] | Style["margin"], out: Decls, suffix = ""): void {
  if (typeof value === "number" || typeof value === "string") { out[prop + suffix] = String(value); return; }
  if (!value) return;
  const sides = value as Partial<Record<Side, number | string>>;
  for (const side of SIDES) if (sides[side] !== undefined) out[`${prop}-${side}${suffix}`] = String(sides[side]);
}

function paint(value: StateStyle["background"]): string | undefined {
  if (typeof value === "string") return value;
  if (value && value.type === "linear") {
    // Positions print only when they differ from the defaults (0%, 50%, 100%), as Tailwind's variables do.
    const defaults = value.stops.length === 3 ? [0, 0.5, 1] : [0, 1];
    const stops = value.stops.map((stop, index) => {
      if (typeof stop === "string") return stop;
      const offset = typeof stop.offset === "number" ? stop.offset : undefined;
      return offset !== undefined && offset !== defaults[index] ? `${stop.color} ${offset * 100}%` : stop.color;
    });
    return `linear-gradient(${value.angle !== undefined ? `${value.angle}deg` : `to ${value.to}`}, ${stops.join(", ")})`;
  }
  return undefined;
}

/** Tarve style → the CSS declarations Tailwind would write for it. */
function toCss(style: Style | StateStyle): Decls {
  const s = style as Style & Record<string, unknown>;
  const out: Decls = {};
  insets("padding", s.padding, out);
  insets("margin", s.margin, out);
  if (s.borderWidth !== undefined) {
    if (typeof s.borderWidth === "number") out["border-width"] = String(s.borderWidth);
    else for (const side of SIDES) if (s.borderWidth[side] !== undefined) out[`border-${side}-width`] = String(s.borderWidth[side]);
  }
  if (s.radius !== undefined) {
    if (typeof s.radius === "number") out["border-radius"] = String(s.radius);
    else for (const [corner, css] of Object.entries(CORNERS)) {
      const radius = (s.radius as Record<string, number>)[corner];
      if (radius) out[`border-${css}-radius`] = String(radius);
    }
  }
  const length = (v: unknown) => typeof v === "number" ? String(v) : String(v);
  for (const [key, css] of [["width", "width"], ["height", "height"], ["minWidth", "min-width"], ["minHeight", "min-height"], ["maxWidth", "max-width"], ["maxHeight", "max-height"], ["top", "top"], ["right", "right"], ["bottom", "bottom"], ["left", "left"], ["basis", "flex-basis"]] as const) {
    if (s[key] !== undefined) out[css] = length(s[key]);
  }
  if (s.gap !== undefined) out.gap = String(s.gap);
  if (s.rowGap !== undefined) out["row-gap"] = String(s.rowGap);
  if (s.columnGap !== undefined) out["column-gap"] = String(s.columnGap);
  if (s.display !== undefined) out.display = s.display;
  if (s.direction !== undefined) out["flex-direction"] = s.direction;
  if (s.wrap !== undefined) out["flex-wrap"] = s.wrap ? "wrap" : "nowrap";
  if (s.align !== undefined) out["align-items"] = s.align === "start" || s.align === "end" ? `flex-${s.align}` : s.align;
  if (s.justify !== undefined) out["justify-content"] = { start: "flex-start", end: "flex-end", center: "center", between: "space-between", around: "space-around", evenly: "space-evenly" }[s.justify];
  if (s.flex !== undefined) out.flex = typeof s.flex === "number" ? `${s.flex} 1 0` : s.flex;
  if (s.grow !== undefined) out["flex-grow"] = String(s.grow);
  if (s.shrink !== undefined) out["flex-shrink"] = String(s.shrink);
  if (s.position !== undefined) out.position = s.position;
  if (s.zIndex !== undefined) out["z-index"] = String(s.zIndex);
  if (s.columns !== undefined) out["grid-template-columns"] = typeof s.columns === "number" ? `repeat(${s.columns}, minmax(0, 1fr))` : s.columns;
  if (s.gridColumn !== undefined) out["grid-column"] = String(s.gridColumn);
  if (s.gridRow !== undefined) out["grid-row"] = String(s.gridRow);
  if (s.background !== undefined) {
    const value = paint(s.background);
    if (typeof s.background === "string") out["background-color"] = value!;
    else if (value) out.gradient = value;
  }
  if (s.foreground !== undefined) out.color = paint(s.foreground)!;
  if (s.borderColor !== undefined) out["border-color"] = paint(s.borderColor)!;
  if (s.borderStyle !== undefined) out["border-style"] = s.borderStyle;
  if (s.opacity !== undefined) out.opacity = String(s.opacity);
  if (s.fontSize !== undefined) out["font-size"] = String(s.fontSize);
  if (s.fontWeight !== undefined) out["font-weight"] = String(s.fontWeight);
  if (s.fontFamily !== undefined) out["font-family"] = s.fontFamily;
  if (s.fontStyle !== undefined) out["font-style"] = s.fontStyle;
  if (s.lineHeight !== undefined) out["line-height"] = String(s.lineHeight);
  if (s.letterSpacing !== undefined) out["letter-spacing"] = String(s.letterSpacing);
  if (s.textAlign !== undefined) out["text-align"] = s.textAlign;
  if (s.textTransform !== undefined) out["text-transform"] = s.textTransform;
  if (s.textDecoration !== undefined) out["text-decoration-line"] = s.textDecoration;
  if (s.textDecorationStyle !== undefined) out["text-decoration-style"] = s.textDecorationStyle;
  if (s.whiteSpace !== undefined) out["white-space"] = s.whiteSpace;
  if (s.textOverflow !== undefined) out["text-overflow"] = s.textOverflow;
  if (s.overflow !== undefined) out.overflow = s.overflow;
  if (s.overflowX !== undefined) out["overflow-x"] = String(s.overflowX);
  if (s.lineClamp !== undefined) out["-webkit-line-clamp"] = String(s.lineClamp);
  if (s.cursor !== undefined) out.cursor = s.cursor;
  if (s.userSelect !== undefined) out["user-select"] = s.userSelect;
  if (s.aspectRatio !== undefined) out["aspect-ratio"] = String(s.aspectRatio);
  if (typeof s.boxShadow === "string") out[s.boxShadow.startsWith("inset") ? "--tw-inset-shadow" : "--tw-shadow"] = s.boxShadow;
  if (typeof s.textShadow === "string") out["text-shadow"] = s.textShadow;
  if (s.objectFit !== undefined) out["object-fit"] = String(s.objectFit);
  if (s.pointerEvents !== undefined) out["pointer-events"] = s.pointerEvents;
  if (typeof s.spin === "number") out.animation = `spin ${s.spin / 1000}s linear infinite`;
  if (s.glass && typeof s.glass === "object") {
    if (s.glass.blur) out["--tw-backdrop-blur"] = `blur(${s.glass.blur})`;
    if (s.glass.saturate !== undefined) out["--tw-backdrop-saturate"] = `saturate(${s.glass.saturate * 100}%)`;
  }
  if (s.outlineStyle !== undefined) out["outline-style"] = s.outlineStyle;
  if (s.transform && typeof s.transform === "object") {
    const t = s.transform;
    if (t.scale !== undefined) { out["--tw-scale-x"] = String(t.scale); out["--tw-scale-y"] = String(t.scale); }
    if (t.scaleX !== undefined) out["--tw-scale-x"] = String(t.scaleX);
    if (t.scaleY !== undefined) out["--tw-scale-y"] = String(t.scaleY);
    if (t.x !== undefined) out["--tw-translate-x"] = String(t.x);
    if (t.y !== undefined) out["--tw-translate-y"] = String(t.y);
  }
  if (s.transition?.all) {
    const all = s.transition.all;
    if (all.duration !== undefined) out["transition-duration"] = String(all.duration);
    if (all.delay !== undefined) out["transition-delay"] = String(all.delay);
    if (all.easing !== undefined) out["transition-timing-function"] = all.easing;
  }
  if (s.outlineWidth !== undefined) out["--tw-ring-shadow"] = String(s.outlineWidth);
  if (s.outlineOffset !== undefined) out["--tw-ring-offset-width"] = String(s.outlineOffset);
  if (s.outlineColor !== undefined) out["--tw-ring-color"] = s.outlineColor;
  return Object.fromEntries(Object.entries(out).map(([k, v]) => [k, normalize(k, v)]));
}

/** Tailwind's `transition` also sets the default curve and duration; `ring-*` sets the ring colour default. */
function actual(className: string): Compiled {
  const style = tw(className);
  const out: Compiled = { base: toCss(style) };
  for (const variant of ["hover", "focus", "focusVisible", "active", "disabled", "dark"] as const) {
    const sub = (style as Record<string, unknown>)[variant] as Style | undefined;
    if (!sub) continue;
    const nested = sub.hover ? toCss(sub.hover) : toCss(sub);
    out[variant === "dark" && sub.hover ? "hover" : variant] = nested;
  }
  // Rings and outlines are both Tarve outlines: `ring-*` reads as Tailwind's `--tw-ring-*`, `outline-*` as CSS outline.
  const isOutline = /(^|\s|:)outline/.test(className);
  for (const decls of Object.values(out)) {
    if (!decls["--tw-ring-shadow"] && !decls["--tw-ring-color"]) continue;
    if (isOutline) {
      if (decls["--tw-ring-shadow"]) { decls["outline-width"] = decls["--tw-ring-shadow"]; delete decls["--tw-ring-shadow"]; }
      if (decls["--tw-ring-color"]) { decls["outline-color"] = decls["--tw-ring-color"]; delete decls["--tw-ring-color"]; }
    } else delete decls["outline-style"];
  }
  return out;
}

function same(a: string, b: string): boolean {
  if (a === b) return true;
  const na = Number(a), nb = Number(b);
  return Number.isFinite(na) && Number.isFinite(nb) && Math.abs(na - nb) <= 0.011;
}

function compare(className: string, want: Decls, got: Decls): string[] {
  const problems: string[] = [];
  const allowed = new Set(DIVERGENCES[className] ?? []);
  for (const [prop, value] of Object.entries(want)) {
    if (allowed.has(prop)) continue;
    if (!(prop in got)) problems.push(`${className}: missing ${prop}: ${value}`);
    else if (!same(value, got[prop]!)) problems.push(`${className}: ${prop} is ${got[prop]}, Tailwind says ${value}`);
  }
  for (const prop of Object.keys(got)) {
    if (allowed.has(prop)) continue;
    if (!(prop in want)) problems.push(`${className}: extra ${prop}: ${got[prop]}`);
  }
  return problems;
}

describe("tw() matches Tailwind CSS 4 class by class", () => {
  test("single utilities, variants and arbitrary values", async () => {
    const compiled = await compileTailwind(CLASSES);
    const problems: string[] = [];
    for (const className of CLASSES) {
      const want = compiled.get(className);
      if (!want) { problems.push(`${className}: Tailwind produced nothing`); continue; }
      const got = actual(className);
      for (const variant of Object.keys(want) as Variant[]) {
        const wantDecls = expected(want[variant]!);
        const gotDecls = got[variant] ?? {};
        if (Object.keys(wantDecls).length === 0) continue;
        problems.push(...compare(className, wantDecls, gotDecls));
      }
    }
    expect(problems).toEqual([]);
  });

  test("intentional divergences stay exactly where documented", async () => {
    const compiled = await compileTailwind(Object.keys(DIVERGENCES));
    for (const [className, props] of Object.entries(DIVERGENCES)) {
      const want = expected(compiled.get(className)!.base!);
      const got = actual(className).base!;
      for (const prop of props) {
        expect(want[prop] === got[prop]).toBe(false);
        if (prop === "font-family") {
          // Tarve names one family: a generic one from Tailwind's stack, or `system-ui`, the platform UI font
          // that Tailwind's sans stack reaches through -apple-system / Segoe UI / Roboto.
          const stack = want[prop]!.split(",").map(f => f.trim().replace(/["']/g, ""));
          expect(stack.includes(got[prop]!) || (got[prop] === "system-ui" && stack.includes("sans-serif"))).toBe(true);
        }
      }
    }
  });

  test("coloured shadows recolour the size's layers", async () => {
    const compiled = await compileTailwind(SHADOW_COMPOSITES.flat());
    for (const [size, colour] of SHADOW_COMPOSITES) {
      const text = size!.startsWith("text-"), inset = size!.startsWith("inset-");
      const prop = text ? "text-shadow" : inset ? "--tw-inset-shadow" : "--tw-shadow";
      const colourProp = text ? "--tw-text-shadow-color" : inset ? "--tw-inset-shadow-color" : "--tw-shadow-color";
      variables.set(colourProp, compiled.get(colour!)!.base![colourProp]!);
      const want = normalize(prop, compiled.get(size!)!.base![prop]!);
      variables.delete(colourProp);
      expect(actual(`${size} ${colour}`).base![prop]).toBe(want);
    }
  });

  test("gradient composites: direction and stops", async () => {
    const compiled = await compileTailwind(COMPOSITES.flat());
    for (const classes of COMPOSITES) {
      const position = compiled.get(classes[0]!)!.base!["--tw-gradient-position"]!.replace(/ in oklab$/, "");
      const stopOf = (kind: string) => {
        const colourClass = classes.find(name => name.startsWith(`${kind}-`) && !/%$/.test(name));
        const positionClass = classes.find(name => name.startsWith(`${kind}-`) && /%$/.test(name));
        if (!colourClass) return undefined;
        const decls = compiled.get(colourClass)!.base!;
        const colour = normalize("color", decls[`--tw-gradient-${kind}`]!);
        const at = positionClass ? normalize("x", compiled.get(positionClass)!.base![`--tw-gradient-${kind}-position`]!) : undefined;
        return at === undefined ? colour : `${colour} ${at}`;
      };
      // Tailwind 4's implicit end stop is transparent (`--tw-gradient-to: #0000`), interpolated in OKLab.
      const stops = [stopOf("from"), stopOf("via"), stopOf("to") ?? "#00000000"].filter((stop): stop is string => stop !== undefined);
      const want = `linear-gradient(${position}, ${stops.join(", ")})`;
      expect(actual(classes.join(" ")).base!.gradient).toBe(normalize("gradient", want));
    }
  });
});
