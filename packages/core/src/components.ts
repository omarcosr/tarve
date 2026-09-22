import type { Control, Style, WindowPosition } from "../../protocol/src/index";
import { Fragment, jsx, type BaseProps, type Child, type VNode } from "./jsx-runtime";
import { buttonVariants, theme, type ButtonVariant, type ThemeDefinition } from "./theme";
export interface ViewProps extends BaseProps {
  gap?: number;
  padding?: Style["padding"];
  flex?: number;
  align?: Style["align"];
  justify?: Style["justify"];
  portal?: boolean;
  dismissOnOutside?: boolean;
  onOutsideClick?: () => void;
  dragRegion?: boolean;
  windowAction?: "minimize" | "toggleMaximize" | "close";
  focusable?: boolean;
}
function container(kind: string, props: ViewProps, defaults: Style = {}): VNode {
  const { gap, padding, flex, align, justify, style, ...rest } = props;
  const overrides = Object.fromEntries(
    Object.entries({ gap, padding, flex, align, justify }).filter(([, v]) => v !== undefined),
  );
  return jsx(kind, { ...rest, style: { ...defaults, ...overrides, ...style } });
}
export interface WindowProps extends ViewProps {
  title?: string;
  width?: number;
  height?: number;
  minWidth?: number;
  minHeight?: number;
  resizable?: boolean;
  position?: WindowPosition;
  theme?: ThemeDefinition;
  onCloseRequest?: (event: WindowCloseRequestEvent) => void;
}
export interface WindowCloseRequestEvent {
  readonly defaultPrevented: boolean;
  preventDefault(): void;
}
export function Window(props: WindowProps): VNode {
  return container("window", {
    ...props,
    style: { background: theme.colors.background, ...props.style },
  });
}
export function View(props: ViewProps): VNode {
  return container("view", props);
}
export function Row(props: ViewProps): VNode {
  return container("row", props, { direction: "row", align: "center" });
}
export function Column(props: ViewProps): VNode {
  return container("column", props, { direction: "column" });
}
export type PortalProps = ViewProps;
export function Portal(props: PortalProps): VNode {
  return container("view", { ...props, portal: true });
}
export interface PressableProps extends ViewProps {
  disabled?: boolean;
  onClick?: () => void;
  onContextMenu?: (position: { x: number; y: number }) => void;
  onHover?: (hovered: boolean) => void;
  control?: Control;
  focusable?: boolean;
  onEscape?: () => void;
  onKeyDown?: (key: string) => void;
  onBlur?: () => void;
  modal?: boolean;
}
export function Pressable(props: PressableProps): VNode {
  return container("pressable", props, {
    radius: theme.radius.sm,
  });
}
export type IconName =
  | "check"
  | "x"
  | "plus"
  | "minus"
  | "chevron-down"
  | "chevron-up"
  | "chevron-right"
  | "chevron-left"
  | "search"
  | "info";
export interface IconProps extends BaseProps {
  name: IconName;
  size?: number;
  color?: string;
  strokeWidth?: number;
}
export function Icon({
  size = 16,
  color = theme.colors.foreground,
  strokeWidth = 1.75,
  style,
  ...props
}: IconProps): VNode {
  return jsx("icon", {
    ...props,
    style: { width: size, height: size, shrink: 0, foreground: color, strokeWidth, ...style },
  });
}
export interface TextProps extends BaseProps {
  size?: number;
  weight?: number;
  color?: string;
  children?: Child;
}
export function Text({ size, weight, color, style, ...props }: TextProps): VNode {
  return jsx("text", {
    ...props,
    style: {
      fontFamily: theme.font.family,
      lineHeight: theme.font.lineHeight,
      fontSize: size ?? theme.font.size,
      fontWeight: weight ?? 400,
      foreground: color ?? theme.colors.foreground,
      ...style,
    },
  });
}
export interface ButtonProps extends BaseProps {
  variant?: ButtonVariant;
  size?: "sm" | "default" | "lg";
  disabled?: boolean;
  onClick?: () => void;
  onHover?: (hovered: boolean) => void;
}
export function Button({
  variant = "default",
  size = "default",
  style,
  disabled,
  ...props
}: ButtonProps): VNode {
  const height = { sm: 32, default: 36, lg: 40 }[size];
  return jsx("button", {
    ...props,
    disabled,
    style: {
      height,
      padding: { left: 14, right: 14 },
      radius: theme.radius.sm,
      fontSize: 14,
      fontFamily: theme.font.family,
      lineHeight: theme.font.lineHeight,
      fontWeight: 500,
      align: "center",
      justify: "center",
      disabled: {
        background: theme.colors.disabled,
        foreground: theme.colors.disabledForeground,
      },
      shrink: 0,
      ...buttonVariants[variant],
      ...style,
    },
  });
}
export interface ImageProps extends BaseProps {
  src: string;
  width?: number;
  height?: number;
  fit?: "cover" | "contain";
}
export function Image({ width, height, style, ...props }: ImageProps): VNode {
  return jsx("image", {
    ...props,
    style: {
      width,
      height,
      radius: theme.radius.md,
      placeholderBackground: theme.colors.imagePlaceholder,
      ...style,
    },
  });
}
export interface ScrollProps extends ViewProps {
  speed?: number;
  onScroll?: (offset: number, max: number) => void;
}
export function Scroll({ speed = 1, ...props }: ScrollProps): VNode {
  if (!Number.isFinite(speed) || speed <= 0) throw new RangeError("Scroll speed must be finite and greater than zero");
  const nativeProps = { ...props, scrollSpeed: speed };
  return container("scroll", nativeProps, {
    minHeight: 0,
    shrink: 1,
    scrollbarColor: theme.colors.scrollbar,
  });
}
export type InputType = "text" | "password" | "email" | "number" | "search" | "tel" | "url";
export interface InputProps extends BaseProps {
  type?: InputType;
  value?: string;
  placeholder?: string;
  disabled?: boolean;
  onChange?: (value: string) => void;
}
const inputTypes = new Set<InputType>(["text", "password", "email", "number", "search", "tel", "url"]);
const numberEditPattern = /^[+-]?(?:\.?|(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d*)?)$/;
export function Input({ type = "text", value, style, ...props }: InputProps): VNode {
  if (!inputTypes.has(type)) throw new TypeError(`Unsupported Input type: ${String(type)}`);
  if (type === "number" && value !== undefined && !numberEditPattern.test(value)) {
    throw new TypeError("Input type=number value must be a valid numeric edit value");
  }
  return jsx("input", {
    ...props,
    value,
    inputType: type,
    style: {
      height: 38,
      minWidth: 120,
      padding: { left: 12, right: 12 },
      radius: theme.radius.sm,
      borderWidth: 1,
      borderColor: theme.colors.border,
      background: theme.colors.input,
      foreground: theme.colors.foreground,
      placeholderColor: theme.colors.placeholder,
      selectionColor: theme.colors.selection,
      caretColor: theme.colors.foreground,
      fontFamily: theme.font.family,
      lineHeight: theme.font.lineHeight,
      fontSize: theme.font.size,
      ...style,
    },
  });
}
export interface TextAreaProps extends BaseProps {
  value?: string;
  placeholder?: string;
  disabled?: boolean;
  onChange?: (value: string) => void;
}
export function TextArea({ style, ...props }: TextAreaProps): VNode {
  return jsx("textarea", {
    ...props,
    style: {
      width: "100%",
      height: 120,
      minWidth: 180,
      minHeight: 72,
      padding: 12,
      radius: theme.radius.sm,
      borderWidth: 1,
      borderColor: theme.colors.border,
      background: theme.colors.input,
      foreground: theme.colors.foreground,
      placeholderColor: theme.colors.placeholder,
      selectionColor: theme.colors.selection,
      caretColor: theme.colors.foreground,
      fontFamily: theme.font.family,
      lineHeight: theme.font.lineHeight,
      fontSize: theme.font.size,
      ...style,
    },
  });
}

export interface TitleBarProps extends ViewProps {
  title?: string;
  height?: number;
  showMinimize?: boolean;
  showMaximize?: boolean;
  showClose?: boolean;
}

function titleBarButton(action: "minimize" | "toggleMaximize" | "close", child: Child): VNode {
  const close = action === "close";
  return jsx(Pressable, {
    windowAction: action,
    focusable: false,
    style: {
      width: 46,
      height: "100%",
      radius: 0,
      align: "center",
      justify: "center",
      background: "#00000000",
      hover: { background: close ? theme.colors.windowCloseHover : theme.colors.muted },
      active: { background: close ? theme.colors.windowCloseActive : theme.colors.border },
    },
    children: child,
  });
}

export function TitleBar({
  title,
  height = 40,
  showMinimize = true,
  showMaximize = true,
  showClose = true,
  children,
  style,
  ...props
}: TitleBarProps): VNode {
  const minimizeIcon = jsx(View, {
    style: { width: 10, height: 1, background: theme.colors.foreground },
  });
  const maximizeIcon = jsx(View, {
    style: { width: 10, height: 10, borderWidth: 1, borderColor: theme.colors.foreground },
  });
  const controls = jsx(Row, {
    style: { height: "100%", shrink: 0 },
    children: [
      showMinimize ? titleBarButton("minimize", minimizeIcon) : null,
      showMaximize ? titleBarButton("toggleMaximize", maximizeIcon) : null,
      showClose ? titleBarButton("close", jsx(Icon, { name: "x", size: 14 })) : null,
    ],
  });
  const content =
    children ?? (title ? jsx(Text, { size: 13, weight: 500, children: title }) : null);
  return container("titlebar", {
    ...props,
    dragRegion: true,
    style: {
      direction: "row",
      height,
      shrink: 0,
      padding: { left: 12 },
      background: theme.colors.card,
      borderWidth: { bottom: 1 },
      borderColor: theme.colors.border,
      justify: "between",
      align: "center",
      pointerEvents: "block",
      ...style,
    },
    children: [content, controls],
  });
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
  const header =
    title || description
      ? jsx(Column, {
          gap: 6,
          style: { padding: { right: showClose ? 28 : 0 } },
          children: [
            title ? jsx(Text, { size: 18, weight: 600, children: title }) : null,
            description
              ? jsx(Text, { size: 14, color: theme.colors.mutedForeground, children: description })
              : null,
          ],
        })
      : null;
  const closeButton = showClose
    ? jsx(Pressable, {
        ...(modalId ? { id: `${modalId}-close` } : {}),
        onClick: close,
        control: { role: "button", label: "Close dialog" },
        style: {
          position: "absolute",
          top: 14,
          right: 14,
          width: 30,
          height: 30,
          radius: theme.radius.sm,
          align: "center",
          justify: "center",
          background: "#00000000",
          hover: { background: theme.colors.muted },
          active: { background: theme.colors.border },
        },
        children: jsx(Icon, {
          name: "x",
          size: 16,
          color: theme.colors.mutedForeground,
        }),
      })
    : null;
  const footerNode = footer ? jsx(Row, { gap: 8, justify: "end", children: footer }) : null;
  const panel = jsx(Column, {
    ...(modalId ? { id: `${modalId}-content` } : {}),
    style: {
      position: "relative",
      width,
      maxWidth: "90%",
      background: theme.colors.card,
      borderWidth: 1,
      borderColor: theme.colors.border,
      radius: theme.radius.lg,
      padding: 24,
      gap: 20,
      pointerEvents: "block",
      ...style,
    },
    children: [header, closeButton, children, footerNode],
  });
  return jsx(Pressable, {
    ...props,
    modal: true,
    portal: true,
    focusable: false,
    onClick: closeOnOverlay ? close : undefined,
    onEscape: closeOnEscape ? close : undefined,
    style: {
      position: "absolute",
      top: 0,
      right: 0,
      bottom: 0,
      left: 0,
      padding: 24,
      align: "center",
      justify: "center",
      background: theme.colors.overlay,
      pointerEvents: "block",
    },
    children: panel,
  });
}

export const Dialog = Modal;
export type DialogProps = ModalProps;
