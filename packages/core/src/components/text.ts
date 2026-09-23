import { jsx, type BaseProps, type Child, type VNode } from "../jsx-runtime";
import { theme } from "../theme";

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
