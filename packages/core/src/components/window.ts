import type { DesktopWidget, WindowLevel, WindowPosition } from "../protocol";
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
  /**
   * Stacking order; `alwaysOnBottom` keeps the window under every other one, even
   * when clicked or shown. Can change while the app runs.
   */
  level?: WindowLevel;
  /** Keep the window off the taskbar and out of Alt+Tab (Windows) or the task switcher and pager (Linux, X11). */
  skipTaskbar?: boolean;
  /** No native frame or title bar, without needing a `TitleBar`. Pair with a `dragRegion` to move it. */
  frameless?: boolean;
  /**
   * Make the window a desktop widget, `columns` × `rows` cells: frameless, below
   * every window (unless `level` says otherwise) and off the taskbar.
   * Windows: sized to the desktop icon grid; when dragged (give it a
   * `dragRegion`) it drops into the nearest cells free of icons, and icons that
   * land under it are moved out.
   * Linux (X11; XWayland on a Wayland session): cells of a typical icon,
   * 80 × 100, on every workspace; no icon grid to follow.
   * `width`/`height` are ignored; `position` is where it first looks for room.
   */
  desktopWidget?: DesktopWidget;
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
