import { extendTailwind, viewport } from "@tarve/core";
import { camelCase, parseDeclarations, styleDependencies, windowInstance, type TElement } from "./dom";
import { ancestorState, parseSelectorList, ruleState, selectorMatches, usesHas, type PseudoElement, type Selector } from "./selectors";

/**
 * Svelte's component CSS for Tarve. The compiler emits each rule's selector and
 * declarations (`parseCss`, at build time); the view matches them against the
 * Svelte DOM: compound selectors by class/tag index, combinators and structural
 * pseudo-classes against the element's ancestors and siblings, `@media` width
 * queries against the window, and `var()`/`vw`/`vh` when the element renders.
 */
export interface CssRule {
  selector: string;
  declarations: [string, string][];
  /** `@keyframes` (with `selector` empty): its frames by offset. */
  keyframes?: { name: string; frames: { offset: number; declarations: [string, string][] }[] };
  /** `@media` condition (width queries and `prefers-color-scheme`). */
  media?: string;
  /** Tailwind v4 `@theme` (with `selector` empty): its custom properties (`--color-lead: …`). */
  theme?: [string, string][];
  /** The sheet imports Tailwind (`@import "tailwindcss"`): every utility class applies, as in the browser. */
  tailwind?: true;
}

/**
 * Tailwind's build directives: Tarve compiles utility classes itself, so a style sheet
 * written for Tailwind v4 (`@import "tailwindcss"`, `@source`, `@plugin`…) keeps them as no-ops.
 */
const TAILWIND_DIRECTIVE = /^@(?:import\s+["']tailwindcss[^"']*["']|source|plugin|config|custom-variant|variant|reference|tailwind|charset)\b/;

const UNITLESS = new Set(["opacity", "flex", "flexGrow", "flexShrink", "fontWeight", "zIndex", "lineHeight", "order", "aspectRatio", "grow", "shrink", "lineClamp", "columns"]);
const ALIASES: Record<string, string> = { flexGrow: "grow", flexShrink: "shrink", flexBasis: "basis", borderRadius: "radius", gridTemplateColumns: "columns", gridTemplateRows: "rows", gridAutoRows: "autoRows", gridAutoColumns: "autoColumns", scrollbarThumbColor: "scrollbarColor" };
const BOXES = new Set(["padding", "margin", "borderWidth"]);
const CORNERS = ["topLeft", "topRight", "bottomRight", "bottomLeft"] as const;
const DYNAMIC = /var\(|\d[dsl]?(vw|vh|vmin|vmax)\b/;
const kebab = (name: string) => name.startsWith("--") ? name : name.replace(/[A-Z]/g, letter => "-" + letter.toLowerCase());

/** What a value is resolved against: the viewport for `vw`/`vh`, the font size for `em`. */
export interface CssContext { width: number; height: number; fontSize: number; /** The element's size: `transform` turns about its centre, as CSS does. */ box?: { width: number; height: number } }
const DEFAULT_CONTEXT: CssContext = { width: 1120, height: 820, fontSize: 16 };

/** CSS 1–4 value box shorthand as Tarve's per-side object. */
function box(value: unknown): unknown {
  if (!Array.isArray(value)) return value;
  const [top, right = top, bottom = top, left = right] = value;
  return { top, right, bottom, left };
}

/**
 * `calc()`, `min()`, `max()` and `clamp()` of lengths, in px (`clamp(2rem, 4vw, 3.5rem)`).
 * Percentages have no basis here: such a value is not resolved.
 */
function mathLength(text: string, property: string, context: CssContext): number | undefined {
  let index = 0;
  const source = text.trim();
  const space = () => { while (source[index] === " " || source[index] === "\t" || source[index] === "\n") index++; };
  const fail = () => { throw new SyntaxError(text); };
  const list = (): number[] => {
    const values = [sum()];
    space();
    while (source[index] === ",") { index++; values.push(sum()); space(); }
    if (source[index] !== ")") fail();
    index++;
    return values;
  };
  const atom = (): number => {
    space();
    const call = /^(calc|min|max|clamp)\(/i.exec(source.slice(index));
    if (call) {
      index += call[0].length;
      const values = list();
      switch (call[1]!.toLowerCase()) {
        case "calc": if (values.length !== 1) fail(); return values[0]!;
        case "min": return Math.min(...values);
        case "max": return Math.max(...values);
        default: if (values.length !== 3) fail(); return Math.max(values[0]!, Math.min(values[1]!, values[2]!));
      }
    }
    if (source[index] === "(") { index++; const value = sum(); space(); if (source[index] !== ")") fail(); index++; return value; }
    const token = /^-?\d*\.?\d+[a-z%]*/i.exec(source.slice(index));
    if (!token) fail();
    index += token![0].length;
    const unitless = /^-?\d*\.?\d+$/.test(token![0]);
    const value = unitless ? Number(token![0]) : length(token![0], property, context);
    if (value === undefined) fail();
    return value!;
  };
  const product = (): number => {
    let value = atom();
    for (;;) {
      space();
      const operator = source[index];
      if (operator !== "*" && operator !== "/") return value;
      index++;
      const next = atom();
      value = operator === "*" ? value * next : value / next;
    }
  };
  const sum = (): number => {
    let value = product();
    for (;;) {
      space();
      const operator = source[index];
      if (operator !== "+" && operator !== "-") return value;
      index++;
      value = operator === "+" ? value + product() : value - product();
    }
  };
  try {
    const value = atom();
    space();
    return index === source.length && Number.isFinite(value) ? value : undefined;
  } catch {
    return undefined;
  }
}

function length(part: string, property: string, context: CssContext): number | undefined {
  if (/^(calc|min|max|clamp)\(/i.test(part)) return mathLength(part, property, context);
  // `dvh`/`svh`/`lvh` (and `*vw`): a desktop window has no collapsing browser toolbars, so all are `vh`.
  const match = /^(-?\d*\.?\d+)(px|rem|em|[dsl]?vw|[dsl]?vh|[dsl]?vmin|[dsl]?vmax|pt)?$/.exec(part);
  if (!match) return undefined;
  const value = Number(match[1]);
  switch (match[2]?.replace(/^[dsl](?=v)/, "")) {
    case "px": return value;
    case "rem": return value * 16;
    case "em": return value * context.fontSize;
    case "vw": return value * context.width / 100;
    case "vh": return value * context.height / 100;
    case "vmin": return value * Math.min(context.width, context.height) / 100;
    case "vmax": return value * Math.max(context.width, context.height) / 100;
    case "pt": return value * 4 / 3;
    default: return value === 0 || UNITLESS.has(property) ? value : undefined;
  }
}

function cssValue(property: string, raw: string, context: CssContext): unknown {
  const value = raw.trim();
  // `line-height: 20px` is a length; Tarve's lineHeight is a multiple of the font size.
  if (property === "lineHeight") {
    const px = /^(\d*\.?\d+)px$/.exec(value);
    if (px) return Number(px[1]) / context.fontSize;
  }
  const parts = words(value);
  // Percentages stay CSS text per side (`padding: 5% 10%`): native resolves them against the box.
  const lengths = parts.map(part => length(part, property, context) ?? (/^-?\d*\.?\d+%$/.test(part) || (part === "auto" && property === "margin") ? part : undefined));
  if (lengths.every(item => item !== undefined)) return lengths.length === 1 ? lengths[0] : lengths;
  return value;
}

/**
 * `calc()`, `min()`, `max()`, `clamp()` and `env()` of lengths known now (px, rem, em,
 * viewport units) become px, innermost first; `env()` takes its fallback, else 0 (no notch,
 * no safe-area insets on a desktop window). Math with a percentage stays for the box to resolve.
 */
function resolveMath(value: string, context: CssContext): string {
  if (!/\b(calc|min|max|clamp|env)\(/.test(value)) return value;
  let out = value;
  for (let guard = 0; guard < 16; guard++) {
    let changed = false;
    out = out.replace(/\b(calc|min|max|clamp|env)\(([^()]*)\)/g, (whole, name: string, args: string) => {
      if (name === "env") { changed = true; const fallback = args.split(",").slice(1).join(",").trim(); return fallback || "0px"; }
      const parts = name === "calc" ? [args] : args.split(",");
      const numbers = parts.map(part => evaluate(part.trim(), context));
      if (numbers.some(number => number === undefined)) return whole;
      const values = numbers as number[];
      const result = name === "calc" ? values[0]! : name === "min" ? Math.min(...values) : name === "max" ? Math.max(...values)
        : Math.min(Math.max(values[1]!, values[0]!), values[2] ?? Infinity);
      changed = true;
      return `${Math.round(result * 1000) / 1000}px`;
    });
    if (!changed) break;
  }
  return out;
}

/** A `calc()` expression of lengths and numbers in px, or undefined (a percentage, a bad token). */
function evaluate(expression: string, context: CssContext): number | undefined {
  const tokens = expression.match(/-?\d*\.?\d+[a-z%]*|[-+*/]/gi);
  if (!tokens || tokens.join("").replace(/\s/g, "") !== expression.replace(/\s/g, "")) return undefined;
  const values: number[] = [], operators: string[] = [];
  for (const token of tokens) {
    if (/^[-+*/]$/.test(token) && values.length > operators.length) { operators.push(token); continue; }
    if (token.endsWith("%")) return undefined;
    const number = /^-?\d*\.?\d+$/.test(token) ? Number(token) : length(token, "x", context);
    if (number === undefined) return undefined;
    values.push(number);
  }
  if (values.length !== operators.length + 1) return undefined;
  // * and / first, then + and -.
  const sums: number[] = [values[0]!], signs: string[] = [];
  operators.forEach((operator, index) => {
    const next = values[index + 1]!;
    if (operator === "*") sums[sums.length - 1]! *= next;
    else if (operator === "/") sums[sums.length - 1]! /= next;
    else { signs.push(operator); sums.push(next); }
  });
  const total = sums.slice(1).reduce((sum, value, index) => signs[index] === "-" ? sum - value : sum + value, sums[0]!);
  return Number.isFinite(total) ? total : undefined;
}

type Matrix = [number, number, number, number, number, number];
const multiply = (m: Matrix, n: Matrix): Matrix => [
  m[0] * n[0] + m[2] * n[1], m[1] * n[0] + m[3] * n[1],
  m[0] * n[2] + m[2] * n[3], m[1] * n[2] + m[3] * n[3],
  m[0] * n[4] + m[2] * n[5] + m[4], m[1] * n[4] + m[3] * n[5] + m[5],
];

/**
 * A CSS `transform` list in the order Tarve's `transform` composes (translate, rotate, skew,
 * scale, about the box's centre), so it needs no box size: percents stay percents of the box.
 * Undefined for another order or `matrix()`, which take the matrix form.
 */
function transformObject(value: string, context: CssContext): Record<string, number> | undefined {
  if (value.trim() === "none") return {};
  const out = { x: 0, y: 0, xPercent: 0, yPercent: 0, rotate: 0, skewX: 0, skewY: 0, scaleX: 1, scaleY: 1 };
  const toDeg = (text: string) => {
    const match = /^(-?\d*\.?\d+)(deg|rad|turn|grad)?$/.exec(text.trim());
    if (!match) return undefined;
    const amount = Number(match[1]);
    return match[2] === "rad" ? amount * 180 / Math.PI : match[2] === "turn" ? amount * 360 : match[2] === "grad" ? amount * 0.9 : amount;
  };
  const shift = (text: string, axis: "x" | "y") => {
    const percent = /^(-?\d*\.?\d+)%$/.exec(text.trim());
    if (percent) { out[axis === "x" ? "xPercent" : "yPercent"] += Number(percent[1]); return true; }
    const px = length(text.trim(), "x", context);
    if (px === undefined) return false;
    out[axis] += px;
    return true;
  };
  let phase = 0;
  const functions = [...value.matchAll(/([a-zA-Z0-9]+)\(([^)]*)\)/g)];
  if (!functions.length || value.replace(/([a-zA-Z0-9]+)\(([^)]*)\)/g, "").trim()) return undefined;
  for (const [, name, args] of functions) {
    const parts = args!.split(/\s*,\s*|\s+/).filter(Boolean);
    const order = /^translate/.test(name!) ? 0 : /^rotate/.test(name!) ? 1 : /^skew/.test(name!) ? 2 : /^scale/.test(name!) ? 3 : -1;
    if (order < phase) return undefined;
    phase = order;
    switch (name) {
      case "translate": case "translate3d": if (!shift(parts[0] ?? "0", "x") || !shift(parts[1] ?? "0", "y")) return undefined; break;
      case "translateX": if (!shift(parts[0] ?? "0", "x")) return undefined; break;
      case "translateY": if (!shift(parts[0] ?? "0", "y")) return undefined; break;
      case "rotate": case "rotateZ": { const angle = toDeg(parts[0] ?? "0"); if (angle === undefined) return undefined; out.rotate += angle; break; }
      case "skew": { const x = toDeg(parts[0] ?? "0"), y = toDeg(parts[1] ?? "0"); if (x === undefined || y === undefined) return undefined; out.skewX += x; out.skewY += y; break; }
      case "skewX": { const x = toDeg(parts[0] ?? "0"); if (x === undefined) return undefined; out.skewX += x; break; }
      case "skewY": { const y = toDeg(parts[0] ?? "0"); if (y === undefined) return undefined; out.skewY += y; break; }
      case "scale": { const x = Number(parts[0] ?? 1), y = Number(parts[1] ?? parts[0] ?? 1); out.scaleX *= x; out.scaleY *= y; break; }
      case "scaleX": out.scaleX *= Number(parts[0] ?? 1); break;
      case "scaleY": out.scaleY *= Number(parts[0] ?? 1); break;
      default: return undefined;
    }
  }
  if (![out.scaleX, out.scaleY].every(Number.isFinite)) return undefined;
  const result: Record<string, number> = {};
  for (const key of ["x", "y", "xPercent", "yPercent", "rotate", "skewX", "skewY"] as const) if (out[key] !== 0) result[key] = out[key];
  if (out.scaleX === out.scaleY) { if (out.scaleX !== 1) result.scale = out.scaleX; }
  else { result.scaleX = out.scaleX; result.scaleY = out.scaleY; }
  return result;
}

/** A CSS `transform` list as one matrix about the box's centre (Tarve's origin is its top left). */
function transformMatrix(value: string, context: CssContext): Matrix | undefined {
  if (value.trim() === "none") return [1, 0, 0, 1, 0, 0];
  const { width = 0, height = 0 } = context.box ?? {};
  const toPx = (text: string, axis: number) => {
    const percent = /^(-?\d*\.?\d+)%$/.exec(text.trim());
    return percent ? Number(percent[1]) * axis / 100 : length(text.trim(), "x", context) ?? 0;
  };
  const toRad = (text: string) => {
    const match = /^(-?\d*\.?\d+)(deg|rad|turn)?$/.exec(text.trim());
    if (!match) return 0;
    const amount = Number(match[1]);
    return match[2] === "rad" ? amount : match[2] === "turn" ? amount * 2 * Math.PI : amount * Math.PI / 180;
  };
  let matrix: Matrix = [1, 0, 0, 1, width / 2, height / 2];
  for (const [, name, args] of value.matchAll(/([a-zA-Z0-9]+)\(([^)]*)\)/g)) {
    const parts = args!.split(/\s*,\s*|\s+/).filter(Boolean);
    let step: Matrix;
    switch (name) {
      case "translate": step = [1, 0, 0, 1, toPx(parts[0] ?? "0", width), toPx(parts[1] ?? "0", height)]; break;
      case "translateX": step = [1, 0, 0, 1, toPx(parts[0] ?? "0", width), 0]; break;
      case "translateY": step = [1, 0, 0, 1, 0, toPx(parts[0] ?? "0", height)]; break;
      case "translate3d": step = [1, 0, 0, 1, toPx(parts[0] ?? "0", width), toPx(parts[1] ?? "0", height)]; break;
      case "scale": { const x = Number(parts[0] ?? 1), y = Number(parts[1] ?? parts[0] ?? 1); step = [x, 0, 0, y, 0, 0]; break; }
      case "scaleX": step = [Number(parts[0] ?? 1), 0, 0, 1, 0, 0]; break;
      case "scaleY": step = [1, 0, 0, Number(parts[0] ?? 1), 0, 0]; break;
      case "rotate": case "rotateZ": { const angle = toRad(parts[0] ?? "0"); step = [Math.cos(angle), Math.sin(angle), -Math.sin(angle), Math.cos(angle), 0, 0]; break; }
      case "skewX": step = [1, 0, Math.tan(toRad(parts[0] ?? "0")), 1, 0, 0]; break;
      case "skewY": step = [1, Math.tan(toRad(parts[0] ?? "0")), 0, 1, 0, 0]; break;
      case "matrix": step = parts.slice(0, 6).map(Number) as Matrix; break;
      default: return undefined;
    }
    matrix = multiply(matrix, step);
  }
  return multiply(matrix, [1, 0, 0, 1, -width / 2, -height / 2]);
}

/** Substitutes `var(--name, fallback)` from `variables`. */
function substitute(value: string, variables: ReadonlyMap<string, string> | undefined): string {
  let out = value;
  for (let guard = 0; guard < 8 && out.includes("var("); guard++) {
    out = out.replace(/var\(\s*(--[\w-]+)\s*(?:,\s*((?:[^()]|\([^()]*\))*))?\)/g, (_, name: string, fallback: string | undefined) => variables?.get(name) ?? fallback?.trim() ?? "");
  }
  return out;
}

/** CSS property names as the Tarve style keys a transition animates. */
const TRANSITION_PROPERTIES: Record<string, string> = {
  "background-color": "background", background: "background", color: "foreground", "border-color": "borderColor",
  "border-radius": "radius", "box-shadow": "boxShadow", "text-shadow": "textShadow", "max-height": "maxHeight", "min-height": "minHeight",
  "max-width": "maxWidth", "min-width": "minWidth", fill: "foreground", stroke: "foreground",
};
const MOTION_PROPERTIES = new Set(["all", "width", "height", "top", "right", "bottom", "left", "opacity", "radius", "background", "foreground", "borderColor", "boxShadow", "textShadow", "transform"]);
const TRANSITION_EASINGS: Record<string, string> = { ease: "ease", linear: "linear", "ease-in": "easeIn", "ease-out": "easeOut", "ease-in-out": "easeInOut" };

function seconds(text: string): number | undefined {
  const match = /^(-?\d*\.?\d+)(ms|s)$/.exec(text);
  return match ? Number(match[1]) * (match[2] === "s" ? 1000 : 1) : undefined;
}

/** CSS `transition` (`opacity 0.2s ease, transform 300ms`) as Tarve's per-property transitions. */
export function cssTransition(value: string): Record<string, { duration: number; delay?: number; easing?: string }> | undefined {
  if (value.trim() === "none") return undefined;
  const out: Record<string, { duration: number; delay?: number; easing?: string }> = {};
  for (const layer of value.split(/,(?![^(]*\))/)) {
    let property = "all", easing: string | undefined;
    const times: number[] = [];
    for (const part of words(layer)) {
      const time = seconds(part);
      if (time !== undefined) times.push(time);
      else if (TRANSITION_EASINGS[part]) easing = TRANSITION_EASINGS[part];
      // cubic-bezier() and steps() have no Tarve counterpart: the closest named curve.
      else if (/^(cubic-bezier|steps)\(/.test(part)) easing = "ease";
      else property = part;
    }
    const [duration = 0, delay] = times;
    if (duration <= 0) continue;
    const key = property === "all" ? "all" : TRANSITION_PROPERTIES[property] ?? camelCase(property);
    // Properties Tarve does not animate (`filter`, `visibility`) just change.
    if (!MOTION_PROPERTIES.has(key)) continue;
    out[key] = { duration, ...(delay ? { delay } : {}), ...(easing ? { easing } : {}) };
  }
  return Object.keys(out).length ? out : undefined;
}

/** A value's space-separated parts, keeping functions whole (`1px solid rgba(0, 0, 0, 0.1)`). */
function words(value: string): string[] {
  const out: string[] = [];
  let depth = 0, current = "";
  for (const char of value.trim()) {
    if (char === "(") depth++;
    else if (char === ")") depth--;
    if (/\s/.test(char) && depth === 0) { if (current) out.push(current); current = ""; continue; }
    current += char;
  }
  if (current) out.push(current);
  return out;
}

/** CSS declarations as a Tarve style object. Custom properties (`--x`) are skipped; `var()` reads `variables`. */
/** One side's border colour; the other sides keep the colour the box had. */
function sideColor(style: Record<string, unknown>, side: string, value: string): void {
  if (!style.borderColors) {
    const previous = style.borderColor;
    style.borderColors = typeof previous === "string" ? { top: previous, right: previous, bottom: previous, left: previous } : {};
  }
  (style.borderColors as Record<string, string>)[side] = value;
  if (style.borderColor === undefined) style.borderColor = value;
}

export function cssStyle(declarations: Map<string, string> | Iterable<[string, string]> | string, context: CssContext = DEFAULT_CONTEXT, variables?: ReadonlyMap<string, string>): Record<string, unknown> {
  const entries = [...(typeof declarations === "string" ? parseDeclarations(declarations) : declarations)];
  // `em` lengths and a px `line-height` are of the element's own font size when the rule sets one.
  const ownSize = entries.findLast(([name]) => name === "font-size");
  if (ownSize && !/em$|%$/.test(ownSize[1].trim())) {
    const size = length(ownSize[1].trim(), "fontSize", context);
    if (typeof size === "number") context = { ...context, fontSize: size };
  }
  const style: Record<string, unknown> = {};
  for (const [name, rawValue] of entries) {
    if (name.startsWith("--")) continue;
    const raw = resolveMath(rawValue.includes("var(") ? substitute(rawValue, variables) : rawValue, context);
    if (!raw) continue;
    let property = camelCase(name);
    // `em` and a px `line-height` are of the element's own font size once the rule sets it.
    if (typeof style.fontSize === "number" && context.fontSize !== style.fontSize) context = { ...context, fontSize: style.fontSize };
    if (property === "border" || property === "outline" || /^border(Top|Right|Bottom|Left)$/.test(property)) {
      const side = /^border(Top|Right|Bottom|Left)$/.exec(property)?.[1]?.toLowerCase();
      const target = property === "outline" ? "outline" : "border";
      for (const part of words(raw)) {
        const width = length(part, "borderWidth", context);
        if (width !== undefined) {
          if (side) {
            const current = style.borderWidth;
            style.borderWidth = { ...(typeof current === "object" ? current : current === undefined ? {} : { top: current, right: current, bottom: current, left: current }), [side]: width };
          } else style[`${target}Width`] = width;
        } else if (part === "none" || part === "hidden") {
          if (!side) style[`${target}Width`] = 0;
        } else if (/^(solid|dashed|dotted|double)$/.test(part)) style[`${target}Style`] = part;
        else if (side) sideColor(style, side, part);
        else {
          style[`${target}Color`] = part;
          if (target === "border") delete style.borderColors;
        }
      }
      continue;
    }
    // `border-top-color` and a 2–4 value `border-color`: colours per side (`borderColors`).
    const sideColorProperty = /^border(Top|Right|Bottom|Left)Color$/.exec(property)?.[1]?.toLowerCase();
    if (sideColorProperty) { sideColor(style, sideColorProperty, raw.trim()); continue; }
    if (property === "borderColor") {
      const parts = words(raw);
      if (parts.length > 1) {
        const [top, right = top, bottom = top, left = right] = parts;
        delete style.borderColors;
        style.borderColor = top;
        for (const [side, part] of Object.entries({ top, right, bottom, left })) sideColor(style, side, part!);
      } else { style.borderColor = raw.trim(); delete style.borderColors; }
      continue;
    }
    if (property === "background" && !/url\(|gradient\(/.test(raw)) { style.background = raw.trim(); continue; }
    // `background: url(…) center / cover no-repeat, #000`: the image, its size and the colour.
    if (property === "background" && /url\(/.test(raw)) {
      const layers = raw.split(/,(?![^(]*\))/).map(layer => layer.trim());
      style.backgroundImage = layers.filter(layer => /url\(|gradient\(/.test(layer)).map(layer => /url\([^)]*\)|[\w-]*gradient\((?:[^()]|\([^()]*\))*\)/.exec(layer)?.[0]).filter(Boolean).join(", ");
      const size = /\/\s*(cover|contain|[\d.]+%?(?:\s+[\d.]+%?)?)/.exec(raw)?.[1];
      if (size) style.backgroundSize = size;
      const colour = words(layers.at(-1)!).find(part => /^(#|rgb|hsl)/.test(part) || /^[a-z]+$/.test(part) && !/^(center|top|bottom|left|right|no-repeat|repeat|cover|contain|fixed|scroll)$/.test(part));
      if (colour) style.backgroundColor = colour;
      continue;
    }
    // `place-items: center` (and -content, -self): the align-* value, then the justify-* one (the same when one).
    const place = /^place(Items|Content|Self)$/.exec(property)?.[1];
    if (place) {
      const parts = words(raw);
      const align = parts[0] === "first" || parts[0] === "last" || parts[0] === "safe" || parts[0] === "unsafe" ? parts.slice(0, 2).join(" ") : parts[0];
      const rest = parts.slice(align?.includes(" ") ? 2 : 1).join(" ");
      if (align) {
        style[`align${place}`] = align;
        style[`justify${place}`] = rest || align;
      }
      continue;
    }
    // `inset: 0` (1–4 values, as margin) is top/right/bottom/left.
    if (property === "inset") {
      const parts = words(raw);
      const [top, right = top, bottom = top, left = right] = parts;
      for (const [side, part] of Object.entries({ top, right, bottom, left })) {
        if (part === undefined || part === "auto") continue;
        const value = cssValue(side, part, context);
        if (value !== undefined) style[side] = value;
      }
      continue;
    }
    if (property === "transition") { const transition = cssTransition(raw); if (transition) style.transition = transition; continue; }
    // `top: calc(100% + 0.5rem)` (a dropdown under its trigger): the percentage places the box and
    // the length moves it by its margin on that side, which offsets an absolute box the same way.
    const offset = /^(top|right|bottom|left)$/.exec(property) && /^calc\(\s*(-?\d*\.?\d+%)\s*([+-])\s*([^()]+?)\s*\)$/.exec(raw.trim());
    if (offset) {
      const shift = length(offset[3]!, property, context);
      if (shift !== undefined) {
        style[property] = offset[1];
        const margin = typeof style.margin === "object" && style.margin ? style.margin as Record<string, unknown> : {};
        style.margin = { ...margin, [property]: offset[2] === "-" ? -shift : shift };
        continue;
      }
    }
    // `min(20rem, 60vh)` of lengths that resolve now is just the smaller (or larger) one.
    const extreme = /^(min|max|clamp)\((.*)\)$/.exec(raw.trim());
    if (extreme && !extreme[2]!.includes("%") && !extreme[2]!.includes("(")) {
      const values = extreme[2]!.split(",").map(part => length(part.trim(), property, context));
      if (values.length > 1 && values.every(value => typeof value === "number")) {
        const numbers = values as number[];
        style[ALIASES[property] ?? property] = extreme[1] === "min" ? Math.min(...numbers) : extreme[1] === "max" ? Math.max(...numbers)
          : Math.min(Math.max(numbers[1]!, numbers[0]!), numbers[2] ?? Infinity);
        continue;
      }
    }
    // `width: min(92%, 34rem)` is a percentage with a cap; `max(…)` one with a floor.
    const bounded = /^(width|height)$/.exec(property) && /^(min|max)\(\s*(-?\d*\.?\d+%)\s*,\s*([^,()]+)\)$/.exec(raw.trim());
    if (bounded) {
      const limit = length(bounded[3]!.trim(), property, context);
      if (limit !== undefined) {
        style[property] = bounded[2];
        style[(bounded[1] === "min" ? "max" : "min") + property[0]!.toUpperCase() + property.slice(1)] = limit;
        continue;
      }
    }
    // Tarve positions boxes relative or absolute only: `fixed` is absolute to its positioned
    // ancestor (the viewport while the page is not scrolled), `sticky` stays in the flow.
    if (property === "position") {
      const position = raw.trim();
      style.position = position === "fixed" ? "absolute" : position === "sticky" ? "relative" : position;
      continue;
    }
    // `scrollbar-color: <thumb> <track>`: Tarve paints the thumb over a clear track.
    if (property === "scrollbarColor") { const thumb = words(raw)[0]; if (thumb && thumb !== "auto") style.scrollbarColor = thumb; continue; }
    if (property === "transform") {
      const object = transformObject(raw, context);
      if (object) { style.transform = object; continue; }
      const matrix = transformMatrix(raw, context);
      if (matrix) style.transformMatrix = matrix;
      continue;
    }
    if (property === "font") {
      // font: [style] [weight] size[/line-height] family
      const match = /^(?:(italic|oblique|normal)\s+)?(?:(bold|bolder|lighter|normal|\d{3})\s+)?(\S+?)(?:\/(\S+))?\s+(.+)$/.exec(raw.trim());
      if (match) {
        if (match[1]) style.fontStyle = match[1];
        if (match[2]) style.fontWeight = match[2] === "bold" ? 700 : match[2] === "normal" ? 400 : Number(match[2]) || match[2];
        const size = length(match[3]!, "fontSize", context);
        if (size !== undefined) style.fontSize = size;
        if (match[4]) style.lineHeight = cssValue("lineHeight", match[4], { ...context, fontSize: size ?? context.fontSize });
        style.fontFamily = match[5]!.trim();
      }
      continue;
    }
    const edge = /^(padding|margin)(Top|Right|Bottom|Left)$/.exec(property);
    if (edge) {
      const key = edge[1]!;
      const current = style[key];
      const sides = typeof current === "object" && current ? { ...current } : current === undefined ? {} : { top: current, right: current, bottom: current, left: current };
      style[key] = { ...sides, [edge[2]!.toLowerCase()]: cssValue(property, raw, context) };
      continue;
    }
    if (property === "borderRadius" && raw.trim().includes(" ")) {
      const corners = cssValue(property, raw, context) as unknown[];
      const [a, b = a, c = a, d = b] = corners;
      style.radius = Object.fromEntries(CORNERS.map((corner, index) => [corner, [a, b, c, d][index]]));
      continue;
    }
    if (property === "flexDirection") { style.direction = raw.trim(); continue; }
    // The legacy line-clamp box: `display: -webkit-box; -webkit-line-clamp: 2` clamps lines.
    if (property === "WebkitLineClamp" || property === "lineClamp") { const lines = Number(raw); if (Number.isFinite(lines) && lines > 0) style.lineClamp = lines; continue; }
    if (property === "WebkitBoxOrient") continue;
    if (property === "display" && /^-webkit-(inline-)?box$/.test(raw.trim())) continue;
    // CSS `direction` is the text direction, not Tarve's flex `direction`.
    if (property === "direction") { style.textDirection = raw.trim(); continue; }
    if (property === "writingMode" || property === "WebkitAppearance") { style[property === "WebkitAppearance" ? "appearance" : property] = raw.trim(); continue; }
    // Track lists stay CSS text (`100px 100px`, `repeat(4, 1fr)`): a lone length is a track, not a count.
    if (/^grid(Template|Auto)(Columns|Rows)$/.test(property)) { style[ALIASES[property]!] = raw.trim(); continue; }
    // `aspect-ratio: 2 / 3` (or `16/9`, `1.5`); `auto` leaves the box to its content.
    if (property === "aspectRatio") {
      const ratio = /^(\d*\.?\d+)\s*(?:\/\s*(\d*\.?\d+))?$/.exec(raw.trim());
      if (ratio && Number(ratio[2] ?? 1) > 0) style.aspectRatio = Number(ratio[1]) / Number(ratio[2] ?? 1);
      continue;
    }
    if (property === "flexWrap") { style.wrap = raw.trim() !== "nowrap"; continue; }
    if (property === "flex" && /^\d*\.?\d+$/.test(raw.trim())) { style.flex = Number(raw); continue; }
    // The shorthand's other forms (`0 0 200px`, `1 1 auto`, `none`) pass as CSS text.
    if (property === "flex") { style.flex = raw.trim(); continue; }
    // Inline-level boxes (`inline-block`, `inline-flex`) are as wide as their content: `inline` marks
    // them for the renderer, which knows whether their parent lays them out as a line or as flex items.
    if (property === "display" && /^inline-(flex|grid)$/.test(raw.trim())) { style.display = raw.trim().slice(7); style.inline = true; continue; }
    if (property === "display" && raw.trim() === "inline") { style.display = undefined; style.inline = true; continue; }
    // `inline-block` is a box of its own on the line: `inline: "block"` keeps it out of text runs.
    if (property === "display" && raw.trim() === "inline-block") { style.display = undefined; style.inline = "block"; continue; }
    if (property === "display") style.inline = undefined;
    property = ALIASES[property] ?? property;
    const value = cssValue(property, raw, context);
    style[property] = BOXES.has(property) ? box(value) : value;
  }
  return style;
}

/** Top-level blocks of a style sheet: `[prelude, body]`. */
function blocks(text: string): [string, string][] {
  const out: [string, string][] = [];
  // Braces inside strings (`@source "./**/*.{svelte,ts}"`, `content: "{"`) are text.
  const next = (from: number): number => {
    let quote = "";
    for (let at = from; at < text.length; at++) {
      const char = text[at]!;
      if (quote) { if (char === "\\") at++; else if (char === quote) quote = ""; continue; }
      if (char === '"' || char === "'") quote = char;
      else if (char === "{" || char === "}") return at;
    }
    return -1;
  };
  let index = 0;
  while (index < text.length) {
    const open = next(index);
    if (open < 0 || text[open] !== "{") break;
    let depth = 1, close = open + 1;
    while (depth > 0) {
      const brace = next(close);
      if (brace < 0) { close = text.length + 1; break; }
      depth += text[brace] === "{" ? 1 : -1;
      close = brace + 1;
    }
    out.push([text.slice(index, open).trim(), text.slice(open + 1, close - 1)]);
    index = close;
  }
  return out;
}

/** Parses Svelte's emitted CSS into rules (at build time); `warn` hears about what Tarve cannot match. */
export function parseCss(code: string, warn?: (message: string) => void): CssRule[] {
  const rules: CssRule[] = [];
  const visit = (text: string, media?: string) => {
    for (let [prelude, body] of blocks(text)) {
      // Statement at-rules (`@import …;`) end before the block's own prelude.
      const statements = splitStatements(prelude);
      prelude = statements.pop()!;
      for (const statement of statements) {
        if (!TAILWIND_DIRECTIVE.test(statement) && !/^@import\b/.test(statement)) warn?.(`${statement} is not supported`);
      }
      if (prelude.startsWith("@layer")) { visit(body, media); continue; }
      if (prelude === "@theme" || prelude.startsWith("@theme ")) {
        rules.push({ selector: "", declarations: [], theme: [...parseDeclarations(body)] });
        continue;
      }
      if (prelude.startsWith("@media")) {
        const condition = prelude.slice(6).trim();
        if (parseMedia(condition)) visit(body, media ? `${media} and ${condition}` : condition);
        else warn?.(`@media ${condition} is not supported`);
        continue;
      }
      const keyframes = /^@(?:-webkit-)?keyframes\s+(\S+)/.exec(prelude);
      if (keyframes) {
        const frames: { offset: number; declarations: [string, string][] }[] = [];
        for (const [selectors, frame] of blocks(body)) {
          for (const at of selectors.split(",")) {
            const text = at.trim();
            const offset = text === "from" ? 0 : text === "to" ? 1 : parseFloat(text) / 100;
            if (Number.isFinite(offset)) frames.push({ offset, declarations: [...parseDeclarations(frame)] });
          }
        }
        rules.push({ selector: "", declarations: [], keyframes: { name: keyframes[1]!, frames: frames.sort((a, b) => a.offset - b.offset) } });
        continue;
      }
      if (prelude.startsWith("@")) {
        if (!/^@font-face/.test(prelude)) warn?.(`${prelude} is not supported`);
        continue;
      }
      const declarations = [...parseDeclarations(body)];
      for (const selector of splitSelectors(prelude)) {
        try {
          parseSelectorList(selector);
        } catch (error) {
          warn?.(`selector "${selector}": ${(error as Error).message}`);
          continue;
        }
        rules.push({ selector, declarations, ...(media ? { media } : {}) });
      }
    }
  };
  const text = code.replace(/\/\*[\s\S]*?\*\//g, "");
  if (/@import\s+(?:url\()?["']tailwindcss["'/]/.test(text)) rules.push({ selector: "", declarations: [], tailwind: true });
  visit(text);
  return rules;
}

/** `a; b; c`: the statements a prelude carries before its own (outside quotes and parentheses). */
function splitStatements(prelude: string): string[] {
  const out: string[] = [];
  let depth = 0, quote = "", start = 0;
  for (let index = 0; index < prelude.length; index++) {
    const char = prelude[index]!;
    if (quote) { if (char === quote) quote = ""; continue; }
    if (char === '"' || char === "'") quote = char;
    else if (char === "(") depth++;
    else if (char === ")") depth--;
    else if (char === ";" && depth === 0) { out.push(prelude.slice(start, index).trim()); start = index + 1; }
  }
  out.push(prelude.slice(start).trim());
  return out.filter((statement, index) => statement || index === out.length - 1);
}

/** `@import` targets of a style sheet that are files (not Tailwind's own `@import "tailwindcss"`). */
export function cssImports(code: string): string[] {
  const out: string[] = [];
  for (const [, url] of code.replace(/\/\*[\s\S]*?\*\//g, "").matchAll(/@import\s+(?:url\(\s*)?["']([^"']+)["']/g)) {
    if (!/^tailwindcss(\/|$)/.test(url!)) out.push(url!);
  }
  return out;
}

function splitSelectors(prelude: string): string[] {
  const out: string[] = [];
  let depth = 0, start = 0;
  for (let index = 0; index < prelude.length; index++) {
    const char = prelude[index];
    if (char === "(" || char === "[") depth++;
    else if (char === ")" || char === "]") depth--;
    else if (char === "," && depth === 0) { out.push(prelude.slice(start, index).trim()); start = index + 1; }
  }
  out.push(prelude.slice(start).trim());
  return out.filter(Boolean);
}

type MediaTest = { min?: number; max?: number; dark?: boolean; orientation?: "portrait" | "landscape"; minHeight?: number; maxHeight?: number; reducedMotion?: boolean; displayMode?: "fullscreen" | "standalone" | "minimal-ui" | "browser" };

/** Width/height/orientation/color-scheme media queries; undefined for anything else. */
function parseMedia(condition: string): MediaTest | undefined {
  const test: MediaTest = {};
  for (const part of condition.replace(/^(only\s+)?(screen|all)\s*(and\s*)?/i, "").split(/\s+and\s+/i)) {
    const feature = /^\(\s*([\w-]+)\s*:\s*([^)]+?)\s*\)$/.exec(part.trim());
    if (!feature) { if (part.trim()) return undefined; continue; }
    const [, name, value] = feature;
    const px = /^(\d*\.?\d+)(px|em|rem)?$/.exec(value!);
    const size = px ? Number(px[1]) * (px[2] === "em" || px[2] === "rem" ? 16 : 1) : undefined;
    if (name === "min-width" && size !== undefined) test.min = size;
    else if (name === "max-width" && size !== undefined) test.max = size;
    else if (name === "min-height" && size !== undefined) test.minHeight = size;
    else if (name === "max-height" && size !== undefined) test.maxHeight = size;
    else if (name === "prefers-color-scheme") test.dark = value === "dark";
    else if (name === "orientation" && (value === "portrait" || value === "landscape")) test.orientation = value;
    else if (name === "prefers-reduced-motion" && (value === "reduce" || value === "no-preference")) test.reducedMotion = value === "reduce";
    // A Tarve window is an installed app: `standalone`, or `fullscreen` while it fills the screen.
    else if (name === "display-mode" && /^(fullscreen|standalone|minimal-ui|browser)$/.test(value!)) test.displayMode = value as MediaTest["displayMode"];
    else return undefined;
  }
  return test;
}

function mediaMatches(test: MediaTest): boolean {
  const width = windowInstance.innerWidth, height = windowInstance.innerHeight;
  if (test.min !== undefined && width < test.min) return false;
  if (test.max !== undefined && width > test.max) return false;
  if (test.minHeight !== undefined && height < test.minHeight) return false;
  if (test.maxHeight !== undefined && height > test.maxHeight) return false;
  if (test.orientation && (test.orientation === "portrait") !== (height >= width)) return false;
  if (test.dark !== undefined && test.dark !== windowInstance._dark) return false;
  if (test.reducedMotion !== undefined && test.reducedMotion !== viewport().reducedMotion) return false;
  if (test.displayMode !== undefined && test.displayMode !== (windowInstance._fullscreen ? "fullscreen" : "standalone")) return false;
  return true;
}

interface Entry {
  selector: Selector;
  state?: string;
  order: number;
  specificity: number;
  declarations: [string, string][];
  /** Resolved once when no value depends on the element (`var()`, viewport units). */
  style?: Record<string, unknown>;
  variables?: [string, string][];
  media?: MediaTest;
  /** Matches by the element's own tag and classes alone: cacheable per tag + class list. */
  simple: boolean;
}

const byClass = new Map<string, Entry[]>();
const byTag = new Map<string, Entry[]>();
const byId = new Map<string, Entry[]>();
const universal: Entry[] = [];
/** `@keyframes` by name (Svelte scopes the names per component). */
const keyframeSets = new Map<string, { offset: number; declarations: [string, string][] }[]>();
/** `::before` / `::after` rules: they style generated content, not the element. */
const pseudoEntries: Entry[] = [];
/** Ancestors an `X:hover Y` rule watches: elements matching one are a native hover `group`. */
const groupAnchors: Selector[] = [];
/** Class names some component's CSS selects: they style through those rules, not as Tailwind utilities. */
const ruleClasses = new Set<string>();
let tailwindSheets = false;
let counter = 0;
let complex = 0;
let customProperties = false;
const simpleCache = new Map<string, Entry[]>();
/** Width/height thresholds of registered `@media` rules: crossing one restyles the app. */
const mediaThresholds = new Set<number>();
let viewportUnits = false;

/** The page imports Tailwind, whose preflight resets the browser's defaults (heading sizes, margins). */
export function usesPreflight(): boolean {
  return tailwindSheets;
}

/** Whether a class styles only through the component CSS. In a Tailwind app every class may be a utility too. */
export function isComponentClass(name: string): boolean {
  return !tailwindSheets && ruleClasses.has(name);
}

function bucket(map: Map<string, Entry[]>, key: string, entry: Entry): void {
  let list = map.get(key);
  if (!list) map.set(key, list = []);
  list.push(entry);
}

/** Registers a component's rules (the compiled module calls this once). */
export function registerCss(rules: readonly CssRule[]): void {
  for (const rule of rules) {
    if (rule.keyframes) { keyframeSets.set(rule.keyframes.name, rule.keyframes.frames); continue; }
    if (rule.theme) { for (const [name, value] of rule.theme) themeTokens.set(name, value); continue; }
    if (rule.tailwind) { tailwindSheets = true; continue; }
    if (rule.selector === ":root" || rule.selector === "html") {
      for (const [name, value] of rule.declarations) if (name.startsWith("--")) rootVariables.set(name, value);
    }
    for (const selector of parseSelectorList(rule.selector)) {
      const media = rule.media ? parseMedia(rule.media) : undefined;
      if (rule.media && !media) continue;
      const last = selector.compounds[selector.compounds.length - 1]!;
      if (usesHas(selector)) styleDependencies.ancestors = true;
      const dynamic = rule.declarations.some(([name, value]) => DYNAMIC.test(value) || name.startsWith("--"));
      const variables = rule.declarations.filter(([name]) => name.startsWith("--"));
      const simple = selector.compounds.length === 1 && !last.id && last.attributes.length === 0
        && last.pseudos.every(pseudo => pseudo.kind === "state") && !media && !dynamic;
      // `.card:hover .title`: the title's `groupHover` style, shown while the card (a native
      // `group`) is hovered. Other states of an ancestor (focus, active) have no native form.
      const ancestor = ancestorState(selector);
      if (ancestor && ancestor.state !== "hover") continue;
      if (ancestor) {
        const anchor = selector.compounds[ancestor.index]!;
        groupAnchors.push({ compounds: [{ ...anchor, pseudos: anchor.pseudos.filter(pseudo => pseudo.kind !== "state") }], combinators: [], specificity: 0 });
      }
      const state = ruleState(selector) ?? (ancestor ? "groupHover" : undefined);
      const entry: Entry = {
        selector, order: counter++, specificity: selector.specificity, declarations: rule.declarations,
        ...(state ? { state } : {}), ...(media ? { media } : {}), ...(variables.length ? { variables } : {}), simple,
        ...(dynamic ? {} : { style: cssStyle(rule.declarations) }),
      };
      for (const compound of selector.compounds) for (const name of compound.classes) ruleClasses.add(name);
      if (selector.pseudoElement === "before" || selector.pseudoElement === "after") { pseudoEntries.push(entry); entry.simple = false; complex++; continue; }
      if (selector.pseudoElement) {
        // `::placeholder` and the scrollbar parts style the element itself (its placeholder and
        // scrollbar colours, the bar's thickness): the rule becomes one on the element.
        const declarations = partDeclarations(selector.pseudoElement, rule.declarations);
        if (!declarations.length || state) continue;
        entry.declarations = declarations;
        entry.selector = { ...selector, pseudoElement: undefined };
        if (!dynamic) entry.style = cssStyle(declarations);
      }
      if (last.id) bucket(byId, last.id, entry);
      else if (last.classes[0]) bucket(byClass, last.classes[0], entry);
      else if (last.tag) bucket(byTag, last.tag, entry);
      else universal.push(entry);
      if (!simple) complex++;
      if (variables.length || rule.declarations.some(([, value]) => value.includes("var("))) customProperties = true;
      if (rule.declarations.some(([, value]) => /\d[dsl]?(vw|vh|vmin|vmax)\b/.test(value))) viewportUnits = true;
      if (media) for (const value of [media.min, media.max, media.minHeight, media.maxHeight]) if (value !== undefined) mediaThresholds.add(value);
      if (media?.dark !== undefined) colorScheme = true;
      if (media?.displayMode !== undefined) displayModeRules = true;
      // Restyle what a change can affect: descendants for ancestor selectors and
      // inherited custom properties, siblings for `+`, `~` and :nth-child().
      if (selector.combinators.some(combinator => combinator === " " || combinator === ">") || customProperties) styleDependencies.descendants = true;
      if (selector.combinators.some(combinator => combinator === "+" || combinator === "~")
        || selector.compounds.some(compound => compound.pseudos.some(pseudo => /child|of-type|empty/.test(pseudo.kind)))) styleDependencies.siblings = true;
    }
  }
  simpleCache.clear();
  applyTheme();
}
let colorScheme = false;
let displayModeRules = false;
/** Whether a `display-mode` rule exists (entering or leaving full screen restyles the app). */
export function usesDisplayMode(): boolean {
  return displayModeRules;
}

/** `@theme` tokens, and the `:root` custom properties their values may read. */
const themeTokens = new Map<string, string>();
const rootVariables = new Map<string, string>();

/** `--color-<name>` tokens become Tailwind colours (`bg-<name>`), as Tailwind v4 builds them. */
function applyTheme(): void {
  const colors: Record<string, string> = {};
  for (const [name, value] of themeTokens) {
    if (!name.startsWith("--color-")) continue;
    const resolved = substitute(value, rootVariables).trim();
    if (resolved && !resolved.includes("var(")) colors[name.slice("--color-".length)] = resolved;
  }
  if (Object.keys(colors).length) extendTailwind({ colors });
}

/**
 * A pseudo-element rule as declarations on its element: `::placeholder { color }` is the
 * placeholder colour, `::-webkit-scrollbar-thumb { background }` the scrollbar's, and
 * `::-webkit-scrollbar { width }` (or `height`) its thickness (`thin` up to 8 px, `none` at 0).
 * The track draws clear, as Tarve's always does.
 */
function partDeclarations(part: PseudoElement, declarations: [string, string][]): [string, string][] {
  const out: [string, string][] = [];
  for (const [name, value] of declarations) {
    if (part === "placeholder" && name === "color") out.push(["placeholder-color", value]);
    else if (part === "-webkit-scrollbar-thumb" && (name === "background" || name === "background-color")) out.push(["scrollbar-thumb-color", value]);
    // A range input's parts: the thumb, the track and (Firefox) the filled part.
    else if ((part === "-webkit-slider-thumb" || part === "-moz-range-thumb") && (name === "background" || name === "background-color")) out.push(["thumb-color", value]);
    else if ((part === "-webkit-slider-runnable-track" || part === "-moz-range-track") && (name === "background" || name === "background-color")) out.push(["track-color", value]);
    else if (part === "-moz-range-progress" && (name === "background" || name === "background-color")) out.push(["accent-color", value]);
    else if (part === "-webkit-scrollbar" && (name === "width" || name === "height")) {
      const px = /^(\d*\.?\d+)(px)?$/.exec(value.trim());
      if (px) out.push(["scrollbar-width", Number(px[1]) === 0 ? "none" : Number(px[1]) <= 8 ? "thin" : "auto"]);
      if (value.trim() === "0") out.push(["scrollbar-width", "none"]);
    } else if (part === "-webkit-scrollbar" && name === "display" && value.trim() === "none") out.push(["scrollbar-width", "none"]);
  }
  return out;
}

/** Forgets every registered rule (tests). */
export function resetCss(): void {
  byClass.clear(); byTag.clear(); byId.clear(); universal.length = 0; pseudoEntries.length = 0; groupAnchors.length = 0;
  ruleClasses.clear(); simpleCache.clear(); mediaThresholds.clear();
  counter = 0; complex = 0; tailwindSheets = false; customProperties = false; viewportUnits = false; colorScheme = false; displayModeRules = false;
  themeTokens.clear(); rootVariables.clear();
  styleDependencies.descendants = false; styleDependencies.siblings = false; styleDependencies.ancestors = false;
}

/** Whether a window resize from `before` to `after` changes any rule's outcome. */
export function resizeRestyles(before: { width: number; height: number }, after: { width: number; height: number }): boolean {
  if (viewportUnits && (before.width !== after.width || before.height !== after.height)) return true;
  for (const threshold of mediaThresholds) {
    const side = (value: number) => Math.sign(value - threshold);
    if (side(before.width) !== side(after.width) || side(before.height) !== side(after.height)) return true;
  }
  return false;
}

/** Whether a `prefers-color-scheme` rule exists (a theme change restyles the app). */
export function usesColorScheme(): boolean {
  return colorScheme;
}

function compare(a: Entry, b: Entry): number {
  return a.specificity - b.specificity || a.order - b.order;
}

function candidates(element: TElement, classes: readonly string[]): Entry[] {
  const out = new Set<Entry>(universal);
  for (const entry of byTag.get(element.localName) ?? []) out.add(entry);
  for (const name of classes) for (const entry of byClass.get(name) ?? []) out.add(entry);
  const id = element.getAttribute("id");
  if (id) for (const entry of byId.get(id) ?? []) out.add(entry);
  return [...out];
}

/** A stand-in element with only a tag and classes, for the cached simple matches. */
function asSelectorElement(tag: string, classes: readonly string[]) {
  const className = classes.join(" ");
  return {
    localName: tag, parentElement: null, previousElementSibling: null, nextElementSibling: null,
    getAttribute: (name: string) => name === "class" ? className : null,
    hasAttribute: (name: string) => name === "class", _isChecked: false, _isDisabled: false,
  };
}

/** The rules matching an element of `tag` with `classes` that need nothing else; cached. */
function simpleMatches(tag: string, classes: readonly string[], all: Entry[]): Entry[] {
  const key = tag + "\0" + classes.join(" ");
  let matched = simpleCache.get(key);
  if (!matched) {
    const stand = asSelectorElement(tag, classes);
    matched = all.filter(entry => entry.simple && selectorMatches(stand, entry.selector, "any")).sort(compare);
    if (simpleCache.size > 4096) simpleCache.clear();
    simpleCache.set(key, matched);
  }
  return matched;
}

function matching(element: TElement, classes: readonly string[]): Entry[] {
  const all = candidates(element, classes);
  const simple = simpleMatches(element.localName, classes, all);
  if (!complex) return simple;
  const rest = all.filter(entry => !entry.simple && (!entry.media || mediaMatches(entry.media)) && selectorMatches(element, entry.selector, "any"));
  return rest.length ? [...simple, ...rest].sort(compare) : simple;
}

/** Custom properties an element sees: inherited from its ancestors, then its own rules and inline style. */
function variablesOf(element: TElement | null): Map<string, string> | undefined {
  if (!element || !customProperties) return undefined;
  const cached = element._cssVariables;
  if (cached && cached.version === element._attrVersion) return cached.map;
  const inherited = variablesOf(element.parentElement);
  let map = inherited;
  const classes = (element.getAttribute("class") ?? "").split(/\s+/).filter(Boolean);
  const own = matching(element, classes).filter(entry => entry.variables && !entry.state);
  const inline = element._style ? [...element._style._values].filter(([name]) => name.startsWith("--")) : [];
  if (own.length || inline.length) {
    map = new Map(inherited);
    for (const entry of own) for (const [name, value] of entry.variables!) map.set(name, substitute(value, map));
    for (const [name, value] of inline) map.set(name, substitute(value, map));
  }
  element._cssVariables = { version: element._attrVersion, map };
  return map;
}

function fold(matched: Entry[], context: CssContext, variables: ReadonlyMap<string, string> | undefined): Record<string, unknown> | undefined {
  let style: Record<string, unknown> | undefined;
  for (const entry of matched) {
    const values = entry.style ?? cssStyle(entry.declarations, context, variables);
    style ??= {};
    if (entry.state) style[entry.state] = { ...(style[entry.state] as object | undefined), ...values };
    else Object.assign(style, values);
  }
  return style;
}

const foldCache = new WeakMap<Entry[], Record<string, unknown> | undefined>();
/**
 * Rules with `var()` fold per custom-property set: elements that see the same variables (one shared
 * map, inherited unchanged) share the result, at the viewport size it was folded for.
 */
const NO_VARIABLES = new Map<string, string>();
const dynamicFoldCache = new WeakMap<Entry[], WeakMap<ReadonlyMap<string, string>, { width: number; height: number; style: Record<string, unknown> | undefined }>>();
function foldDynamic(matched: Entry[], context: CssContext, variables: ReadonlyMap<string, string> | undefined): Record<string, unknown> | undefined {
  let byVariables = dynamicFoldCache.get(matched);
  if (!byVariables) dynamicFoldCache.set(matched, byVariables = new WeakMap());
  const key = variables ?? NO_VARIABLES;
  const cached = byVariables.get(key);
  if (cached && cached.width === context.width && cached.height === context.height) return cached.style;
  const style = fold(matched, context, variables);
  byVariables.set(key, { width: context.width, height: context.height, style });
  return style;
}

/** The style the registered rules give `element`, plus its inline `style` (which wins). */
export function elementStyle(element: TElement, classes: readonly string[]): Record<string, unknown> | undefined {
  const hasRules = byClass.size || byTag.size || byId.size || universal.length;
  const inlineValues = element._style?.length ? element._style._values : undefined;
  if (!hasRules && !inlineValues && !element._animations?.size) return undefined;
  const matched = hasRules ? matching(element, classes) : [];
  const context = { width: windowInstance.innerWidth, height: windowInstance.innerHeight, fontSize: 16 };
  const variables = customProperties ? variablesOf(element) : undefined;
  let style: Record<string, unknown> | undefined;
  if (matched.length && matched.every(entry => entry.style)) {
    // Static rules only: one folded object per matched set, shared by every element with it.
    if (!foldCache.has(matched)) foldCache.set(matched, fold(matched, context, variables));
    style = foldCache.get(matched);
  } else if (matched.length) style = foldDynamic(matched, context, variables);
  if (groupAnchors.length && groupAnchors.some(anchor => selectorMatches(element, anchor, "any"))) style = { ...style, group: true };
  if (inlineValues) style = { ...style, ...cssStyle(inlineValues, { ...context, ...(element._size ? { box: element._size } : {}) }, variables) };
  // CSS `display: grid` without `grid-template-columns` has one implicit column; Tarve's own default is two.
  if (style?.display === "grid" && style.columns === undefined) style = { ...style, columns: "none" };
  if (style && (style.animation !== undefined || style.animationName !== undefined)) style = applyCssAnimation(element, style);
  else if (element._cssAnimation) applyCssAnimation(element, {});
  // A running animation's frame (Svelte transitions, CSS animations) overrides both.
  const frame = element._animationStyle;
  if (frame) style = { ...style, ...cssStyle(Object.entries(frame).map(([name, value]) => [kebab(name), value] as [string, string]), { ...context, ...(element._size ? { box: element._size } : {}) }, variables) };
  return style;
}

/** The tag-and-class style of an element (rules that need nothing else). */
export function matchCss(tag: string, classes: readonly string[]): Record<string, unknown> | undefined {
  const all = new Set<Entry>(universal);
  for (const entry of byTag.get(tag) ?? []) all.add(entry);
  for (const name of classes) for (const entry of byClass.get(name) ?? []) all.add(entry);
  const matched = simpleMatches(tag, classes, [...all]);
  return matched.length ? fold(matched, DEFAULT_CONTEXT, undefined) : undefined;
}

export interface GeneratedContent { text: string; style: Record<string, unknown> }

/** The value of `content`: strings and `attr()` joined; undefined for none/normal. */
function contentText(value: string, element: TElement): string | undefined {
  const text = value.trim();
  if (text === "none" || text === "normal") return undefined;
  let out = "";
  for (const [, double, single, attribute] of text.matchAll(/"((?:[^"\\]|\\.)*)"|'((?:[^'\\]|\\.)*)'|attr\(\s*([\w-]+)\s*\)/g)) {
    if (attribute) out += element.getAttribute(attribute) ?? "";
    else out += (double ?? single ?? "").replace(/\\([0-9a-fA-F]{1,6})\s?/g, (_, hex: string) => String.fromCodePoint(parseInt(hex, 16))).replace(/\\(.)/g, "$1");
  }
  return out;
}

/** `::before` and `::after` content generated for `element`. */
export function generatedContent(element: TElement): { before?: GeneratedContent; after?: GeneratedContent } | undefined {
  if (!pseudoEntries.length) return undefined;
  const matched = pseudoEntries.filter(entry => (!entry.media || mediaMatches(entry.media)) && !entry.state && selectorMatches(element, entry.selector, "any")).sort(compare);
  if (!matched.length) return undefined;
  const context = { width: windowInstance.innerWidth, height: windowInstance.innerHeight, fontSize: 16 };
  const variables = customProperties ? variablesOf(element) : undefined;
  const out: { before?: GeneratedContent; after?: GeneratedContent } = {};
  for (const side of ["before", "after"] as const) {
    let content: string | undefined;
    let style: Record<string, unknown> = {};
    for (const entry of matched) {
      if (entry.selector.pseudoElement !== side) continue;
      for (const [name, value] of entry.declarations) if (name === "content") content = contentText(substitute(value, variables), element);
      style = { ...style, ...(entry.style ?? cssStyle(entry.declarations, context, variables)) };
    }
    delete style.content;
    if (content !== undefined) out[side] = { text: content, style };
  }
  return out.before || out.after ? out : undefined;
}

const TIME = /^(-?\d*\.?\d+)(ms|s)$/;
const DIRECTIONS = new Set(["normal", "reverse", "alternate", "alternate-reverse"]);
const FILLS = new Set(["none", "forwards", "backwards", "both"]);
const EASINGS = /^(linear|ease|ease-in|ease-out|ease-in-out|step-start|step-end|cubic-bezier\(.*\)|steps\(.*\))$/;

/** The `animation` shorthand (first animation of a list) as Web Animations timing. */
function parseAnimation(style: Record<string, unknown>): { name: string; duration: number; delay: number; iterations: number; direction: string; fill: string; easing: string } | undefined {
  const shorthand = typeof style.animation === "string" ? style.animation : "";
  const parts = shorthand ? (shorthand.split(/,(?![^(]*\))/)[0] ?? "").match(/[\w-]+\([^)]*\)|\S+/g) ?? [] : [];
  let name = typeof style.animationName === "string" ? style.animationName : "";
  const times: number[] = [];
  let iterations = 1, direction = "normal", fill = "none", easing = "ease";
  for (const part of parts) {
    const time = TIME.exec(part);
    if (time) times.push(Number(time[1]) * (time[2] === "s" ? 1000 : 1));
    else if (part === "infinite") iterations = Infinity;
    else if (/^\d*\.?\d+$/.test(part)) iterations = Number(part);
    else if (DIRECTIONS.has(part)) direction = part;
    else if (FILLS.has(part)) fill = part;
    else if (EASINGS.test(part)) easing = part;
    else if (part !== "running" && part !== "paused" && part !== "none") name = part;
  }
  const read = (key: string) => typeof style[key] === "string" ? style[key] as string : typeof style[key] === "number" ? String(style[key]) : undefined;
  const duration = read("animationDuration"), delay = read("animationDelay");
  const parseTime = (value: string | undefined) => { const time = value ? TIME.exec(value) : null; return time ? Number(time[1]) * (time[2] === "s" ? 1000 : 1) : undefined; };
  const iterationCount = read("animationIterationCount");
  if (iterationCount) iterations = iterationCount === "infinite" ? Infinity : Number(iterationCount);
  if (read("animationDirection")) direction = read("animationDirection")!;
  if (read("animationFillMode")) fill = read("animationFillMode")!;
  if (read("animationTimingFunction")) easing = read("animationTimingFunction")!;
  if (!name || name === "none") return undefined;
  return { name, duration: parseTime(duration) ?? times[0] ?? 0, delay: parseTime(delay) ?? times[1] ?? 0, iterations, direction, fill, easing };
}

/** The value `element`'s own rules and inline style declare for `property` (kebab-case), last one winning. */
function declaredValue(element: TElement, property: string): string | undefined {
  const inline = element._style?._values.get(property);
  if (inline !== undefined) return inline;
  const classes = (element.getAttribute("class") ?? "").split(/\s+/).filter(Boolean);
  let value: string | undefined;
  for (const entry of matching(element, classes)) {
    if (entry.state) continue;
    for (const [name, declared] of entry.declarations) if (name === property) value = declared;
  }
  return value === undefined || value.includes("var(") ? value === undefined ? undefined : substitute(value, variablesOf(element)) : value;
}

/** Starts (or keeps, or stops) the CSS animation `style` asks for; returns the style without animation keys. */
function applyCssAnimation(element: TElement, style: Record<string, unknown>): Record<string, unknown> {
  const spec = parseAnimation(style);
  const rest = { ...style };
  for (const key of Object.keys(rest)) if (key === "animation" || key.startsWith("animation")) delete rest[key];
  const key = spec ? JSON.stringify(spec) : undefined;
  if (element._cssAnimation?.key === key) return rest;
  (element._cssAnimation?.animation as { cancel(): void } | undefined)?.cancel();
  element._cssAnimation = undefined;
  const frames = spec ? keyframeSets.get(spec.name) : undefined;
  if (!spec || !frames?.length) return rest;
  const keyframes = frames.map(frame => {
    const out: Record<string, string | number> = { offset: frame.offset };
    for (const [name, value] of frame.declarations) out[camelCase(name)] = value;
    return out;
  });
  // A missing 0% or 100% keyframe is implicit and takes the element's own value (`.shimmer {
  // transform: translateX(-100%) }` with only `100% { transform: translateX(100%) }`).
  const offsets = keyframes.map(frame => frame.offset as number);
  for (const offset of [0, 1]) {
    if (offsets.includes(offset)) continue;
    const implicit: Record<string, string | number> = { offset };
    for (const frame of frames) for (const [name] of frame.declarations) {
      const own = declaredValue(element, name);
      if (own !== undefined) implicit[camelCase(name)] = own;
    }
    if (Object.keys(implicit).length > 1) keyframes.push(implicit);
  }
  keyframes.sort((x, y) => (x.offset as number) - (y.offset as number));
  // Started after this render: `animate` restyles the element, which must not re-enter the render.
  const animation = { cancel() { started?.cancel(); cancelled = true; } } as { cancel(): void };
  let started: { cancel(): void } | undefined, cancelled = false;
  queueMicrotask(() => { if (!cancelled) started = element.animate(keyframes, { duration: spec.duration, delay: spec.delay, iterations: spec.iterations, direction: spec.direction, fill: spec.fill, easing: spec.easing }); });
  element._cssAnimation = { key: key!, animation };
  return rest;
}
