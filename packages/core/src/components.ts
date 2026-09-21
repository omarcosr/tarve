import type { Control, Style } from "../../protocol/src/index";
import { jsx, type BaseProps, type Child, type VNode } from "./jsx-runtime";
import { theme, buttonVariants, type ButtonVariant } from "./theme";
export interface ViewProps extends BaseProps { gap?: number; padding?: Style["padding"]; flex?: number; align?: Style["align"]; justify?: Style["justify"] }
function container(kind: string, props: ViewProps, defaults: Style = {}): VNode {
  const { gap, padding, flex, align, justify, style, ...rest } = props;
  const overrides = Object.fromEntries(Object.entries({ gap, padding, flex, align, justify }).filter(([, v]) => v !== undefined));
  return jsx(kind, { ...rest, style: { ...defaults, ...overrides, ...style } });
}
export interface WindowProps extends ViewProps { title?: string; width?: number; height?: number; minWidth?: number; minHeight?: number }
export function Window(props: WindowProps): VNode { return container("window", { ...props, style: { background: theme.colors.background, ...props.style } }); }
export function View(props: ViewProps): VNode { return container("view", props); }
export function Row(props: ViewProps): VNode { return container("row", props, { direction: "row", align: "center" }); }
export function Column(props: ViewProps): VNode { return container("column", props, { direction: "column" }); }
export interface PressableProps extends ViewProps {
  disabled?: boolean; onClick?: () => void; onHover?: (hovered: boolean) => void; control?: Control;
}
export function Pressable(props: PressableProps): VNode {
  return container("pressable", props, { radius: theme.radius.sm, focusColor: theme.colors.ring });
}
export type IconName = "check" | "x" | "plus" | "minus" | "chevron-down" | "chevron-up" | "chevron-right" | "chevron-left" | "search" | "info";
export interface IconProps extends BaseProps { name: IconName; size?: number; color?: string; strokeWidth?: number }
export function Icon({ size = 16, color = theme.colors.foreground, strokeWidth = 1.75, style, ...props }: IconProps): VNode {
  return jsx("icon", { ...props, style: { width: size, height: size, shrink: 0, foreground: color, strokeWidth, ...style } });
}
export interface TextProps extends BaseProps { size?: number; weight?: number; color?: string; children?: Child }
export function Text({ size, weight, color, style, ...props }: TextProps): VNode {
  return jsx("text", { ...props, style: { fontFamily: theme.font.family, lineHeight: theme.font.lineHeight, fontSize: size ?? theme.font.size, fontWeight: weight ?? 400, foreground: color ?? theme.colors.foreground, ...style } });
}
export interface ButtonProps extends BaseProps { variant?: ButtonVariant; size?: "sm" | "default" | "lg"; disabled?: boolean; onClick?: () => void; onHover?: (hovered: boolean) => void }
export function Button({ variant = "default", size = "default", style, disabled, ...props }: ButtonProps): VNode {
  const height = { sm: 32, default: 36, lg: 40 }[size];
  return jsx("button", { ...props, disabled, style: {
    height, padding: { left: 14, right: 14 }, radius: theme.radius.sm, fontSize: 14,
    fontFamily: theme.font.family, lineHeight: theme.font.lineHeight, fontWeight: 500, align: "center", justify: "center", focusColor: theme.colors.ring,
    shrink: 0, ...buttonVariants[variant], ...(disabled ? { background: "#e4e4e7", foreground: "#a1a1aa", hoverBackground: "#e4e4e7" } : {}), ...style,
  } });
}
export interface ImageProps extends BaseProps { src: string; width?: number; height?: number; fit?: "cover" | "contain" }
export function Image({ width, height, style, ...props }: ImageProps): VNode { return jsx("image", { ...props, style: { width, height, radius: theme.radius.md, ...style } }); }
export function Scroll(props: ViewProps): VNode { return container("scroll", props, { minHeight: 0, shrink: 1 }); }
export interface TextInputProps extends BaseProps { value?: string; placeholder?: string; disabled?: boolean; onChange?: (value: string) => void }
export function TextInput({ style, ...props }: TextInputProps): VNode {
  return jsx("input", { ...props, style: { height: 38, minWidth: 120, padding: { left: 12, right: 12 },
    radius: theme.radius.sm, borderWidth: 1, borderColor: theme.colors.border, background: "#ffffff",
    foreground: theme.colors.foreground, fontFamily: theme.font.family, lineHeight: theme.font.lineHeight, fontSize: theme.font.size, focusColor: theme.colors.ring, ...style } });
}
