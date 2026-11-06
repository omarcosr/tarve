import { jsx, type BaseProps, type BindableChild, type IntrinsicStyle, type Reactive, type VNode } from "../jsx-runtime";
import { canonicalizeIntrinsicStyle } from "../intrinsic-style";
import { markPure } from "../memo";

export interface TextProps extends Omit<BaseProps, "style" | "children"> {
  size?: number;
  weight?: number;
  color?: string;
  style?: Reactive<IntrinsicStyle>;
  children?: BindableChild;
}

export function Text({ size, weight, color, style, ...props }: TextProps): VNode {
  // Signal values pass through untouched: the reconciler binds them.
  const canonicalStyle = canonicalizeIntrinsicStyle(style as IntrinsicStyle | undefined);
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
// Its output is its props (see markPure).
markPure(Text);
