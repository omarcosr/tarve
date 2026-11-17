import { Fragment, jsx, type BaseProps, type Child, type VNode } from "../jsx-runtime";
import { theme } from "../theme";
import { Icon } from "./icon";
import { Column, Row } from "./layout";
import { Pressable } from "./pressable";
import { Text } from "./text";
import { Scroll } from "./scroll";

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
  /**
   * The panel never grows past the window (24 px margins): title and footer stay put and the
   * body scrolls (a `Scroll`). Default `true`; `false` lays the body out unbounded, as before.
   */
  scrollBody?: boolean;
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
  scrollBody = true,
  children,
  style,
  ...props
}: ModalProps): VNode {
  if (!open) return jsx(Fragment, {});
  const close = () => onOpenChange?.(false);
  const modalId = props.id;
  const header = title || description
    ? jsx(Column, {
          gap: 6,
          style: { shrink: 0, padding: { right: showClose ? 28 : 0 } },
        children: [
          title ? jsx(Text, { size: 18, weight: 600, children: title }) : null,
          description ? jsx(Text, { size: 14, color: theme.colors.mutedForeground, children: description }) : null,
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
        children: jsx(Icon, { name: "x", size: 16, color: theme.colors.mutedForeground }),
      })
    : null;
  const footerNode = footer ? jsx(Row, { gap: 8, justify: "end", style: { shrink: 0 }, children: footer }) : null;
  // The body takes what header and footer leave; content that fits lays out as a plain column.
  const body = scrollBody && children != null && children !== false
    ? jsx(Scroll, {
        ...(modalId ? { id: `${modalId}-body` } : {}),
        style: { direction: "column", gap: 20 },
        children,
      })
    : children;
  const panel = jsx(Column, {
    ...(modalId ? { id: `${modalId}-content` } : {}),
    ...((title || description) ? {
      control: { role: "group", label: title ?? "", description: description ?? "" },
    } : {}),
    modal: true,
    style: {
      position: "relative",
      width,
      maxWidth: "90%",
      maxHeight: "100%",
      background: theme.colors.card,
      borderWidth: 1,
      borderColor: theme.colors.border,
      radius: theme.radius.lg,
      padding: 24,
      gap: 20,
      pointerEvents: "block",
      ...style,
    },
    children: [header, closeButton, body, footerNode],
  });
  return jsx(Pressable, {
    ...props,
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
