import { jsx, type BaseProps, type VNode } from "../jsx-runtime";
import { theme } from "../theme";

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

export function Icon({ size = 16, color = theme.colors.foreground, strokeWidth = 1.75, style, ...props }: IconProps): VNode {
  return jsx("icon", {
    ...props,
    style: { width: size, height: size, shrink: 0, foreground: color, strokeWidth, ...style },
  });
}
