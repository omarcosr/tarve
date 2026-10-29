import type { Style } from "../protocol";
import { jsx, type BaseProps, type DropTargetProps, type FileDropTargetProps, type VNode } from "../jsx-runtime";

export interface ViewProps extends BaseProps, DropTargetProps, FileDropTargetProps {
  gap?: number;
  padding?: Style["padding"];
  /** CSS `flex`: `1` is `1 1 0`; strings take any CSS value, e.g. `"1 1 176px"`. */
  flex?: number | string;
  align?: Style["align"];
  justify?: Style["justify"];
  portal?: boolean;
  /**
   * A press outside the box fires `onOutsideClick` instead of reaching what is under it
   * (light dismiss). Works on portals and in-flow boxes; an open portal wins.
   */
  dismissOnOutside?: boolean;
  /** With `dismissOnOutside`: a press (or right click) outside the box. */
  onOutsideClick?: () => void;
  dragRegion?: boolean;
  windowAction?: "minimize" | "toggleMaximize" | "toggleFullscreen" | "close";
  focusable?: boolean;
}

/** Internal helper shared by the primitive container components. */
export function container(kind: string, props: ViewProps, defaults: Style = {}): VNode {
  const { gap, padding, flex, align, justify, style, ...rest } = props;
  // Assignments, not Object.entries/filter/fromEntries: this runs for every row and column.
  const merged: Style = { ...defaults };
  if (gap !== undefined) merged.gap = gap;
  if (padding !== undefined) merged.padding = padding;
  if (flex !== undefined) merged.flex = flex;
  if (align !== undefined) merged.align = align;
  if (justify !== undefined) merged.justify = justify;
  return jsx(kind, { ...rest, style: style ? { ...merged, ...style } : merged });
}

export function View(props: ViewProps): VNode {
  return container("view", props);
}

export function Row(props: ViewProps): VNode {
  return container("row", props, { direction: "row", align: "center" });
}

export function Column(props: ViewProps): VNode {
  return container("column", props, { direction: "column" });
}

export type PortalProps = ViewProps;

export function Portal(props: PortalProps): VNode {
  return container("view", { ...props, portal: true });
}
