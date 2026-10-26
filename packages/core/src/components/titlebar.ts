import type { Style } from "../protocol";
import { jsx, type Child, type VNode } from "../jsx-runtime";
import { theme } from "../theme";
import { Icon } from "./icon";
import type { SvgNode } from "./svg";
import { container, Row, type ViewProps } from "./layout";
import { Pressable } from "./pressable";
import { Text } from "./text";
import { glassSurface, type GlassVariant } from "./glass";

export interface TitleBarProps extends ViewProps {
  title?: string;
  height?: number;
  showMinimize?: boolean;
  showMaximize?: boolean;
  showClose?: boolean;
  /** Style merged into each window control (minimize, maximize, close): size, radius, colours. */
  buttonStyle?: Style;
  /**
   * Liquid Glass bar: `true` for the `regular` material, or a variant. Its controls go
   * round. Edge to edge (no `radius` in `style`) it keeps only a hairline along its bottom;
   * with a `radius` it is a floating capsule with the full rim and shadow. Lay it over
   * content (`position: "absolute"`) for the backdrop to show through, as the window
   * background alone is only the veil.
   */
  glass?: boolean | GlassVariant;
  /** Light or dark glass; sets the ink of the title and controls. Default `light`. */
  appearance?: "light" | "dark";
  /** Before the title: a menu button, an avatar. Replaces the back button `onBack` draws. */
  leading?: Child;
  /** After the title (before the window controls on desktop): icon buttons, a search field. */
  actions?: Child;
  /** Draws a back arrow before the title that calls this: the usual top bar of a pushed screen. */
  onBack?: () => void;
}

/** `#rgb`/`#rrggbb` at `alpha` (0–255); other colors are returned unchanged. */
function translucent(color: string, alpha: number): string {
  const hex = color.trim().replace(/^#/, "");
  const full = hex.length === 3 ? [...hex].map(c => c + c).join("") : hex.slice(0, 6);
  return /^[0-9a-f]{6}$/i.test(full) ? `#${full}${Math.round(alpha).toString(16).padStart(2, "0")}` : color;
}

function titleBarButton(action: "minimize" | "toggleMaximize" | "close", child: Child, ink: string, buttonStyle: Style | undefined): VNode {
  const close = action === "close";
  const label = action === "minimize" ? "Minimize window" : action === "toggleMaximize" ? "Maximize or restore window" : "Close window";
  return jsx(Pressable, {
    windowAction: action,
    control: { role: "button", label },
    focusable: false,
    style: {
      width: 46,
      height: "100%",
      radius: 0,
      align: "center",
      justify: "center",
      background: "#00000000",
      // Over whatever the bar is painted with: a wash of its own ink, not a theme surface.
      hover: { background: close ? theme.colors.windowCloseHover : translucent(ink, 0x1f) },
      active: { background: close ? theme.colors.windowCloseActive : translucent(ink, 0x33) },
      ...buttonStyle,
    },
    children: child,
  });
}

/** Android has no window to minimize, maximize or close: TitleBar is the app's top bar there. */
const MOBILE = typeof process !== "undefined" && (process.platform as string) === "android";

export function TitleBar({
  title,
  height = MOBILE ? 56 : 40,
  showMinimize = !MOBILE,
  showMaximize = !MOBILE,
  showClose = !MOBILE,
  buttonStyle,
  glass,
  appearance = "light",
  leading,
  actions,
  onBack,
  children,
  style,
  ...props
}: TitleBarProps): VNode {
  const radius = typeof style?.radius === "number" ? style.radius
    : typeof style?.radius === "object" ? Math.max(style.radius.topLeft ?? 0, style.radius.topRight ?? 0) : 0;
  const surface: Style | undefined = glass
    ? {
        ...glassSurface(glass === true ? "regular" : glass, appearance, { radius, shadow: radius > 0 }),
        ...(radius > 0 ? { overflow: "hidden" } : { borderWidth: { bottom: 1 } }),
        foreground: appearance === "dark" ? "#ffffff" : "#1c1c1e",
      }
    : undefined;
  const controlStyle: Style | undefined = glass ? { width: 36, height: 36, radius: 18, ...buttonStyle } : buttonStyle;
  // The controls draw in the bar's foreground, so a dark bar on a light theme
  // (or the reverse) still shows them.
  const ink = typeof style?.foreground === "string" ? style.foreground : typeof surface?.foreground === "string" ? surface.foreground : theme.colors.foreground;
  // Stroked glyphs (one logical pixel at 12px), so all three get the same
  // antialiased weight at any scale; a 1px View border lands between device
  // pixels at 125% and draws two edges faint and two solid.
  const glyph = (iconNode: SvgNode[]) => jsx(Icon, { iconNode, size: 12, strokeWidth: 2, color: ink });
  const minimizeIcon = glyph([["path", { d: "M3 12h18" }]]);
  const maximizeIcon = glyph([["rect", { x: 3, y: 3, width: 18, height: 18, rx: 2 }]]);
  const closeIcon = glyph([["path", { d: "M4 4l16 16M20 4 4 20" }]]);
  const controls = jsx(Row, {
    style: { height: "100%", shrink: 0 },
    children: [
      showMinimize ? titleBarButton("minimize", minimizeIcon, ink, controlStyle) : null,
      showMaximize ? titleBarButton("toggleMaximize", maximizeIcon, ink, controlStyle) : null,
      showClose ? titleBarButton("close", closeIcon, ink, controlStyle) : null,
    ],
  });
  const content = children ?? (title ? jsx(Text, { size: MOBILE ? 18 : 13, weight: glass || MOBILE ? 600 : 500, color: glass ? ink : undefined, children: title }) : null);
  // A 48 dp touch target on a phone, a compact square on desktop.
  const target = MOBILE ? 48 : 32;
  const back = leading ?? (onBack ? jsx(Pressable, {
    onClick: onBack,
    control: { role: "button", label: "Back" },
    style: {
      width: target, height: target, radius: target / 2, align: "center", justify: "center", shrink: 0,
      background: "#00000000",
      hover: { background: translucent(ink, 0x1f) },
      active: { background: translucent(ink, 0x33) },
    },
    children: jsx(Icon, { iconNode: [["path", { d: "M19 12H5M12 19l-7-7 7-7" }]], size: MOBILE ? 24 : 16, strokeWidth: 2, color: ink }),
  }) : null);
  const start = back
    ? jsx(Row, { style: { grow: 1, shrink: 1, align: "center", gap: MOBILE ? 8 : 6, height: "100%" }, children: [back, content] })
    : content;
  const end = actions ? jsx(Row, { style: { height: "100%", shrink: 0, align: "center", gap: MOBILE ? 4 : 2 }, children: [actions, controls] }) : controls;
  return container("titlebar", {
    ...props,
    // No window to move on a phone: the bar is plain layout there.
    dragRegion: !MOBILE,
    style: {
      direction: "row",
      height,
      shrink: 0,
      // A back button sits 4 dp from the edge (its own 48 dp circle supplies the rest).
      padding: { left: MOBILE ? (back ? 4 : 16) : back ? 6 : 12, right: MOBILE && actions ? 4 : 0 },
      background: theme.colors.card,
      borderWidth: { bottom: 1 },
      borderColor: theme.colors.border,
      justify: "between",
      align: "center",
      pointerEvents: "block",
      ...(glass ? { gap: 4, padding: { left: 14, right: 4 } } : {}),
      ...surface,
      ...style,
    },
    children: [start, end],
  });
}
