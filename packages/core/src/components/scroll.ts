import type { VNode } from "../jsx-runtime";
import { theme } from "../theme";
import { container, type ViewProps } from "./layout";

export interface ScrollProps extends ViewProps {
  speed?: number;
  onScroll?: (offset: number, max: number) => void;
}

export function Scroll({ speed = 1, ...props }: ScrollProps): VNode {
  if (!Number.isFinite(speed) || speed <= 0) throw new RangeError("Scroll speed must be finite and greater than zero");
  const nativeProps = { ...props, scrollSpeed: speed };
  return container("scroll", nativeProps, {
    minHeight: 0,
    shrink: 1,
    scrollbarColor: theme.colors.scrollbar,
  });
}
