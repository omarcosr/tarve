import type { Style } from "../../protocol/src/index";
export const theme = {
  colors: {
    background: "#fafafa", card: "#ffffff", foreground: "#18181b", muted: "#f4f4f5",
    mutedForeground: "#71717a", border: "#e4e4e7", primary: "#18181b",
    primaryForeground: "#fafafa", destructive: "#dc2626", ring: "#a1a1aa",
    success: "#15803d", successMuted: "#f0fdf4",
  },
  space: { xs: 4, sm: 8, md: 12, lg: 16, xl: 24, xxl: 32 },
  radius: { sm: 6, md: 8, lg: 12 },
  font: { family: "Segoe UI", size: 14, lineHeight: 1.5 },
} as const;
export type ButtonVariant = "default" | "secondary" | "outline" | "ghost" | "destructive";
export const buttonVariants: Record<ButtonVariant, Style> = {
  default: { background: theme.colors.primary, foreground: theme.colors.primaryForeground, hoverBackground: "#303036", activeBackground: "#3f3f46" },
  secondary: { background: theme.colors.muted, foreground: theme.colors.foreground, hoverBackground: "#e4e4e7", activeBackground: "#d4d4d8" },
  outline: { background: "#ffffff", foreground: theme.colors.foreground, borderColor: theme.colors.border, borderWidth: 1, hoverBackground: "#f4f4f5", activeBackground: "#e4e4e7" },
  ghost: { background: "#00000000", foreground: theme.colors.foreground, hoverBackground: "#f4f4f5", activeBackground: "#e4e4e7" },
  destructive: { background: theme.colors.destructive, foreground: "#ffffff", hoverBackground: "#b91c1c", activeBackground: "#991b1b" },
};
