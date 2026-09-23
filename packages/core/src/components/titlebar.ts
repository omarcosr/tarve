import { jsx, type Child, type VNode } from "../jsx-runtime";
import { theme } from "../theme";
import { Icon } from "./icon";
import { container, Row, View, type ViewProps } from "./layout";
import { Pressable } from "./pressable";
import { Text } from "./text";

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
