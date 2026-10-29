import type { Control } from "../protocol";
import type { DraggableProps, VNode } from "../jsx-runtime";
import { theme } from "../theme";
import { container, type ViewProps } from "./layout";

export interface PressableProps extends ViewProps, DraggableProps {
  disabled?: boolean;
  onClick?: () => void;
  onContextMenu?: (position: { x: number; y: number }) => void;
  /** The press was held still for 500 ms (touch or mouse); its release sends no `onClick`. */
  onLongPress?: () => void;
  /** Two fingers pinching over this node (touch screen, macOS trackpad); `scale` is cumulative, 1 at "start". */
  onPinch?: (event: import("../jsx-runtime").PinchEvent) => void;
  onHover?: (hovered: boolean) => void;
  control?: Control;
  focusable?: boolean;
  onEscape?: () => void;
  onKeyDown?: (key: string) => void;
  onBlur?: () => void;
  modal?: boolean;
}

export function Pressable(props: PressableProps): VNode {
  return container("pressable", props, { radius: theme.radius.sm, userSelect: "none" });
}
