import { jsx, type BaseProps, type Child, type IntrinsicStyle, type VNode } from "../jsx-runtime";
import { canonicalizeIntrinsicStyle } from "../intrinsic-style";

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
    // Unset font and colour inherit from the parent, like CSS; the theme gives the root values.
    style: {
      ...(size !== undefined ? { fontSize: size } : {}),
      ...(weight !== undefined ? { fontWeight: weight } : {}),
      ...(color !== undefined ? { foreground: color } : {}),
      ...canonicalStyle,
    },
  });
}
