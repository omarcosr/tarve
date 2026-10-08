import { jsx, type Child, type VNode } from "../jsx-runtime";
import { theme } from "../theme";
import { Icon } from "./icon";
import type { SvgNode } from "./svg";
import { container, Row, type ViewProps } from "./layout";
import { Pressable } from "./pressable";
import { Text } from "./text";

export interface TitleBarProps extends ViewProps {
  title?: string;
  height?: number;
  showMinimize?: boolean;
  showMaximize?: boolean;
  showClose?: boolean;
}

/** `#rgb`/`#rrggbb` at `alpha` (0–255); other colors are returned unchanged. */
function translucent(color: string, alpha: number): string {
  const hex = color.trim().replace(/^#/, "");
  const full = hex.length === 3 ? [...hex].map(c => c + c).join("") : hex.slice(0, 6);
  return /^[0-9a-f]{6}$/i.test(full) ? `#${full}${Math.round(alpha).toString(16).padStart(2, "0")}` : color;
}

function titleBarButton(action: "minimize" | "toggleMaximize" | "close", child: Child, ink: string): VNode {
  const close = action === "close";
  const label = action === "minimize" ? "Minimize window" : action === "toggleMaximize" ? "Maximize or restore window" : "Close window";
  return jsx(Pressable, {
    windowAction: action,
    control: { role: "button", label },
    focusable: false,
    style: {
      width: 46,
      height: "100%",
      radius: 0,
      align: "center",
      justify: "center",
      background: "#00000000",
      // Over whatever the bar is painted with: a wash of its own ink, not a theme surface.
      hover: { background: close ? theme.colors.windowCloseHover : translucent(ink, 0x1f) },
      active: { background: close ? theme.colors.windowCloseActive : translucent(ink, 0x33) },
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
  // The controls draw in the bar's foreground, so a dark bar on a light theme
  // (or the reverse) still shows them.
  const ink = typeof style?.foreground === "string" ? style.foreground : theme.colors.foreground;
  // Stroked glyphs (one logical pixel at 12px), so all three get the same
  // antialiased weight at any scale; a 1px View border lands between device
  // pixels at 125% and draws two edges faint and two solid.
  const glyph = (iconNode: SvgNode[]) => jsx(Icon, { iconNode, size: 12, strokeWidth: 2, color: ink });
  const minimizeIcon = glyph([["path", { d: "M3 12h18" }]]);
  const maximizeIcon = glyph([["rect", { x: 3, y: 3, width: 18, height: 18, rx: 2 }]]);
  const closeIcon = glyph([["path", { d: "M4 4l16 16M20 4 4 20" }]]);
  const controls = jsx(Row, {
    style: { height: "100%", shrink: 0 },
    children: [
      showMinimize ? titleBarButton("minimize", minimizeIcon, ink) : null,
      showMaximize ? titleBarButton("toggleMaximize", maximizeIcon, ink) : null,
      showClose ? titleBarButton("close", closeIcon, ink) : null,
    ],
  });
  const content = children ?? (title ? jsx(Text, { size: 13, weight: 500, children: title }) : null);
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
