import { camelCase, parseDeclarations, styleDependencies, windowInstance, type TElement } from "./dom";
import { parseSelectorList, ruleState, selectorMatches, usesHas, type Selector } from "./selectors";

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
}

const UNITLESS = new Set(["opacity", "flex", "flexGrow", "flexShrink", "fontWeight", "zIndex", "lineHeight", "order", "aspectRatio", "grow", "shrink", "lineClamp", "columns"]);
const ALIASES: Record<string, string> = { flexGrow: "grow", flexShrink: "shrink", flexBasis: "basis", borderRadius: "radius" };
const BOXES = new Set(["padding", "margin", "borderWidth"]);
const CORNERS = ["topLeft", "topRight", "bottomRight", "bottomLeft"] as const;
const DYNAMIC = /var\(|\d(vw|vh|vmin|vmax)\b/;
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

function length(part: string, property: string, context: CssContext): number | undefined {
  const match = /^(-?\d*\.?\d+)(px|rem|em|vw|vh|vmin|vmax|pt)?$/.exec(part);
  if (!match) return undefined;
  const value = Number(match[1]);
  switch (match[2]) {
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
  const parts = value.split(/\s+/);
  const lengths = parts.map(part => length(part, property, context));
  if (lengths.every(item => item !== undefined)) return lengths.length === 1 ? lengths[0] : lengths;
  return value;
}

type Matrix = [number, number, number, number, number, number];
const multiply = (m: Matrix, n: Matrix): Matrix => [
  m[0] * n[0] + m[2] * n[1], m[1] * n[0] + m[3] * n[1],
  m[0] * n[2] + m[2] * n[3], m[1] * n[2] + m[3] * n[3],
  m[0] * n[4] + m[2] * n[5] + m[4], m[1] * n[4] + m[3] * n[5] + m[5],
];

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

/** CSS declarations as a Tarve style object. Custom properties (`--x`) are skipped; `var()` reads `variables`. */
export function cssStyle(declarations: Map<string, string> | Iterable<[string, string]> | string, context: CssContext = DEFAULT_CONTEXT, variables?: ReadonlyMap<string, string>): Record<string, unknown> {
  const entries = typeof declarations === "string" ? parseDeclarations(declarations) : declarations;
  const style: Record<string, unknown> = {};
  for (const [name, rawValue] of entries) {
    if (name.startsWith("--")) continue;
    const raw = rawValue.includes("var(") ? substitute(rawValue, variables) : rawValue;
    if (!raw) continue;
    let property = camelCase(name);
    if (property === "border" || property === "outline" || /^border(Top|Right|Bottom|Left)$/.test(property)) {
      const side = /^border(Top|Right|Bottom|Left)$/.exec(property)?.[1]?.toLowerCase();
      const target = property === "outline" ? "outline" : "border";
      for (const part of raw.trim().split(/\s+/)) {
        const width = length(part, "borderWidth", context);
        if (width !== undefined) {
          if (side) {
            const current = style.borderWidth;
            style.borderWidth = { ...(typeof current === "object" ? current : current === undefined ? {} : { top: current, right: current, bottom: current, left: current }), [side]: width };
          } else style[`${target}Width`] = width;
        } else if (part === "none" || part === "hidden") {
          if (!side) style[`${target}Width`] = 0;
        } else if (/^(solid|dashed|dotted|double)$/.test(part)) style[`${target}Style`] = part;
        else style[`${target}Color`] = part;
      }
      continue;
    }
    if (property === "background" && !/url\(|gradient\(/.test(raw)) { style.background = raw.trim(); continue; }
    if (property === "transform") {
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
    if (property === "flexWrap") { style.wrap = raw.trim() !== "nowrap"; continue; }
    if (property === "flex" && /^\d*\.?\d+$/.test(raw.trim())) { style.flex = Number(raw); continue; }
    if (property === "display" && raw.trim() === "inline-flex") { style.display = "flex"; continue; }
    if (property === "display" && /^(inline|inline-block)$/.test(raw.trim())) continue;
    property = ALIASES[property] ?? property;
    const value = cssValue(property, raw, context);
    style[property] = BOXES.has(property) ? box(value) : value;
  }
  return style;
}

/** Top-level blocks of a style sheet: `[prelude, body]`. */
function blocks(text: string): [string, string][] {
  const out: [string, string][] = [];
  let index = 0;
  while (index < text.length) {
    const open = text.indexOf("{", index);
    if (open < 0) break;
    let depth = 1, close = open + 1;
    for (; close < text.length && depth > 0; close++) {
      if (text[close] === "{") depth++;
      else if (text[close] === "}") depth--;
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
    for (const [prelude, body] of blocks(text)) {
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
  visit(code.replace(/\/\*[\s\S]*?\*\//g, ""));
  return rules;
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

type MediaTest = { min?: number; max?: number; dark?: boolean; orientation?: "portrait" | "landscape"; minHeight?: number; maxHeight?: number };

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
/** Class names some component's CSS selects: they style through those rules, not as Tailwind utilities. */
const ruleClasses = new Set<string>();
let counter = 0;
let complex = 0;
let customProperties = false;
const simpleCache = new Map<string, Entry[]>();
/** Width/height thresholds of registered `@media` rules: crossing one restyles the app. */
const mediaThresholds = new Set<number>();
let viewportUnits = false;

export function isComponentClass(name: string): boolean {
  return ruleClasses.has(name);
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
    for (const selector of parseSelectorList(rule.selector)) {
      const media = rule.media ? parseMedia(rule.media) : undefined;
      if (rule.media && !media) continue;
      const last = selector.compounds[selector.compounds.length - 1]!;
      if (usesHas(selector)) styleDependencies.ancestors = true;
      const dynamic = rule.declarations.some(([name, value]) => DYNAMIC.test(value) || name.startsWith("--"));
      const variables = rule.declarations.filter(([name]) => name.startsWith("--"));
      const simple = selector.compounds.length === 1 && !last.id && last.attributes.length === 0
        && last.pseudos.every(pseudo => pseudo.kind === "state") && !media && !dynamic;
      const state = ruleState(selector);
      const entry: Entry = {
        selector, order: counter++, specificity: selector.specificity, declarations: rule.declarations,
        ...(state ? { state } : {}), ...(media ? { media } : {}), ...(variables.length ? { variables } : {}), simple,
        ...(dynamic ? {} : { style: cssStyle(rule.declarations) }),
      };
      for (const compound of selector.compounds) for (const name of compound.classes) ruleClasses.add(name);
      if (selector.pseudoElement) { pseudoEntries.push(entry); entry.simple = false; complex++; continue; }
      if (last.id) bucket(byId, last.id, entry);
      else if (last.classes[0]) bucket(byClass, last.classes[0], entry);
      else if (last.tag) bucket(byTag, last.tag, entry);
      else universal.push(entry);
      if (!simple) complex++;
      if (variables.length || rule.declarations.some(([, value]) => value.includes("var("))) customProperties = true;
      if (rule.declarations.some(([, value]) => /\d(vw|vh|vmin|vmax)\b/.test(value))) viewportUnits = true;
      if (media) for (const value of [media.min, media.max, media.minHeight, media.maxHeight]) if (value !== undefined) mediaThresholds.add(value);
      if (media?.dark !== undefined) colorScheme = true;
      // Restyle what a change can affect: descendants for ancestor selectors and
      // inherited custom properties, siblings for `+`, `~` and :nth-child().
      if (selector.combinators.some(combinator => combinator === " " || combinator === ">") || customProperties) styleDependencies.descendants = true;
      if (selector.combinators.some(combinator => combinator === "+" || combinator === "~")
        || selector.compounds.some(compound => compound.pseudos.some(pseudo => /child|of-type|empty/.test(pseudo.kind)))) styleDependencies.siblings = true;
    }
  }
  simpleCache.clear();
}
let colorScheme = false;

/** Forgets every registered rule (tests). */
export function resetCss(): void {
  byClass.clear(); byTag.clear(); byId.clear(); universal.length = 0; pseudoEntries.length = 0;
  ruleClasses.clear(); simpleCache.clear(); mediaThresholds.clear();
  counter = 0; complex = 0; customProperties = false; viewportUnits = false; colorScheme = false;
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
  } else if (matched.length) style = fold(matched, context, variables);
  if (inlineValues) style = { ...style, ...cssStyle(inlineValues, { ...context, ...(element._size ? { box: element._size } : {}) }, variables) };
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
  // Started after this render: `animate` restyles the element, which must not re-enter the render.
  const animation = { cancel() { started?.cancel(); cancelled = true; } } as { cancel(): void };
  let started: { cancel(): void } | undefined, cancelled = false;
  queueMicrotask(() => { if (!cancelled) started = element.animate(keyframes, { duration: spec.duration, delay: spec.delay, iterations: spec.iterations, direction: spec.direction, fill: spec.fill, easing: spec.easing }); });
  element._cssAnimation = { key: key!, animation };
  return rest;
}
