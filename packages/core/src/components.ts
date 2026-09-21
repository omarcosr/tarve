import type { Control, Style } from "../../protocol/src/index";
import { Fragment, jsx, type BaseProps, type Child, type VNode } from "./jsx-runtime";
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
  focusable?: boolean; onEscape?: () => void; modal?: boolean;
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

export interface ModalProps extends BaseProps {
  open: boolean;
  onOpenChange?: (open: boolean) => void;
  title?: string;
  description?: string;
  footer?: Child;
  width?: number;
  closeOnOverlay?: boolean;
  closeOnEscape?: boolean;
  showClose?: boolean;
}

export function Modal({
  open,
  onOpenChange,
  title,
  description,
  footer,
  width = 480,
  closeOnOverlay = true,
  closeOnEscape = true,
  showClose = true,
  children,
  style,
  ...props
}: ModalProps): VNode {
  if (!open) return jsx(Fragment, {});
  const close = () => onOpenChange?.(false);
  const modalId = props.id;
  const header = title || description ? jsx(Column, {
    gap: 6,
    style: { padding: { right: showClose ? 28 : 0 } },
    children: [
      title ? jsx(Text, { size: 18, weight: 600, children: title }) : null,
      description ? jsx(Text, { size: 14, color: theme.colors.mutedForeground, children: description }) : null,
    ],
  }) : null;
  const closeButton = showClose ? jsx(Pressable, {
    ...(modalId ? { id: `${modalId}-close` } : {}),
    onClick: close,
    control: { role: "button", label: "Close dialog" },
    style: {
      position: "absolute", top: 14, right: 14, width: 30, height: 30,
      radius: theme.radius.sm, align: "center", justify: "center",
      background: "#00000000", hoverBackground: theme.colors.muted,
      activeBackground: theme.colors.border, focusColor: theme.colors.ring,
    },
    children: jsx(Icon, { name: "x", size: 16, color: theme.colors.mutedForeground }),
  }) : null;
  const footerNode = footer ? jsx(Row, { gap: 8, justify: "end", children: footer }) : null;
  const panel = jsx(Column, {
    ...(modalId ? { id: `${modalId}-content` } : {}),
    style: {
      position: "relative", width, maxWidth: "90%", background: theme.colors.card,
      borderWidth: 1, borderColor: theme.colors.border, radius: theme.radius.lg,
      padding: 24, gap: 20, pointerEvents: "block", ...style,
    },
    children: [header, closeButton, children, footerNode],
  });
  return jsx(Pressable, {
    ...props,
    modal: true,
    focusable: false,
    onClick: closeOnOverlay ? close : undefined,
    onEscape: closeOnEscape ? close : undefined,
    style: {
      position: "absolute", top: 0, right: 0, bottom: 0, left: 0,
      padding: 24, align: "center", justify: "center", background: "#00000066",
      pointerEvents: "block",
    },
    children: panel,
  });
}

export const Dialog = Modal;
export type DialogProps = ModalProps;
