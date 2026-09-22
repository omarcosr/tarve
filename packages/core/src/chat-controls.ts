import { jsx, type BaseProps, type Child, type VNode } from "./jsx-runtime";
import { Button, Column, Row, Scroll, Text, View } from "./components";
import { Avatar } from "./extra-controls";
import { Progress } from "./controls";
import { theme } from "./theme";

const c = theme.colors;

export type AttachmentStatus = "ready" | "uploading" | "error";
export interface AttachmentProps extends BaseProps {
  name: string;
  size?: string;
  status?: AttachmentStatus;
  progress?: number;
  leading?: Child;
  removeLabel?: string;
  onRemove?: () => void;
}
export function Attachment({ name, size, status = "ready", progress = 0, leading, removeLabel = "Remove",
  onRemove, style, id, ...props }: AttachmentProps): VNode {
  if (!Number.isFinite(progress) || progress < 0 || progress > 100) throw new RangeError("Attachment progress must be between 0 and 100");
  const statusColor = status === "error" ? c.destructive : status === "uploading" ? c.mutedForeground : c.foreground;
  return jsx(Column, {
    ...props,
    ...(id ? { id } : {}),
    gap: 6,
    style: { minWidth: 180, padding: 10, background: c.card, borderWidth: 1, borderColor: status === "error" ? c.destructive : c.border,
      radius: theme.radius.md, ...style },
    children: [
      jsx(Row, { gap: 8, children: [
        leading,
        jsx(Column, { gap: 2, flex: 1, children: [
          jsx(Text, { weight: 500, color: statusColor, children: name }),
          size ? jsx(Text, { size: 11, color: c.mutedForeground, children: size }) : null,
        ] }),
        onRemove ? jsx(Button, { ...(id ? { id: `${id}-remove` } : {}), variant: "ghost", size: "sm", onClick: onRemove, children: removeLabel }) : null,
      ] }),
      status === "uploading" ? jsx(Progress, { ...(id ? { id: `${id}-progress` } : {}), value: progress, max: 100, label: `${name} upload progress` }) : null,
      status === "error" ? jsx(Text, { ...(id ? { id: `${id}-error` } : {}), size: 11, color: c.destructive, children: "Upload failed" }) : null,
    ],
  });
}

export type BubbleSide = "incoming" | "outgoing";
export type BubbleVariant = "default" | "secondary" | "destructive";
export interface BubbleProps extends BaseProps {
  side?: BubbleSide;
  variant?: BubbleVariant;
  maxWidth?: number | `${number}%`;
}
function bubbleText(children: Child, foreground: string): Child {
  if (typeof children === "string" || typeof children === "number") return jsx(Text, { color: foreground, children });
  if (Array.isArray(children)) return children.map(child => bubbleText(child, foreground));
  if (children && typeof children === "object") {
    const vnode = children as VNode;
    if (vnode.type === Text && vnode.props.color === undefined && vnode.props.style?.foreground === undefined) {
      return { ...vnode, props: { ...vnode.props, color: foreground } };
    }
    if ((vnode.type === View || vnode.type === Row || vnode.type === Column || vnode.type === Scroll)
        && vnode.props.children !== undefined) {
      return { ...vnode, props: { ...vnode.props, children: bubbleText(vnode.props.children, foreground) } };
    }
  }
  return children;
}
export function Bubble({ side = "incoming", variant = "default", maxWidth = "80%", children, style, ...props }: BubbleProps): VNode {
  if (typeof maxWidth === "number" && (!Number.isFinite(maxWidth) || maxWidth <= 0)) {
    throw new RangeError("Bubble maxWidth must be greater than zero");
  }
  const variants: Record<BubbleVariant, { background: string; foreground: string }> = {
    default: side === "outgoing"
      ? { background: c.primary, foreground: c.primaryForeground }
      : { background: c.muted, foreground: c.foreground },
    secondary: { background: c.secondary, foreground: c.secondaryForeground },
    destructive: { background: c.destructive, foreground: c.destructiveForeground },
  };
  const selected = variants[variant];
  return jsx(View, { ...props, style: { maxWidth, padding: { left: 12, right: 12, top: 8, bottom: 8 },
    radius: theme.radius.lg, background: selected.background, foreground: selected.foreground, ...style },
    children: bubbleText(children, selected.foreground) });
}

export interface MarkerProps extends BaseProps {
  label?: string;
}
export function Marker({ label, children, style, ...props }: MarkerProps): VNode {
  const content = children ?? label;
  const markerContent = typeof content === "string" || typeof content === "number"
    ? jsx(Text, { size: 11, color: c.mutedForeground, children: content })
    : content;
  return jsx(Row, { ...props, gap: 10, align: "center", style: { width: "100%", ...style }, children: [
    jsx(View, { flex: 1, style: { height: 1, background: c.border } }),
    markerContent,
    jsx(View, { flex: 1, style: { height: 1, background: c.border } }),
  ] });
}

export interface MessageProps extends BaseProps {
  side?: BubbleSide;
  author?: string;
  avatarSrc?: string;
  avatarFallback?: string;
  timestamp?: string;
  actions?: Child;
  bubbleVariant?: BubbleVariant;
}
export function Message({ side = "incoming", author, avatarSrc, avatarFallback, timestamp, actions,
  bubbleVariant = "default", children, style, id, ...props }: MessageProps): VNode {
  const avatar = avatarSrc || avatarFallback || author ? jsx(Avatar, { ...(id ? { id: `${id}-avatar` } : {}), src: avatarSrc,
    fallback: avatarFallback ?? author?.slice(0, 2).toUpperCase() ?? "?", size: 32 }) : null;
  const body = jsx(Column, { gap: 4, style: { maxWidth: "80%" }, children: [
    author || timestamp ? jsx(Row, { gap: 6, justify: side === "outgoing" ? "end" : "start", children: [
      author ? jsx(Text, { size: 11, weight: 600, children: author }) : null,
      timestamp ? jsx(Text, { size: 11, color: c.mutedForeground, children: timestamp }) : null,
    ] }) : null,
    jsx(Bubble, { ...(id ? { id: `${id}-bubble` } : {}), side, variant: bubbleVariant, maxWidth: "100%", children }),
    actions ? jsx(Row, { gap: 4, justify: side === "outgoing" ? "end" : "start", children: actions }) : null,
  ] });
  return jsx(Row, {
    ...props,
    ...(id ? { id } : {}),
    gap: 8,
    align: "end",
    justify: side === "outgoing" ? "end" : "start",
    style: { width: "100%", ...style },
    children: side === "outgoing" ? [body, avatar] : [avatar, body],
  });
}

export interface MessageScrollerProps extends BaseProps {
  height?: number;
  gap?: number;
  onScroll?: (offset: number, max: number) => void;
}
export function MessageScroller({ height = 360, gap = 12, onScroll, children, style, ...props }: MessageScrollerProps): VNode {
  if (!Number.isFinite(height) || height <= 0) throw new RangeError("MessageScroller height must be greater than zero");
  if (!Number.isFinite(gap) || gap < 0) throw new RangeError("MessageScroller gap must be finite and non-negative");
  return jsx(Scroll, { ...props, gap, onScroll, style: { width: "100%", height, padding: 12, ...style }, children });
}
