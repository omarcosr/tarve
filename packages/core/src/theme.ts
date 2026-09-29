import type { BoxShadow, StateStyle, Style, SyntaxTheme } from "../../protocol/src/index";
import { cssColor, parseBoxShadow, parseTextShadow, parseTransform } from "./css-shadow";

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

export function resolveThemeColor(value: string, selected: ThemeDefinition): string {
  const key = keyByRef.get(value);
  return key ? selected.colors[key] : value;
}

/** Normalizes CSS shadow strings and CSS colours (rgba(), hsl(), names) and resolves theme tokens. */
function resolveShadowColors(style: StateStyle, selected: ThemeDefinition): void {
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
  const box = typeof style.boxShadow === "string" ? parseBoxShadow(style.boxShadow) : style.boxShadow;
  if (box !== undefined) {
    style.boxShadow = Array.isArray(box)
      ? box.map(shadow => ({ ...shadow, color: colour(shadow.color) }))
      : { ...(box as BoxShadow), color: colour((box as BoxShadow).color) };
  }
}

/** Style keys whose string value is a colour (background, borderColor, diffAddedBackground, …). */
const COLOR_KEY = /^(background|foreground|color)$|(Color|Background|Foreground|Accent|Rule)$/;

/** Theme token or CSS colour (hex, rgb(), hsl(), names) for colour keys; other strings unchanged. */
export function resolveStyleString(key: string, value: string, selected: ThemeDefinition): string {
  return resolveThemeColor(COLOR_KEY.test(key) ? cssColor(value) : value, selected);
}

export function resolveThemeStyle(style: Style, selected: ThemeDefinition): Style {
  const resolved: Style = { ...style };
  for (const key of Object.keys(resolved) as (keyof Style)[]) {
    const value = resolved[key];
    if (typeof value === "string") (resolved as Record<string, unknown>)[key] = resolveStyleString(key, value, selected);
  }
  resolveShadowColors(resolved, selected);
  for (const state of ["hover", "focus", "focusVisible", "active", "disabled"] as const) {
    const value = style[state];
    if (!value) continue;
    const next = { ...value };
    for (const key of Object.keys(next) as (keyof typeof next)[]) {
      const stateValue = next[key];
      if (typeof stateValue === "string") {
        (next as Record<string, unknown>)[key] = resolveStyleString(key, stateValue, selected);
      }
    }
    resolveShadowColors(next, selected);
    resolved[state] = next;
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
