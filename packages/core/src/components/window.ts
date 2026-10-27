import type { DesktopWidget, WindowBackdrop, WindowLevel, WindowPosition } from "../protocol";
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
  /** Opens maximized; `width`/`height`/`position` are the bounds it restores to. A remembered window state wins. */
  maximized?: boolean;
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
  /**
   * See through the window: `transparent` shows the desktop and windows behind it,
   * `blur` blurs them (Acrylic on Windows, the system blur on macOS and KDE), `mica`
   * and `acrylic` are the Windows 11 materials (`blur` elsewhere). The window
   * background defaults to transparent; give it (or any box) an alpha colour to tint.
   * Set when the window opens. Where the system or renderer has no alpha (Vello/DX12 on
   * Windows, X11 without a compositor, the CPU renderer on Wayland and macOS) the window
   * is opaque, its background drawn without alpha. Mica tints the desktop wallpaper, not
   * the windows behind; `blur` and `acrylic` blur those. As for the system's own
   * windows, Mica and Acrylic turn solid while the window is inactive (`blur` stays), and
   * all three are solid while Windows "Transparency effects" is off
   * (`app.inspect().transparencyEffects`; `app.onEvent` gets a `transparencyEffects` event
   * when it changes). The material is light or dark after the window background's
   * lightness (the app theme), not the system theme.
   */
  backdrop?: WindowBackdrop;
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
    // A see-through window starts clear, in the theme's background colour: where alpha cannot
    // reach the compositor, the renderer paints it opaque.
    style: { background: props.backdrop && props.backdrop !== "none" ? `${theme.colors.background}/0` : theme.colors.background, ...props.style },
  });
}
