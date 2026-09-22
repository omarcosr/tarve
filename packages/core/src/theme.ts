import type { Style } from "../../protocol/src/index";

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
  success: string;
  successMuted: string;
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
}

export interface ThemeOverrides {
  colors?: Partial<ThemeColors>;
}

export const lightTheme: ThemeDefinition = {
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
    success: "#15803d",
    successMuted: "#f0fdf4",
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
    success: "#4ade80",
    successMuted: "#052e16",
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
  return { colors: { ...base.colors, ...overrides.colors } };
}

const names = Object.keys(lightTheme.colors) as (keyof ThemeColors)[];
const cssName = (name: string) => name.replace(/[A-Z]/g, value => `-${value.toLowerCase()}`);
const refs = Object.fromEntries(names.map(name => [name, `var(--${cssName(name)})`])) as Record<keyof ThemeColors, string>;
const keyByRef = new Map(names.map(name => [refs[name], name] as const));

/** Semantic tokens used by components and application styles. */
export const theme = {
  colors: refs,
  space: { xs: 4, sm: 8, md: 12, lg: 16, xl: 24, xxl: 32 },
  radius: { sm: 6, md: 8, lg: 12 },
  font: { family: "Segoe UI", size: 14, lineHeight: 1.5 },
} as const;

export function resolveThemeColor(value: string, selected: ThemeDefinition): string {
  const key = keyByRef.get(value);
  return key ? selected.colors[key] : value;
}

export function resolveThemeStyle(style: Style, selected: ThemeDefinition): Style {
  const resolved: Style = { ...style };
  for (const key of Object.keys(resolved) as (keyof Style)[]) {
    const value = resolved[key];
    if (typeof value === "string") (resolved as Record<string, unknown>)[key] = resolveThemeColor(value, selected);
  }
  for (const state of ["hover", "focus", "active", "disabled"] as const) {
    const value = style[state];
    if (!value) continue;
    const next = { ...value };
    for (const key of Object.keys(next) as (keyof typeof next)[]) {
      const stateValue = next[key];
      if (typeof stateValue === "string") {
        (next as Record<string, unknown>)[key] = resolveThemeColor(stateValue, selected);
      }
    }
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
