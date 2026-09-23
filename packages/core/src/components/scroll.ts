import type { VNode } from "../jsx-runtime";
import type { ScrollOrientation, ScrollPosition } from "../../../protocol/src/index";
import { theme } from "../theme";
import { container, type ViewProps } from "./layout";

export interface ScrollProps extends ViewProps {
  speed?: number;
  orientation?: ScrollOrientation;
  onScroll?: (offset: number, max: number) => void;
  onScrollPosition?: (position: ScrollPosition) => void;
}

export function Scroll({ speed = 1, orientation = "vertical", ...props }: ScrollProps): VNode {
  if (!Number.isFinite(speed) || speed <= 0) throw new RangeError("Scroll speed must be finite and greater than zero");
  if (!["vertical", "horizontal", "both"].includes(orientation)) throw new TypeError(`Unsupported Scroll orientation: ${orientation}`);
  const nativeProps = { ...props, scrollSpeed: speed, scrollOrientation: orientation };
  return container("scroll", nativeProps, {
    minHeight: 0,
    shrink: 1,
    scrollbarColor: theme.colors.scrollbar,
  });
}

export const ScrollArea = Scroll;
export type ScrollAreaProps = ScrollProps;
