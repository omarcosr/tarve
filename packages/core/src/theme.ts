import type { BoxShadow, Gradient, StateStyle, Style, StyleAnimation, SyntaxTheme } from "./protocol";
import { cssColor, GRADIENT, normalizeGradient, parseBoxShadow, parseGradient, parseTextShadow, parseTransform } from "./css-shadow";

export interface ThemeColors {
  background: string;
  card: string;
  foreground: string;
  muted: string;
  mutedForeground: string;
  border: string;
  input: string;
  primary: string;
  primaryForeground: string;
  primaryHover: string;
  primaryActive: string;
  secondary: string;
  secondaryForeground: string;
  secondaryHover: string;
  secondaryActive: string;
  destructive: string;
  destructiveForeground: string;
  destructiveHover: string;
  destructiveActive: string;
  /** Destructive colour for text and icons on the background: errors, alerts. */
  destructiveText: string;
  ring: string;
  ringSoft: string;
  success: string;
  successMuted: string;
  /** Diff washes. A wash is a background tint, not an action colour: a
   * saturated `destructive` red behind a line of code is unreadable, so the
   * diff carries its own low-chroma tokens. */
  diffAddBackground: string;
  diffAddEmphasisBackground: string;
  diffAddForeground: string;
  diffAddAccent: string;
  diffRemoveBackground: string;
  diffRemoveEmphasisBackground: string;
  diffRemoveForeground: string;
  diffRemoveAccent: string;
  disabled: string;
  disabledForeground: string;
  placeholder: string;
  selection: string;
  scrollbar: string;
  overlay: string;
  imagePlaceholder: string;
  sliderThumb: string;
  windowCloseHover: string;
  windowCloseActive: string;
}

export interface ThemeDefinition {
  colors: ThemeColors;
  syntax: SyntaxTheme;
  focusOutline?: ThemeFocusOutline;
}

export interface ThemeOverrides {
  colors?: Partial<ThemeColors>;
  syntax?: Partial<SyntaxTheme>;
  focusOutline?: Partial<ThemeFocusOutline>;
}

export type ThemeFocusOutline = Pick<StateStyle,
  "outlineWidth" | "outlineColor" | "outlineOffset" | "outlineRadius" | "outlineStyle"
>;

const defaultFocusOutline: ThemeFocusOutline = {
  outlineWidth: 2,
  outlineOffset: 2,
  outlineStyle: "solid",
};

export const lightTheme: ThemeDefinition = {
  focusOutline: { ...defaultFocusOutline },
  syntax: {
    comment: "#6e7781", keyword: "#cf222e", string: "#0a3069", stringSpecial: "#0550ae", escape: "#953800",
    number: "#0550ae", boolean: "#0550ae", typeName: "#8250df", typeBuiltin: "#8250df", constructor: "#8250df",
    function: "#8250df", functionBuiltin: "#6639ba", macro: "#8250df", property: "#953800", constant: "#0550ae",
    variable: "#24292f", variableSpecial: "#953800", parameter: "#24292f", operator: "#cf222e", punctuation: "#57606a",
    tag: "#116329", attribute: "#0550ae", label: "#953800", embedded: "#24292f", invalid: "#cf222e",
  },
  colors: {
    background: "#fafafa",
    card: "#ffffff",
    foreground: "#18181b",
    muted: "#f4f4f5",
    mutedForeground: "#71717a",
    border: "#e4e4e7",
    input: "#ffffff",
    primary: "#18181b",
    primaryForeground: "#fafafa",
    primaryHover: "#303036",
    primaryActive: "#3f3f46",
    secondary: "#f4f4f5",
    secondaryForeground: "#18181b",
    secondaryHover: "#e4e4e7",
    secondaryActive: "#d4d4d8",
    destructive: "#dc2626",
    destructiveForeground: "#ffffff",
    destructiveHover: "#b91c1c",
    destructiveActive: "#991b1b",
    destructiveText: "#dc2626",
    ring: "#a1a1aa",
    ringSoft: "#aeaeb6",
    success: "#15803d",
    successMuted: "#f0fdf4",
    diffAddBackground: "#dcfce7",
    diffAddEmphasisBackground: "#bbf7d0",
    diffAddForeground: "#14532d",
    diffAddAccent: "#15803d",
    diffRemoveBackground: "#fee2e2",
    diffRemoveEmphasisBackground: "#fecaca",
    diffRemoveForeground: "#7f1d1d",
    diffRemoveAccent: "#dc2626",
    disabled: "#e4e4e7",
    disabledForeground: "#a1a1aa",
    placeholder: "#a1a1aa",
    selection: "#dbeafe",
    scrollbar: "#d4d4d8",
    overlay: "#00000066",
    imagePlaceholder: "#f4f4f5",
    sliderThumb: "#ffffff",
    windowCloseHover: "#e81123",
    windowCloseActive: "#c50f1f",
  },
};

export const darkTheme: ThemeDefinition = {
  focusOutline: { ...defaultFocusOutline },
  syntax: {
    comment: "#8b949e", keyword: "#ff7b72", string: "#a5d6ff", stringSpecial: "#79c0ff", escape: "#ffa657",
    number: "#79c0ff", boolean: "#79c0ff", typeName: "#d2a8ff", typeBuiltin: "#d2a8ff", constructor: "#d2a8ff",
    function: "#d2a8ff", functionBuiltin: "#bc8cff", macro: "#d2a8ff", property: "#ffa657", constant: "#79c0ff",
    variable: "#c9d1d9", variableSpecial: "#ffa657", parameter: "#c9d1d9", operator: "#ff7b72", punctuation: "#8b949e",
    tag: "#7ee787", attribute: "#79c0ff", label: "#ffa657", embedded: "#c9d1d9", invalid: "#f85149",
  },
  colors: {
    background: "#09090b",
    card: "#09090b",
    foreground: "#fafafa",
    muted: "#27272a",
    mutedForeground: "#a1a1aa",
    border: "#27272a",
    input: "#18181b",
    primary: "#fafafa",
    primaryForeground: "#18181b",
    primaryHover: "#e4e4e7",
    primaryActive: "#d4d4d8",
    secondary: "#27272a",
    secondaryForeground: "#fafafa",
    secondaryHover: "#3f3f46",
    secondaryActive: "#52525b",
    destructive: "#7f1d1d",
    destructiveForeground: "#fafafa",
    destructiveHover: "#991b1b",
    destructiveActive: "#b91c1c",
    destructiveText: "#f87171",
    ring: "#d4d4d8",
    ringSoft: "#b1b1b5",
    success: "#4ade80",
    successMuted: "#052e16",
    diffAddBackground: "#052e16",
    diffAddEmphasisBackground: "#14532d",
    diffAddForeground: "#a7f3d0",
    diffAddAccent: "#4ade80",
    diffRemoveBackground: "#450a0a",
    diffRemoveEmphasisBackground: "#7f1d1d",
    diffRemoveForeground: "#fecaca",
    diffRemoveAccent: "#f87171",
    disabled: "#27272a",
    disabledForeground: "#71717a",
    placeholder: "#71717a",
    selection: "#1e3a5f",
    scrollbar: "#52525b",
    overlay: "#00000099",
    imagePlaceholder: "#18181b",
    sliderThumb: "#fafafa",
    windowCloseHover: "#e81123",
    windowCloseActive: "#c50f1f",
  },
};

export function createTheme(overrides: ThemeOverrides = {}, base: ThemeDefinition = lightTheme): ThemeDefinition {
  return {
    colors: { ...base.colors, ...overrides.colors },
    syntax: { ...base.syntax, ...overrides.syntax },
    focusOutline: { ...defaultFocusOutline, ...base.focusOutline, ...overrides.focusOutline },
  };
}

/** Theme composition with base-first argument order, useful for conditional light/dark themes. */
export const Theme = {
  create(base: ThemeDefinition = lightTheme, overrides: ThemeOverrides = {}): ThemeDefinition {
    return createTheme(overrides, base);
  },
} as const;

const names = Object.keys(lightTheme.colors) as (keyof ThemeColors)[];
const cssName = (name: string) => name.replace(/[A-Z]/g, value => `-${value.toLowerCase()}`);
const refs = Object.fromEntries(names.map(name => [name, `var(--${cssName(name)})`])) as Record<keyof ThemeColors, string>;
const keyByRef = new Map(names.map(name => [refs[name], name] as const));

/** Semantic tokens used by components and application styles. */
export const theme = {
  colors: refs,
  space: { xs: 4, sm: 8, md: 12, lg: 16, xl: 24, xxl: 32 },
  radius: { sm: 6, md: 8, lg: 12 },
  font: { family: "system-ui", size: 14, lineHeight: 1.5 },
} as const;

/** A theme token with an opacity, as Tailwind's `bg-primary/50`: `var(--primary)/50`. */
const TOKEN_ALPHA = /^(var\(--[\w-]+\))\/(\d{1,3})$/;

export function resolveThemeColor(value: string, selected: ThemeDefinition): string {
  const key = keyByRef.get(value);
  if (key) return selected.colors[key];
  const alpha = TOKEN_ALPHA.exec(value);
  if (!alpha) return value;
  const base = keyByRef.get(alpha[1]!);
  if (!base) return value;
  const color = cssColor(selected.colors[base]);
  const percent = Math.max(0, Math.min(100, Number(alpha[2])));
  const channel = Math.round((percent / 100) * 255).toString(16).padStart(2, "0");
  return /^#[0-9a-f]{6}$/i.test(color) ? `${color}${channel}` : /^#[0-9a-f]{8}$/i.test(color) ? `${color.slice(0, 7)}${channel}` : color;
}

/** Normalizes CSS shadow strings and CSS colours (rgba(), hsl(), names) and resolves theme tokens. */
/** Style keys that take a colour or a gradient. */
const PAINT_KEYS = ["background", "foreground", "borderColor"] as const;

function resolveShadowColors(style: StateStyle, selected: ThemeDefinition): void {
  // Nothing to resolve in the common case: no transform, shadow or object/gradient paint.
  if (style.transform === undefined && style.textShadow === undefined && style.boxShadow === undefined
    && plainPaint(style.background) && plainPaint(style.foreground) && plainPaint(style.borderColor)) return;
  if (typeof style.transform === "string") style.transform = parseTransform(style.transform);
  const colour = (value: string) => resolveThemeColor(cssColor(value), selected);
  if (typeof style.textShadow === "string") {
    const parsed = parseTextShadow(style.textShadow);
    if (parsed) style.textShadow = parsed;
    else delete style.textShadow;
  }
  if (style.textShadow && typeof style.textShadow === "object") {
    style.textShadow = { ...style.textShadow, color: colour(style.textShadow.color) };
  }
  for (const key of PAINT_KEYS) {
    const value = style[key];
    const gradient = typeof value === "string" && GRADIENT.test(value) ? parseGradient(value) : value;
    if (gradient && typeof gradient === "object") style[key] = normalizeGradient(gradient, colour);
  }
  const box = typeof style.boxShadow === "string" ? parseBoxShadow(style.boxShadow) : style.boxShadow;
  if (box !== undefined) {
    style.boxShadow = Array.isArray(box)
      ? box.map(shadow => ({ ...shadow, color: colour(shadow.color) }))
      : { ...(box as BoxShadow), color: colour((box as BoxShadow).color) };
  }
}

/** Style keys whose string value is a colour (background, borderColor, diffAddedBackground, …). */
/** A paint resolveShadowColors leaves as is: unset, or a colour string (not a gradient). */
function plainPaint(value: unknown): boolean {
  return value === undefined || (typeof value === "string" && (value.indexOf("gradient(") === -1 || !GRADIENT.test(value)));
}

const COLOR_KEY = /^(background|foreground|color)$|(Color|Background|Foreground|Accent|Rule)$/;

/** Theme token or CSS colour (hex, rgb(), hsl(), names) for colour keys; other strings unchanged. */
/** Resolved style strings per theme: every node repeats the same few colors. */
/** By key, then value: two lookups instead of building a joined key string per call. */
const resolvedStrings = new WeakMap<ThemeDefinition, Map<string, Map<string, string>>>();
let resolvedStringCount = 0;

export function resolveStyleString(key: string, value: string, selected: ThemeDefinition): string {
  let cache = resolvedStrings.get(selected);
  if (!cache) resolvedStrings.set(selected, cache = new Map());
  let values = cache.get(key);
  if (!values) cache.set(key, values = new Map());
  let resolved = values.get(value);
  if (resolved === undefined) {
    if (++resolvedStringCount > 4096) {
      cache.clear();
      resolvedStringCount = 1;
      cache.set(key, values = new Map());
    }
    resolved = (PAINT_KEYS as readonly string[]).includes(key) && GRADIENT.test(value)
      ? value
      : resolveThemeColor(COLOR_KEY.test(key) ? cssColor(value) : value, selected);
    values.set(value, resolved);
  }
  return resolved;
}

const STATE_KEYS = ["hover", "focus", "focusVisible", "active", "disabled"] as const;

const resolvedStyles = new WeakMap<ThemeDefinition, Map<string, Style>>();
let resolvedStyleCount = 0;

/**
 * Theme-resolved copy of a style. Equal styles (most nodes of a list share a handful)
 * resolve once per theme: the result is cached by the style's JSON, which QuickJS
 * serializes in C far faster than the resolution runs in JS. Nested objects (state
 * styles, shadows, gradients) are the cache's own copies, shared and frozen; the top
 * level is a fresh copy callers may extend.
 */
export function resolveThemeStyle(style: Style, selected: ThemeDefinition): Style {
  let key: string;
  try {
    key = JSON.stringify(style);
  } catch {
    return resolveThemeStyleUncached(style, selected);
  }
  // JSON writes NaN and ±Infinity as null: such a style could share a key with another.
  if (key.includes("null")) return resolveThemeStyleUncached(style, selected);
  let cache = resolvedStyles.get(selected);
  if (!cache) resolvedStyles.set(selected, cache = new Map());
  let resolved = cache.get(key);
  if (resolved === undefined) {
    if (++resolvedStyleCount > 4096) {
      cache.clear();
      resolvedStyleCount = 1;
    }
    // Resolve a private deep copy: the caller's nested objects (a shared padding) must stay its own.
    resolved = resolveThemeStyleUncached(JSON.parse(key) as Style, selected);
    for (const name in resolved) {
      const value = (resolved as Record<string, unknown>)[name];
      if (value !== null && typeof value === "object") Object.freeze(value);
    }
    cache.set(key, resolved);
  }
  return { ...resolved };
}

/** Top-level comma split, ignoring commas inside parentheses (`rgb(1, 2, 3)`). */
function splitLayers(value: string): string[] {
  const parts: string[] = [];
  let depth = 0, start = 0;
  for (let i = 0; i < value.length; i++) {
    const c = value[i];
    if (c === "(") depth++;
    else if (c === ")") depth--;
    else if (c === "," && depth === 0) { parts.push(value.slice(start, i).trim()); start = i + 1; }
  }
  parts.push(value.slice(start).trim());
  return parts.filter(Boolean);
}

const CSS_PX = /^(-?\d*\.?\d+)(px)?$/;
function cssPx(value: string, what: string): number {
  const match = CSS_PX.exec(value.trim());
  if (!match || (match[2] === undefined && Number(match[1]) !== 0)) throw new TypeError(`${what} needs a px length, got "${value}"`);
  return Number(match[1]);
}

/** `blur(12px) saturate(160%)` → { blur: 12, saturate: 1.6 }. */
function cssFilterFunctions(value: string, allowed: readonly string[], what: string): Record<string, number> {
  const out: Record<string, number> = {};
  const input = value.trim();
  if (input === "none") return out;
  let consumed = "";
  for (const match of input.matchAll(/([a-z-]+)\(([^)]*)\)/g)) {
    consumed += match[0];
    const name = match[1]!;
    if (!allowed.includes(name)) throw new TypeError(`${what} supports ${allowed.map(n => `${n}()`).join(" and ")} only, got ${name}()`);
    const arg = match[2]!.trim();
    out[name] = name === "blur" ? cssPx(arg, `${what} blur()`) : arg.endsWith("%") ? Number(arg.slice(0, -1)) / 100 : Number(arg);
    if (!Number.isFinite(out[name])) throw new TypeError(`Invalid ${what}: ${value}`);
  }
  if (consumed.replace(/\s+/g, "") !== input.replace(/\s+/g, "")) throw new TypeError(`Invalid ${what}: ${value}`);
  return out;
}

/** Top-level `name(args)` calls of a CSS function list, parentheses nested in args kept. */
function cssCalls(value: string, what: string): [string, string][] {
  const calls: [string, string][] = [];
  let i = 0;
  const input = value.trim();
  while (i < input.length) {
    while (input[i] === " ") i++;
    if (i >= input.length) break;
    const open = input.indexOf("(", i);
    const name = open < 0 ? "" : input.slice(i, open).trim();
    if (!/^[a-z-]+$/.test(name)) throw new TypeError(`Invalid ${what}: ${value}`);
    let depth = 0, end = open;
    for (; end < input.length; end++) {
      if (input[end] === "(") depth++;
      else if (input[end] === ")" && --depth === 0) break;
    }
    if (depth !== 0) throw new TypeError(`Invalid ${what}: ${value}`);
    calls.push([name, input.slice(open + 1, end).trim()]);
    i = end + 1;
  }
  return calls;
}

/** CSS `filter`: `blur(r)` and `drop-shadow(x y [blur] [colour])`, e.g. `"drop-shadow(0 2px 6px #0008)"`. */
function parseCssFilter(value: string): { blur?: number; dropShadow?: { x: number; y: number; blur: number; color: string } } {
  if (value.trim() === "none") return {};
  const out: { blur?: number; dropShadow?: { x: number; y: number; blur: number; color: string } } = {};
  for (const [name, args] of cssCalls(value, "filter")) {
    if (name === "blur") out.blur = cssPx(args, "filter blur()");
    else if (name === "drop-shadow") {
      const tokens = splitLayers(args.replace(/\s+(?![^(]*\))/g, ","));
      const lengths: number[] = [];
      let color = "#000000";
      for (const token of tokens) {
        if (CSS_PX.test(token)) lengths.push(cssPx(token, "drop-shadow()"));
        else color = token;
      }
      if (lengths.length < 2) throw new TypeError(`drop-shadow() needs an x and a y offset, got "${args}"`);
      out.dropShadow = { x: lengths[0]!, y: lengths[1]!, blur: lengths[2] ?? 0, color };
    } else throw new TypeError(`filter supports blur() and drop-shadow() only, got ${name}()`);
  }
  return out;
}

/**
 * CSS conveniences with a native form: `backdropBlur`/`backdropFilter` become a plain
 * glass blur (no lens, no rim), `filter: "blur(…)"` an object, and several backgrounds
 * (`backgroundLayers`, or a comma list of gradients in `background`) a bottom
 * `background` under resolved `backgroundLayers` (first on top, as in CSS).
 */
function resolveCssLayers(style: StateStyle, selected: ThemeDefinition): void {
  if (style.backdropBlur !== undefined || style.backdropFilter !== undefined) {
    const backdrop = typeof style.backdropFilter === "string" ? cssFilterFunctions(style.backdropFilter, ["blur", "saturate"], "backdropFilter") : {};
    const blur = style.backdropBlur ?? backdrop.blur;
    if (blur !== undefined || backdrop.saturate !== undefined) {
      style.glass = { blur: blur ?? 0, ...(backdrop.saturate !== undefined ? { saturate: backdrop.saturate } : {}), ...style.glass };
    }
    delete style.backdropBlur;
    delete style.backdropFilter;
  }
  if (typeof style.filter === "string") {
    const filter = parseCssFilter(style.filter);
    if (filter.blur || filter.dropShadow) style.filter = filter;
    else delete style.filter;
  }
  if (style.filter && typeof style.filter === "object" && typeof style.filter.dropShadow?.color === "string") {
    style.filter = { ...style.filter, dropShadow: { ...style.filter.dropShadow, color: resolveThemeColor(cssColor(style.filter.dropShadow.color), selected) } };
  }
  if (style.maskImage !== undefined) {
    const value = style.maskImage;
    const gradient = typeof value === "string" && GRADIENT.test(value) ? parseGradient(value) : value;
    if (gradient && typeof gradient === "object") style.maskImage = normalizeGradient(gradient, value => resolveThemeColor(cssColor(value), selected));
    else delete style.maskImage;
  }
  let layers: (string | Gradient)[] | undefined = style.backgroundLayers ? [...style.backgroundLayers] : undefined;
  if (typeof style.background === "string" && style.background.includes("gradient(")) {
    const parts = splitLayers(style.background);
    if (parts.length > 1) {
      style.background = parts.at(-1)!;
      layers = [...(layers ?? []), ...parts.slice(0, -1)];
    }
  }
  if (!layers) return;
  const colour = (value: string) => resolveThemeColor(cssColor(value), selected);
  style.backgroundLayers = layers.map(layer => {
    const gradient = typeof layer === "string" && GRADIENT.test(layer) ? parseGradient(layer) : layer;
    return gradient && typeof gradient === "object" ? normalizeGradient(gradient, colour) : colour(gradient as string);
  });
}

function resolveThemeStyleUncached(style: Style, selected: ThemeDefinition): Style {
  const resolved: Style = { ...style };
  resolveCssLayers(resolved, selected);
  for (const key of Object.keys(resolved) as (keyof Style)[]) {
    const value = resolved[key];
    if (typeof value === "string") (resolved as Record<string, unknown>)[key] = resolveStyleString(key, value, selected);
  }
  resolveShadowColors(resolved, selected);
  for (let index = 0; index < STATE_KEYS.length; index++) {
    const state = STATE_KEYS[index]!;
    const value = style[state];
    if (!value) continue;
    const next = { ...value };
    resolveCssLayers(next, selected);
    for (const key of Object.keys(next) as (keyof typeof next)[]) {
      const stateValue = next[key];
      if (typeof stateValue === "string") {
        (next as Record<string, unknown>)[key] = resolveStyleString(key, stateValue, selected);
      }
    }
    resolveShadowColors(next, selected);
    resolved[state] = next;
  }
  if (style.animation) {
    const frame = (values: StateStyle | undefined) => {
      if (!values) return undefined;
      const next = { ...values };
      for (const key of Object.keys(next) as (keyof StateStyle)[]) {
        const value = next[key];
        if (typeof value === "string") (next as Record<string, unknown>)[key] = resolveStyleString(key, value, selected);
      }
      resolveShadowColors(next, selected);
      return next;
    };
    const { from, to, ...timing } = style.animation;
    resolved.animation = { ...timing, from: frame(from as StateStyle) as StyleAnimation["from"], ...(to ? { to: frame(to as StateStyle) as StyleAnimation["to"] } : {}) };
  }
  return resolved;
}

export type ButtonVariant = "default" | "secondary" | "outline" | "ghost" | "destructive";
export const buttonVariants: Record<ButtonVariant, Style> = {
  default: {
    background: theme.colors.primary,
    foreground: theme.colors.primaryForeground,
    hover: { background: theme.colors.primaryHover },
    active: { background: theme.colors.primaryActive },
  },
  secondary: {
    background: theme.colors.secondary,
    foreground: theme.colors.secondaryForeground,
    hover: { background: theme.colors.secondaryHover },
    active: { background: theme.colors.secondaryActive },
  },
  outline: {
    background: theme.colors.input,
    foreground: theme.colors.foreground,
    borderColor: theme.colors.border,
    borderWidth: 1,
    hover: { background: theme.colors.muted },
    active: { background: theme.colors.secondaryActive },
  },
  ghost: {
    background: "#00000000",
    foreground: theme.colors.foreground,
    hover: { background: theme.colors.muted },
    active: { background: theme.colors.secondaryActive },
  },
  destructive: {
    background: theme.colors.destructive,
    foreground: theme.colors.destructiveForeground,
    hover: { background: theme.colors.destructiveHover },
    active: { background: theme.colors.destructiveActive },
  },
};
