import type { Style } from "../../../protocol/src/index";
import { jsx, type BaseProps, type DropTargetProps, type VNode } from "../jsx-runtime";

export interface ViewProps extends BaseProps, DropTargetProps {
  gap?: number;
  padding?: Style["padding"];
  flex?: number;
  align?: Style["align"];
  justify?: Style["justify"];
  portal?: boolean;
  dismissOnOutside?: boolean;
  onOutsideClick?: () => void;
  dragRegion?: boolean;
  windowAction?: "minimize" | "toggleMaximize" | "close";
  focusable?: boolean;
}

/** Internal helper shared by the primitive container components. */
export function container(kind: string, props: ViewProps, defaults: Style = {}): VNode {
  const { gap, padding, flex, align, justify, style, ...rest } = props;
  const overrides = Object.fromEntries(
    Object.entries({ gap, padding, flex, align, justify }).filter(([, value]) => value !== undefined),
  );
  return jsx(kind, { ...rest, style: { ...defaults, ...overrides, ...style } });
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
