import { jsx, type BaseProps, type Child, type IntrinsicStyle, type VNode } from "../jsx-runtime";
import { canonicalizeIntrinsicStyle } from "../intrinsic-style";
import { theme } from "../theme";

export interface TextProps extends Omit<BaseProps, "style"> {
  size?: number;
  weight?: number;
  color?: string;
  style?: IntrinsicStyle;
  children?: Child;
}

export function Text({ size, weight, color, style, ...props }: TextProps): VNode {
  const canonicalStyle = canonicalizeIntrinsicStyle(style);
  return jsx("text", {
    ...props,
    style: {
      fontFamily: theme.font.family,
      lineHeight: theme.font.lineHeight,
      fontSize: size ?? theme.font.size,
      fontWeight: weight ?? 400,
      foreground: color ?? theme.colors.foreground,
      ...canonicalStyle,
    },
  });
}
