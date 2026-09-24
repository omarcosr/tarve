import type { Control } from "../../../protocol/src/index";
import type { VNode } from "../jsx-runtime";
import { theme } from "../theme";
import { container, type ViewProps } from "./layout";

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
  return container("pressable", props, { radius: theme.radius.sm, userSelect: "none" });
}
