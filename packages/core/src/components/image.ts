import { jsx, type BaseProps, type VNode } from "../jsx-runtime";
import { theme } from "../theme";

export interface ImageProps extends BaseProps {
  src: string;
  width?: number;
  height?: number;
  fit?: "cover" | "contain";
}

export function Image({ width, height, style, ...props }: ImageProps): VNode {
  return jsx("image", {
    ...props,
    style: {
      width,
      height,
      radius: theme.radius.md,
      placeholderBackground: theme.colors.imagePlaceholder,
      ...style,
    },
  });
}
