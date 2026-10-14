/**
 * Parity with the real Tailwind CSS compiler (v3.4): every class below is compiled by
 * `tailwindcss` itself and its declarations are compared, one by one, with what
 * `tw()` produces, after both sides are reduced to the same CSS vocabulary
 * (rem → px at 16px, Tailwind's `rgb(r g b / a)` → hex, Tarve's `justify: "between"`
 * → `justify-content: space-between`, …). Known, intentional differences are listed
 * in `DIVERGENCES` and asserted too, so a change on either side shows up.
 */
import { describe, expect, test } from "bun:test";
import postcss from "postcss";
import tailwindcss from "tailwindcss";
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
  "p-4", "px-2", "py-0.5", "pt-px", "pb-8", "m-0", "-mt-2", "mx-3", "ml-1.5",
  // sizing
  "w-full", "w-1/2", "w-3/4", "w-64", "h-10", "h-screen", "min-w-0", "max-w-md", "max-w-none", "size-12", "min-h-40",
  // flex
  "flex", "inline-flex", "block", "hidden", "flex-col", "flex-row-reverse", "flex-wrap", "flex-nowrap",
  "flex-1", "flex-auto", "flex-initial", "flex-none", "grow", "grow-0", "shrink", "shrink-0", "basis-1/2",
  "items-start", "items-center", "items-end", "items-stretch",
  "justify-start", "justify-center", "justify-end", "justify-between", "justify-around", "justify-evenly",
  "gap-2", "gap-px", "gap-x-6", "gap-y-2",
  // grid
  "grid", "grid-cols-4", "col-span-2", "col-span-full", "row-span-3",
  // position
  "relative", "absolute", "inset-0", "inset-x-0", "inset-y-2", "top-1/2", "-left-2", "right-4", "bottom-0", "z-10", "-z-10", "z-50",
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
  "rounded", "rounded-none", "rounded-sm", "rounded-md", "rounded-lg", "rounded-xl", "rounded-2xl", "rounded-3xl", "rounded-full",
  "rounded-t-lg", "rounded-b-2xl", "rounded-l-md", "rounded-r-full", "rounded-tl-xl", "rounded-br-sm",
  // effects
  "shadow-sm", "shadow", "shadow-md", "shadow-lg", "shadow-xl", "shadow-2xl", "shadow-inner", "shadow-none",
  "opacity-0", "opacity-50", "opacity-100", "ring-2", "ring-4", "ring-offset-2", "ring-blue-500",
  // transforms and transitions
  "scale-95", "scale-110", "scale-x-50", "-translate-y-1", "translate-x-2",
  "transition", "transition-colors", "duration-300", "duration-75", "delay-150", "ease-linear", "ease-in", "ease-out", "ease-in-out",
  // interactivity and misc
  "cursor-pointer", "cursor-not-allowed", "cursor-grab", "select-none", "select-text", "select-all",
  "overflow-hidden", "overflow-visible", "overflow-auto", "overflow-x-scroll", "aspect-video", "aspect-square",
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
  ["bg-gradient-to-r", "from-violet-500", "to-amber-400"],
  ["bg-gradient-to-br", "from-sky-400", "via-fuchsia-500", "to-blue-700"],
  ["bg-gradient-to-t", "from-black"],
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

async function compileTailwind(classes: string[]): Promise<Map<string, Compiled>> {
  const result = await postcss([
    tailwindcss({ content: [{ raw: classes.join(" "), extension: "html" }], darkMode: "class", corePlugins: { preflight: false } }),
  ]).process("@tailwind utilities;", { from: undefined });
  const out = new Map<string, Compiled>();
  result.root.walkRules(rule => {
    for (const selector of rule.selectors) {
      const parsed = parseSelector(selector);
      if (!parsed) continue;
      const decls: Decls = {};
      rule.walkDecls(decl => { decls[decl.prop] = decl.value; });
      const entry = out.get(parsed.className) ?? {};
      entry[parsed.variant] = { ...entry[parsed.variant], ...decls };
      out.set(parsed.className, entry);
    }
  });
  return out;
}

function parseSelector(selector: string): { className: string; variant: Variant } | undefined {
  // `.hover\:bg-red-600:hover`, `.dark\:text-white:is(.dark *)`, `.dark\:hover\:bg-zinc-800:hover:is(.dark *)`
  const match = /^\.((?:\\.|[^\s:.])+)(.*)$/.exec(selector);
  if (!match) return undefined;
  const className = match[1]!.replace(/\\(.)/g, "$1");
  const rest = match[2]!;
  let variant: Variant = "base";
  if (rest.includes(":hover")) variant = "hover";
  else if (rest.includes(":focus-visible")) variant = "focusVisible";
  else if (rest.includes(":focus")) variant = "focus";
  else if (rest.includes(":active")) variant = "active";
  else if (rest.includes(":disabled")) variant = "disabled";
  if (rest.includes(":is(.dark *)")) variant = variant === "base" ? "dark" : variant; // dark:hover: → hover inside dark
  return { className, variant };
}

const hex2 = (n: number) => Math.round(n).toString(16).padStart(2, "0");

/** One CSS vocabulary for both sides: px numbers, hex colours, Tailwind keywords. */
function normalize(prop: string, raw: string): string {
  let value = raw.trim();
  value = value.replace(/\s*var\(--tw-gradient-(?:from|via|to)-position\)/g, "");
  value = value.replace(/rgb\((\d+) (\d+) (\d+)(?: \/ ([\d.]+|var\([^)]*\)))?\)/g, (_, r, g, b, a) => {
    const alpha = a === undefined || String(a).startsWith("var(") ? 1 : Number(a);
    return `#${hex2(+r)}${hex2(+g)}${hex2(+b)}${alpha === 1 ? "" : hex2(alpha * 255)}`;
  });
  value = value.replace(/#([0-9a-f]{3,4})\b/gi, (_, d: string) => "#" + [...d].map(c => c + c).join(""));
  value = value.replace(/#[0-9a-f]{8}\b/gi, m => m.endsWith("ff") ? m.slice(0, 7) : m);
  value = value.replace(/(-?\d*\.?\d+)rem/g, (_, n) => `${Number(n) * REM}`);
  value = value.replace(/(-?\d*\.?\d+)em/g, (_, n) => `${Math.round(Number(n) * FONT * 100) / 100}`);
  value = value.replace(/(-?\d*\.?\d+)px/g, "$1");
  if (prop === "text-align") value = value === "left" ? "start" : value === "right" ? "end" : value;
  if (prop === "flex" && /^\d+$/.test(value)) value = `${value} 1 0`;
  if (prop === "flex") value = value.replace(/\b0%$/, "0");
  if (prop === "grid-column" || prop === "grid-row") value = value.replace(/^span (\d+) \/ span \1$/, "span $1");
  if (prop === "aspect-ratio") { const [a, b] = value.split("/").map(Number); value = String(b ? a! / b : a); }
  if (prop === "--tw-shadow" && value === "0 0 #00000000") value = "none";
  if (prop === "--tw-ring-shadow") {
    const width = /calc\((\d+) \+ var\(--tw-ring-offset-width\)\)/.exec(value);
    value = width ? width[1]! : value;
  }
  if (prop === "transition-timing-function") {
    value = { "cubic-bezier(0.4, 0, 0.2, 1)": "easeInOut", "cubic-bezier(0.4, 0, 1, 1)": "easeIn", "cubic-bezier(0, 0, 0.2, 1)": "easeOut", linear: "linear" }[value] ?? value;
  }
  if (prop === "transition-duration" || prop === "transition-delay") value = value.replace(/ms$/, "");
  return value.replace(/\s+/g, " ").replace(/\.(\d*?)0+(?=\D|$)/g, (_, d) => d ? `.${d}` : "").replace(/^(-?)\./, "$10.");
}

/** Properties Tailwind emits for bookkeeping; the compared value lives elsewhere. */
const IGNORED = new Set([
  "--tw-bg-opacity", "--tw-text-opacity", "--tw-border-opacity", "--tw-ring-opacity", "--tw-shadow-colored",
  "--tw-ring-offset-shadow", "--tw-gradient-stops", "transform", "box-shadow", "display:-webkit-box", "-webkit-box-orient",
  "-webkit-user-select", "--tw-ring-inset", "background-image",
]);

function expected(compiled: Decls): Decls {
  const out: Decls = {};
  for (const [prop, value] of Object.entries(compiled)) {
    if (IGNORED.has(prop)) continue;
    if (prop === "display" && value === "-webkit-box") continue;
    if (prop === "--tw-gradient-to" && value.startsWith("rgb(") && / \/ 0\)/.test(value)) continue; // implicit transparent end
    if (prop === "max-width" && value === "none") continue; // Tarve: no maxWidth at all
    if (prop === "inset") { for (const side of SIDES) out[side] = normalize(side, value); continue; } // Tarve has no shorthand
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
const CORNERS: Record<string, string> = { topLeft: "top-left", topRight: "top-right", bottomRight: "bottom-right", bottomLeft: "bottom-left" };

function insets(prop: string, value: Style["padding"], out: Decls, suffix = ""): void {
  if (typeof value === "number") { out[prop + suffix] = String(value); return; }
  if (!value) return;
  for (const side of SIDES) if (value[side] !== undefined) out[`${prop.replace(/^border$/, "border")}-${side}${suffix}`] = String(value[side]);
}

function paint(value: StateStyle["background"]): string | undefined {
  if (typeof value === "string") return value;
  if (value && value.type === "linear") {
    const stops = value.stops.map(stop => typeof stop === "string" ? stop : stop.color);
    return `linear-gradient(to ${value.to}, ${stops.join(", ")})`;
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
  if (typeof s.boxShadow === "string") out["--tw-shadow"] = s.boxShadow;
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
  if (out.base!["--tw-ring-shadow"]) delete out.base!["outline-style"];
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

describe("tw() matches Tailwind CSS 3.4 class by class", () => {
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
        // `ring-*` only: Tailwind sets the ring width through `--tw-ring-shadow`, Tarve an outline.
        if (gotDecls["outline-style"]) delete gotDecls["outline-style"];
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
          // Tarve names one generic family; it must be in Tailwind's stack.
          expect(want[prop]!.split(",").map(f => f.trim().replace(/"/g, ""))).toContain(got[prop]!);
        }
      }
    }
  });

  test("gradient composites: direction and stops", async () => {
    const compiled = await compileTailwind(COMPOSITES.flat());
    for (const classes of COMPOSITES) {
      const direction = compiled.get(classes[0]!)!.base!["background-image"]!;
      const to = /linear-gradient\(to ([a-z ]+),/.exec(direction)![1]!;
      const stops: string[] = [];
      let end: string | undefined;
      let implicitEnd = "transparent";
      for (const name of classes.slice(1)) {
        const decls = compiled.get(name)!.base!;
        if (name.startsWith("from-")) {
          stops.push(normalize("x", decls["--tw-gradient-from"]!));
          implicitEnd = normalize("x", decls["--tw-gradient-to"]!); // the start colour at alpha 0
        }
        if (name.startsWith("via-")) {
          // `--tw-gradient-stops: var(--tw-gradient-from), <via colour> var(--tw-gradient-via-position), var(--tw-gradient-to)`
          const middle = decls["--tw-gradient-stops"]!.split(",")[1]!;
          stops.push(normalize("x", middle));
        }
        if (name.startsWith("to-")) end = normalize("x", decls["--tw-gradient-to"]!);
      }
      stops.push(end ?? implicitEnd);
      const want = `linear-gradient(to ${to}, ${stops.join(", ")})`;
      expect(actual(classes.join(" ")).base!.gradient).toBe(normalize("gradient", want));
    }
  });
});
