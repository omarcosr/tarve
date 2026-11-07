import type { VNode } from "../jsx-runtime";
import type { ScrollInfo, ScrollOrientation, ScrollPosition } from "../protocol";
import { theme } from "../theme";
import { container, type ViewProps } from "./layout";

export interface ScrollProps extends ViewProps {
  speed?: number;
  orientation?: ScrollOrientation;
  onScroll?: (offset: number, max: number, info: ScrollInfo) => void;
  onScrollPosition?: (position: ScrollPosition) => void;
  /**
   * Stick to the end: while the area is at its end (or new), growing content keeps it there (a
   * chat, a log). Scrolling away stops it; scrolling back to the end resumes it.
   */
  followTail?: boolean;
}

export function Scroll({ speed = 1, orientation = "vertical", followTail, ...props }: ScrollProps): VNode {
  if (!Number.isFinite(speed) || speed <= 0) throw new RangeError("Scroll speed must be finite and greater than zero");
  if (!["vertical", "horizontal", "both"].includes(orientation)) throw new TypeError(`Unsupported Scroll orientation: ${orientation}`);
  const nativeProps = { ...props, scrollSpeed: speed, scrollOrientation: orientation, ...(followTail ? { followTail: true } : {}) };
  return container("scroll", nativeProps, {
    minHeight: 0,
    shrink: 1,
    scrollbarColor: theme.colors.scrollbar,
  });
}

export const ScrollArea = Scroll;
export type ScrollAreaProps = ScrollProps;
