import type { WindowPosition } from "../../../protocol/src/index";
import type { VNode } from "../jsx-runtime";
import { theme, type ThemeDefinition } from "../theme";
import { container, type ViewProps } from "./layout";

export interface WindowProps extends ViewProps {
  title?: string;
  width?: number;
  height?: number;
  minWidth?: number;
  minHeight?: number;
  resizable?: boolean;
  position?: WindowPosition;
  theme?: ThemeDefinition;
  onCloseRequest?: (event: WindowCloseRequestEvent) => void;
}

export interface WindowCloseRequestEvent {
  readonly defaultPrevented: boolean;
  preventDefault(): void;
}

export function Window(props: WindowProps): VNode {
  return container("window", {
    ...props,
    style: { background: theme.colors.background, ...props.style },
  });
}
