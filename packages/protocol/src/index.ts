/** Renderer-independent, versioned messages crossing the C ABI as UTF-8 JSON. */
export const NATIVE_ABI_VERSION = 6;
export const PROTOCOL_VERSION = 62;
export * from "./values";
import type { Length, NodeKind, Insets, Margins, CornerRadius, OutlineStyle, BorderStyle, TextShadow, Transform, BoxShadow, Gradient, UserSelect, TextDecoration, SyntaxTheme, TextHighlight } from "./values";
export type Renderer = "auto" | "gpu" | "cpu";
/** Numeric properties: usable in `motionFrom` and AnimatePresence enter/exit values. */
export type NumericMotionProperty = "width" | "height" | "top" | "right" | "bottom" | "left" | "opacity" | "radius";
/** Colour and shadow properties also transition on hover/active/focus/disabled changes. */
export type MotionProperty = NumericMotionProperty | "background" | "foreground" | "borderColor" | "boxShadow" | "textShadow" | "transform";
export type MotionEasing = "linear" | "ease" | "easeIn" | "easeOut" | "easeInOut";
export interface MotionTransition {
  /** Duration in milliseconds. Defaults to 200 when omitted. */
  duration?: number;
  /** Delay in milliseconds. Defaults to 0. */
  delay?: number;
  easing?: MotionEasing;
}
/** Values an animation moves between: numbers, colours/gradients, shadows and a transform. */
export type AnimationValues = MotionValues & Pick<StateStyle, "background" | "foreground" | "borderColor" | "boxShadow" | "textShadow">;
/**
 * CSS `animation` over two keyframes. `from` names the animated properties; `to` defaults to the
 * style's own value for each. `iterations` (1 by default) may be `"infinite"`; `direction:
 * "alternate"` plays every other run backwards. A changed animation starts over, an unchanged one
 * runs on through re-renders, removing it stops it (the style's own values show again).
 */
export interface StyleAnimation {
  from: AnimationValues;
  to?: AnimationValues;
  /** One run, in milliseconds (1000 by default). */
  duration?: number;
  delay?: number;
  easing?: MotionEasing;
  iterations?: number | "infinite";
  direction?: "normal" | "alternate";
}
export type MotionTransitions = Partial<Record<MotionProperty | "all", MotionTransition>>;
/** Starting (`motionFrom`, `enter`) or ending (`exit`) values: numbers, and a `transform` (object or CSS string). */
export type MotionValues = Partial<Record<NumericMotionProperty, number>> & { transform?: Transform | string };
/**
 * Liquid-glass material: what is behind the box shows through blurred and bent at the
 * edges, under the box's `background` colour as a tint. Every renderer paints it
 * (D3D11, Vello and the CPU renderer); with only `blur` it is a plain backdrop blur.
 */
export interface GlassMaterial {
  /** Blur radius in px of what is behind the box (CSS `backdrop-filter: blur()`), 0–64. */
  blur: number;
  /** Colour saturation of the blurred backdrop; 1 leaves it, iOS uses about 1.6. */
  saturate?: number;
  /** How far in px the backdrop bends along the rounded edge (the lens), 0 for none. */
  refraction?: number;
  /** Brightness 0–1 of the rim, the edge reflections and the sheen. */
  highlight?: number;
  /** How much the flat part enlarges the backdrop, as a thick lens does: 0–0.3 (0.06 is iOS-like). */
  magnify?: number;
  /**
   * Boxes painted in one frame with the same key fuse like drops of liquid: their
   * shapes join smoothly where they come within `blend` px of each other.
   */
  merge?: string;
  /** How far apart in px two merged boxes start bridging. Default 0 (touching). */
  blend?: number;
}
export interface StateStyle {
  /** Liquid-glass material behind the box; `background` is its tint. */
  glass?: GlassMaterial;
  /** CSS `backdrop-filter: blur(n)`: what lies behind the box, blurred (a glass without lens or rim). */
  backdropBlur?: number;
  /** CSS `backdrop-filter` with `blur()` and `saturate()`. */
  backdropFilter?: string;
  /**
   * CSS `filter`: `"blur(12px)"`, `"drop-shadow(0 2px 6px #0008)"` or both, or the object form. A solid
   * childless box blurs as it paints; anything else (children, text, images, an icon's shadow)
   * is rasterized on the CPU through the filter and drawn as an image.
   */
  filter?: string | { blur?: number; dropShadow?: { x: number; y: number; blur?: number; color: string } };
  /**
   * CSS `mask-image` with a gradient (`"linear-gradient(to bottom, black 60%, transparent)"`):
   * the box and its content keep the gradient's alpha and nothing outside the box. The D3D11
   * renderer applies a linear gradient's first-to-last stop ramp (radial masks: Vello and CPU).
   */
  maskImage?: string | Gradient;
  /** CSS multiple backgrounds over `background`, the first on top. A comma list of gradients in `background` does the same. */
  backgroundLayers?: (string | Gradient)[];
  /** Colour, gradient object, or CSS `linear-gradient(…)` / `radial-gradient(…)` string. */
  background?: string | Gradient; foreground?: string | Gradient; borderColor?: string | Gradient; borderStyle?: BorderStyle; radius?: CornerRadius;
  opacity?: number;
  outlineWidth?: number; outlineColor?: string; outlineOffset?: number; outlineRadius?: number; outlineStyle?: OutlineStyle;
  placeholderColor?: string; selectionColor?: string; caretColor?: string;
  scrollbarColor?: string; placeholderBackground?: string; thumbColor?: string;
  textDecoration?: TextDecoration;
  /** Text, button, Input and TextArea text. Offset copy, optionally blurred. */
  /** Object form, or CSS text-shadow syntax such as "1px 2px 4px #0006". */
  textShadow?: TextShadow | string;
  /** One shadow or up to 8; the first paints on top. Does not affect layout. */
  boxShadow?: BoxShadow | readonly BoxShadow[] | string;
  /** Object form, or CSS syntax such as "translateY(-2px) scale(1.02)" (translate/scale only). */
  transform?: Transform | string;
}
export interface Style extends StateStyle {
  width?: Length; height?: Length; minWidth?: Length; minHeight?: Length;
  maxWidth?: Length; maxHeight?: Length;
  /**
   * CSS `flex`: a number is the shorthand `N 1 0` (`flex: 1`), a string any CSS value
   * (`"1 1 176px"`, `"auto"`, `"none"`). Like CSS, items don't shrink below their content
   * unless `minWidth`/`minHeight` is 0.
   */
  flex?: number | string; grow?: number; basis?: Length | "auto"; shrink?: number; aspectRatio?: number;
  position?: "relative" | "absolute"; top?: Length; right?: Length; bottom?: Length; left?: Length;
  direction?: "row" | "row-reverse" | "column" | "column-reverse"; wrap?: boolean; gap?: number;
  /** CSS `row-gap` / `column-gap`; each falls back to `gap`. */
  rowGap?: number; columnGap?: number;
  padding?: Insets; margin?: Margins; align?: "start" | "center" | "end" | "stretch" | "baseline";
  /** CSS `justify-content`: `around` and `evenly` are `space-around` / `space-evenly`. */
  justify?: "start" | "center" | "end" | "between" | "around" | "evenly" | "stretch";
  /** CSS `align-self`, `align-content`, `justify-items`, `justify-self`. */
  alignSelf?: "start" | "center" | "end" | "stretch" | "baseline";
  alignContent?: "start" | "center" | "end" | "stretch" | "between" | "around" | "evenly";
  justifyItems?: "start" | "center" | "end" | "stretch";
  justifySelf?: "start" | "center" | "end" | "stretch";
  /** `block` stacks children and collapses adjacent vertical margins, as CSS block flow does. */
  display?: "flex" | "grid" | "block" | "none";
  /** Grid tracks: a count of equal columns, or a CSS track list such as `"repeat(auto-fill, minmax(176px, 1fr))"`. */
  columns?: number | string;
  /** CSS `grid-column` / `grid-row` placement: `"span 2"`, `2`, `"1 / 3"`. */
  gridColumn?: number | string; gridRow?: number | string;
  /** CSS `cursor` keyword; inherited by descendants. `none` hides the pointer over the box. */
  cursor?: "auto" | "none" | "default" | "pointer" | "text" | "vertical-text" | "move" | "grab" | "grabbing" | "not-allowed" | "no-drop" | "wait" | "progress" | "help" | "crosshair" | "copy" | "alias" | "context-menu" | "cell" | "zoom-in" | "zoom-out" | "col-resize" | "row-resize" | "ew-resize" | "ns-resize" | "nesw-resize" | "nwse-resize" | "all-scroll";
  /** Grid row tracks as a CSS track list (`"auto 1fr"`); rows are implicit when omitted. */
  rows?: number | string;
  zIndex?: number;
  /**
   * CSS `position-try-fallbacks` for a `portal` root: `"none"` or a comma-separated list of options,
   * each `flip-block` and/or `flip-inline`. When the box doesn't fit the window, the first option that
   * fits mirrors it across its containing block (above ↔ below, left ↔ right); none fitting keeps it as laid out.
   * On the first child of a portal instead, that child's box is fitted and mirrored and the portal moves with it
   * (a wider positioning lane around a tooltip).
   */
  positionTryFallbacks?: string;
  borderWidth?: Insets;
  radius?: CornerRadius; fontSize?: number; fontWeight?: number; fontFamily?: string;
  /** Native retained transitions. Bun sends the target once; Rust owns interpolation. */
  transition?: MotionTransitions;
  /** Continuous rotation about the centre, one turn per `spin` milliseconds. Rust drives the frames. */
  spin?: number;
  /** CSS `animation` with `@keyframes { from {…} to {…} }`: looped shimmer, pulse, slow zoom. Rust drives the frames. */
  animation?: StyleAnimation;
  /** CSS text: `font-style`, `letter-spacing`, `word-spacing`, `text-transform`, `white-space`, `text-overflow` and `line-clamp`. */
  fontStyle?: "normal" | "italic" | "oblique"; letterSpacing?: number; wordSpacing?: number;
  /** Width of a tab in spaces (CSS `tab-size`); default 8. */
  tabSize?: number;
  /** CSS `font-variant-numeric` (e.g. `"tabular-nums"`, `"slashed-zero"`) and `font-feature-settings` (`'"ss01" 1, "cv11" 1'`). Inherited. */
  fontVariantNumeric?: string; fontFeatureSettings?: string;
  /** CSS `scrollbar-width` on scroll boxes and text areas: `none` hides the bar (still scrollable), `thin` narrows it. */
  scrollbarWidth?: "auto" | "thin" | "none";
  textTransform?: "none" | "uppercase" | "lowercase" | "capitalize";
  whiteSpace?: "normal" | "nowrap" | "pre" | "pre-wrap" | "pre-line";
  textOverflow?: "clip" | "ellipsis"; lineClamp?: number;
  /** CSS `transform: matrix(a, b, c, d, e, f)` with `transform-origin: 0 0`, inside `transform`. */
  transformMatrix?: [number, number, number, number, number, number];
  /** CSS `clip-path: path([nonzero | evenodd,] "<svg path>")` in the box's coordinates. */
  clipPath?: string;
  /** CSS `text-decoration-style`. */
  textDecorationStyle?: "solid" | "double" | "dotted" | "dashed" | "wavy";
  /** CSS `overflow`: `hidden`/`clip` clip children to the box and let it shrink below its content. */
  overflow?: "visible" | "hidden" | "clip";
  /** Line height as a multiple of the font size (CSS unitless `line-height`), not px. */
  lineHeight?: number; textAlign?: "start" | "center" | "end" | "justify";
  taskMarkerColor?: string; taskMarkerCheckColor?: string;
  markdownCodeBackground?: string; markdownQuoteBackground?: string; markdownQuoteAccent?: string;
  markdownTableHeaderBackground?: string; markdownTableRule?: string;
  /** Markdown surfaces. Each colour falls back to the active theme when unset. */
  markdownCodeColor?: string; markdownQuoteColor?: string;
  markdownLinkColor?: string; markdownInlineCodeColor?: string; markdownMutedColor?: string;
  /** Diff row colours. Omit a background key to paint no layer at all. */
  diffHeaderBackground?: string; diffHeaderForeground?: string;
  diffNoticeBackground?: string; diffNoticeForeground?: string;
  diffHunkBackground?: string; diffHunkForeground?: string;
  diffAddedBackground?: string; diffAddedEmphasisBackground?: string; diffAddedForeground?: string; diffAddedAccent?: string;
  diffRemovedBackground?: string; diffRemovedEmphasisBackground?: string; diffRemovedForeground?: string; diffRemovedAccent?: string;
  /** Line-number gutter colour, for `diff` and for `code`. */
  diffGutterColor?: string; gutterColor?: string;
  hover?: StateStyle; focus?: StateStyle; focusVisible?: StateStyle; active?: StateStyle; disabled?: StateStyle;
  /** Marks a `group`: descendants' `groupHover` applies while this box is hovered (Tailwind's `group`). */
  group?: boolean;
  /** Applied while an ancestor marked `group` is hovered (`group-hover:`). */
  groupHover?: StateStyle;
  /** Applied while this box or a descendant has focus (CSS `:focus-within`). */
  focusWithin?: StateStyle;
  /**
   * Position among the parent's element children: `first`, `last`, `odd`, `even` (1-based, as CSS
   * `:nth-child`). Folded by the reconciler; the native tree never sees these keys.
   */
  first?: Omit<Style, "dark">; last?: Omit<Style, "dark">; odd?: Omit<Style, "dark">; even?: Omit<Style, "dark">;
  /**
   * Window-width breakpoints (Tailwind's: 640, 768, 1024, 1280, 1536 CSS px, min-width), folded by the
   * reconciler against the window's current size; the app re-renders when the width crosses one.
   */
  sm?: Omit<Style, "dark">; md?: Omit<Style, "dark">; lg?: Omit<Style, "dark">; xl?: Omit<Style, "dark">; "2xl"?: Omit<Style, "dark">;
  /** The window's shape (height above width is `portrait`), as CSS `orientation`; folded by the reconciler. */
  portrait?: Omit<Style, "dark">; landscape?: Omit<Style, "dark">;
  /** A finger (`coarse`, Android) or a mouse (`fine`), as CSS `pointer`: `pointerCoarse: { minHeight: 48 }` grows touch targets. */
  pointerCoarse?: Omit<Style, "dark">; pointerFine?: Omit<Style, "dark">;
  /** The system asks for no animation (`motionReduce`) or allows it (`motionSafe`), as CSS `prefers-reduced-motion`. */
  motionReduce?: Omit<Style, "dark">; motionSafe?: Omit<Style, "dark">;
  /**
   * Overrides applied when the window theme is dark (its background luminance below 0.5),
   * like Tailwind's `dark:`. The reconciler folds them in; the native tree never sees the key.
   */
  dark?: Omit<Style, "dark">;
  /** `none` lets the pointer fall through this box and its children, as CSS `pointer-events: none`. */
  strokeWidth?: number; pointerEvents?: "auto" | "block" | "delegate" | "none"; userSelect?: UserSelect;
}
export interface Control {
  role: "button" | "link" | "checkbox" | "switch" | "radio" | "radiogroup" | "tab" | "tablist" | "navigation" | "menuitem" | "tree" | "treeitem" | "grid" | "row" | "toggle" | "togglegroup" | "slider" | "progress" | "virtualList" | "select" | "group" | "field" | "alert" | "status" | "label" | "option" | "otpSlot";
  label?: string; checked?: boolean; selected?: boolean; expanded?: boolean; group?: string;
  orientation?: "horizontal" | "vertical";
  value?: number; min?: number; max?: number; step?: number;
  required?: boolean;
  description?: string;
  sortDirection?: "ascending" | "descending" | "other";
}
export interface VirtualListLayout {
  estimatedItemHeight: number;
  itemCount: number;
  windowStart: number;
  windowEnd: number;
  renderedKeys: string[];
  retainedKey?: string;
  alignment: "top" | "bottom";
  followTail: boolean;
  scrollRequest?: { generation: number; offset: number; smooth?: boolean };
}
export interface VirtualListMeasurement { key: string; height: number }
export interface VirtualListAnchor { index: number; key: string; offset: number }
export type NativeImageSource =
  | { kind: "encoded"; key: string; data: string; mediaType?: string }
  | { kind: "rgba"; key: string; data: string; width: number; height: number; premultiplied?: boolean };
/** A styled range of a text node, in UTF-8 byte offsets; `id` makes it a click target. */
export interface TextRun {
  start: number; end: number; id?: string;
  /** Run overrides; `textDecoration` may combine lines ("underline line-through") as in CSS. */
  style: Partial<Omit<Style, "textDecoration">> & {
    textDecoration?: string;
    /** CSS `vertical-align: super | sub`: baseline shift in px, up. */
    baselineShift?: number;
  };
}
export interface NativeNode {
  id: string; kind: NodeKind; style: Style; children: NativeNode[];
  text?: string; runs?: TextRun[]; source?: string; language?: string; path?: string; oldText?: string; newText?: string;
  showLineNumbers?: boolean; syntaxTheme?: Partial<SyntaxTheme>;
  wordDiff?: boolean; collapsedPaths?: string[]; maxLines?: number;
  highlight?: TextHighlight;
  src?: string; image?: NativeImageSource; fit?: "cover" | "contain"; disabled?: boolean;
  svg?: string;
  value?: string; placeholder?: string;
  inputType?: "text" | "password" | "email" | "number" | "search" | "tel" | "url";
  submitOnEnter?: boolean;
  scrollSpeed?: number;
  scrollOrientation?: ScrollOrientation;
  virtualList?: VirtualListLayout;
  control?: Control | null;
  modal?: boolean; focusable?: boolean;
  rovingGroup?: string;
  portal?: boolean;
  dismissOnOutside?: boolean;
  labelledBy?: string[];
  closeIntercept?: boolean;
  dragRegion?: boolean;
  /** Interactive nodes only: a press past 4px becomes a pointer drag. */
  draggable?: boolean;
  dropTarget?: boolean;
  /** Takes files dragged in from the system (`onFileDrop`). */
  fileDropTarget?: boolean;
  /** Native sends a `size` event with the content-box size on first layout and on every change. */
  reportSize?: boolean;
  /** Emit `longPress` when a press is held still for 500 ms; that press's release does not click. */
  longPress?: boolean;
  /** Emit `pinch` events for two-finger pinches over this node. */
  pinch?: boolean;
  /** Native sends `pointerMove` events with the pointer's position inside the node while it is over it. */
  reportPointer?: boolean;
  windowAction?: "minimize" | "toggleMaximize" | "toggleFullscreen" | "close";
  /** Optional initial numeric values used only when the native node is first mounted. */
  motionFrom?: MotionValues;
}
export type ScrollOrientation = "vertical" | "horizontal" | "both";
/**
 * What moved a scroll container: input (wheel, scrollbar, keyboard, assistive
 * technology), the app (scrollToItem, including each step of a smooth one), or
 * layout (rows above the anchor changed height).
 */
export type ScrollSource = "user" | "program" | "layout";
export interface ScrollInfo { source: ScrollSource }
export interface ScrollPosition { x: number; y: number; maxX: number; maxY: number; source: ScrollSource }
export type WindowPositionPreset =
  | "top-left" | "top" | "top-right"
  | "left" | "center" | "right"
  | "bottom-left" | "bottom" | "bottom-right";
/** Logical px, or physical screen px with `physical` (a remembered position). */
export type WindowPosition = WindowPositionPreset | { x: number; y: number; physical?: boolean };
export interface WindowOptions {
  title: string; width: number; height: number; minWidth: number; minHeight: number;
  background: string; decorations: boolean; resizable: boolean; position?: WindowPosition; debug?: boolean;
  /** Test/runtime option: keep the native desktop window hidden. */
  visible?: boolean;
  level?: WindowLevel;
  /** No taskbar button or task switcher entry (Windows; Linux on X11). */
  skipTaskbar?: boolean;
  /** A desktop widget `columns` × `rows` cells (the icon grid on Windows; 80 × 100 cells on Linux). */
  desktopWidget?: DesktopWidget;
  /** What shows through where the window is translucent; omitted for an opaque window. */
  backdrop?: WindowBackdrop;
  /** Opens maximized; `width`/`height`/`position` are then the bounds it restores to. */
  maximized?: boolean;
  /** Report the restored bounds and maximized state as `windowState` events. */
  reportWindowState?: boolean;
}
/**
 * What a window shows behind its translucent pixels (its background and anything drawn with alpha):
 * `transparent` the desktop and windows behind as they are; `blur` them blurred by the system
 * (the Windows accent blur, macOS, KDE on Linux); `mica` (the wallpaper, tinted) and `acrylic` the
 * Windows 11 materials, solid while the window is inactive (blur on other systems and Windows 10).
 * Opaque where the compositor or renderer has no alpha; on Windows mica, acrylic and blur are solid
 * while "Transparency effects" is off.
 */
export type WindowBackdrop = "none" | "transparent" | "blur" | "mica" | "acrylic";
export interface DesktopWidget { columns: number; rows: number }
/** Stacking: `alwaysOnBottom` keeps the window under every other one, like a desktop widget. */
export type WindowLevel = "normal" | "alwaysOnTop" | "alwaysOnBottom";
export type TextRendering = "grayscale" | "cleartype";
export interface SceneDocument {
  version: number; renderer: Renderer; window: WindowOptions; root: NativeNode;
  /** D3D11 MSAA samples: 0 (default) uses a coverage fringe instead; 2, 4 or 8. */
  msaa?: number;
  /** D3D11 text: "grayscale" (default) or "cleartype" (DirectWrite subpixel glyphs on opaque windows). */
  textRendering?: TextRendering;
  /** Idle ms after the last frame before the working set is trimmed (Windows); unset or negative: never. */
  memoryTrimDelay?: number;
  /** `AppOptions.lowPower`: a minimized window gives its renderer back. */
  lowPower?: boolean;
  /** App font files as base64 (CSS `@font-face`), usable by their family name. */
  fonts?: string[];
  /** Windows app identity (AppUserModelID): names the app in media controls and notifications. */
  appIdentity?: { id: string; name: string; icon?: string };
  /** Window and taskbar icon: base64 PNG, ICO, JPEG or WebP bytes. */
  windowIcon?: string;
  /** Report every key press and release as a `keyboard` event (DOM `key`/`code` names), before Tarve's own key handling. */
  keyboardEvents?: boolean;
  /** Report every mouse button press/release and wheel turn as a `pointer` event on the deepest node under the pointer. */
  pointerEvents?: boolean;
}
export type TreeMutation =
  | { type: "create"; node: NativeNode }
  | { type: "patch"; node: NativeNode }
  | { type: "children"; id: string; children: string[] }
  | { type: "remove"; id: string };
export interface FileDialogFilter { name: string; extensions: string[] }
export interface FileDialogOptions {
  title?: string;
  directory?: string;
  fileName?: string;
  filters?: FileDialogFilter[];
}
export type FileDialogMode = "openFile" | "openFiles" | "openFolder" | "saveFile";
/**
 * Why media failed, as HTMLMediaElement `MediaError.code`: `network` (the download: an HTTP
 * status, host, timeout), `format` (a format or codec the system does not play), `decode`
 * (anything else), `aborted`.
 */
export type MediaErrorCode = "aborted" | "network" | "decode" | "format";
export type WindowAction = "show" | "hide" | "minimize" | "focus" | "activate" | "maximize" | "unmaximize" | "fullscreen" | "exitFullscreen" | "toggleFullscreen";
export interface NativeTrayMenuItem {
  id?: string; label?: string; /** Shown next to the label in a menu bar (`Ctrl+S`). */ accelerator?: string; separator?: boolean; checked?: boolean; disabled?: boolean; items?: NativeTrayMenuItem[];
}
export interface NativeTrayOptions { /** Base64 PNG/JPEG/WebP bytes. */ iconData?: string; tooltip?: string; menu: NativeTrayMenuItem[] }
export type NativeCommand =
  /** A command for another window of the app (`app.openWindow`). */
  | { type: "toWindow"; window: string; command: NativeCommand; requestId?: string }
  /** Opens another window of the app from its own document. */
  | { type: "openWindow"; window: string; document: SceneDocument }
  | { type: "patch"; nodes: NativeNode[] }
  | { type: "mutate"; mutations: TreeMutation[] }
  | { type: "update"; root: NativeNode }
  | { type: "close" }
  | { type: "cancelCloseRequest" }
  | { type: "window"; action: WindowAction }
  | { type: "windowLevel"; level: WindowLevel }
  | { type: "windowTitle"; title: string }
  | { type: "tray"; tray: NativeTrayOptions | null }
  /** The window's native menu bar (Windows); null removes it. */
  | { type: "menuBar"; menu: NativeTrayMenuItem[] | null }
  | { type: "systemMedia"; session: NativeSystemMediaSession | null }
  /** A system notification; its `notificationClick` carries the same `id`. */
  | { type: "notify"; title: string; body: string; id?: string }
  | { type: "media"; id: string; action: "load" | "unload" | "play" | "pause" | "seek" | "set" | "rate" | "audioTrack" | "textTrack"; /** The `audioTracks` id with the `audioTrack` action. */ track?: number; src?: string; time?: number; volume?: number; muted?: boolean; loop?: boolean; /** `playbackRate` with the `rate` action: the sound keeps its pitch. */ rate?: number; /** `"video"` on a load: the platform video decoder plays it. */ kind?: "video" }
  | { type: "frameOverlay"; enabled: boolean }
  | { type: "frameRate"; maxFps: number | null }
  | { type: "focus"; id: string }
  | { type: "scrollToItem"; id: string; index: number; offset?: number; smooth?: boolean }
  | { type: "inspect"; requestId: string }
  /** The focused text field and its selection, as UTF-8 offsets (answered synchronously). */
  | { type: "selection"; requestId: string }
  /** Lay the window out now and answer with these nodes' boxes (a synchronous layout read). */
  | { type: "layout"; requestId: string; ids: string[] }
  | { type: "stats"; requestId: string; reset?: boolean }
  | { type: "resize"; width: number; height: number }
  | { type: "capture"; path: string; requestId: string }
  | { type: "motionAdvance"; milliseconds: number; requestId: string }
  | { type: "fileDialog"; mode: FileDialogMode; options: FileDialogOptions; requestId: string }
  | { type: "webSignIn"; url: string; cookieUrl: string; cookies: string[]; requestId: string }
  /** Runtime permissions: Android asks the user; desktops grant every name. */
  | { type: "permissions"; action: "check" | "request"; permissions: string[]; requestId: string }
  /** The system share sheet (Android chooser, Windows share UI); answered by a `share` event once it is shown. */
  | { type: "share"; requestId: string; title?: string; text?: string; url?: string; files?: string[] }
  /**
   * Device location. "get" answers one `location` event; "watch" starts `position` events whose
   * `watchId` is this `requestId`; "clear" stops the watch with that `requestId` (no answer).
   */
  | { type: "location"; action: "get" | "watch" | "clear"; requestId: string; highAccuracy?: boolean; timeoutMs?: number; maximumAgeMs?: number }
  | { type: "speech"; action: "start" | "stop" | "cancel"; sessionId: string; language?: string; partialResults?: boolean }
  /** Android: arm (`set`) or drop (`cancel`) a notification that fires at `at` (epoch ms) or on entering/leaving `place`, with the app closed too. */
  | { type: "scheduleNotification"; action: "set" | "cancel"; id: string; title?: string; body?: string; at?: number; place?: { latitude: number; longitude: number; radius: number; leave?: boolean } }
  /** Biometric or device-credential check (Android BiometricPrompt, Windows Hello); answered by `authenticate`. */
  | { type: "authenticate"; requestId: string; reason: string }
  | { type: "input"; action: "move" | "down" | "up" | "wheel" | "text" | "key"; x?: number; y?: number; delta?: number; deltaX?: number; deltaY?: number; text?: string };
/** A node's laid-out box, like its `size` event: the content size, and the border box in the window. */
export interface LayoutBox { width: number; height: number; x: number; y: number; borderWidth: number; borderHeight: number }
export interface NodeSnapshot {
  id: string; kind: NodeKind; x: number; y: number; width: number; height: number;
  scroll: number; scrollMax: number; text: string;
  scrollX?: number; scrollY?: number; scrollMaxX?: number; scrollMaxY?: number;
  control?: Control | null;
  virtualListAnchor?: VirtualListAnchor | null;
}
export interface Snapshot {
  layoutNodes: number; layoutNodesCreated: number; measureCalls: number; paintedNodes: number;
  frames: number; layouts: number; shapes: number; paints: number;
  /** Frames presented in the last second. */
  fps: number;
  activeMotions: number;
  /** Glyphs rasterized so far on renderers with their own glyph atlas (D3D11); null elsewhere. */
  glyphRasterizations?: number | null;
  /** The window composes alpha: its translucent pixels show what is behind it (`backdrop`). */
  windowAlpha?: boolean;
  /** Windows "Transparency effects" (Settings > Personalization > Colors); while off, mica, acrylic and blur are solid. Always true elsewhere. */
  transparencyEffects?: boolean;
  hovered: string | null; focused: string | null; nodes: NodeSnapshot[];
  width: number; height: number; scale: number;
}
/** Milliseconds of one phase over its recent samples (the last 600 frames or updates). */
export interface PhaseSummary { count: number; p50: number; p95: number; p99: number; max: number }
/** Process memory: resident (Task Manager "Memory", Linux VmRSS) and private (Windows commit, Linux anonymous RSS). */
export interface MemoryReading { workingSetMb: number; privateMb: number }
export interface NativeStats {
  /**
   * apply: a JS update applied to the retained tree; layout: layout and text measurement;
   * paint: recording the frame; present: rasterize and present (includes vsync waits);
   * frame: motion, layout and paint together; gpu: GPU execution of a frame (D3D11 only,
   * count 0 elsewhere). Null in the browser build.
   */
  phases: Record<"apply" | "layout" | "paint" | "present" | "frame" | "gpu", PhaseSummary> | null;
  /** Memory after each startup stage (start, tree, window, graphics, firstFrame) and now. */
  memory: { stages: (MemoryReading & { label: string })[]; current: MemoryReading | null } | null;
}
export type NativeEvent =
  | { type: "ready" | "closed" }
  | { type: "closeRequest" }
  | { type: "tray"; action: "click" | "doubleClick" }
  | { type: "systemMedia"; action: "play" | "pause" | "next" | "previous" | "seek"; time?: number }
  | { type: "trayMenu"; id: string }
  /** Whether the tray icon can be seen: after the first `tray` command and on every change (a tray host starting or stopping). */
  | { type: "trayAvailability"; supported: boolean; available: boolean; reason?: string }
  | { type: "notificationClick"; id?: string }
  /** Windows "Transparency effects" changed while the window has a `mica`, `acrylic` or `blur` backdrop. */
  | { type: "transparencyEffects"; enabled: boolean }
  | { type: "media"; id: string; event: "loadedmetadata" | "canplay" | "waiting" | "progress" | "audiotracks" | "texttracks" | "cuechange" | "play" | "pause" | "timeupdate" | "seeked" | "ended" | "error"; time?: number; duration?: number | null; paused?: boolean; message?: string; code?: MediaErrorCode; /** End (s) of the buffered range holding the current time. */ buffered?: number; /** `loadedmetadata`: the served file's name (after redirects). */ filename?: string; /** `audiotracks`: the media's audio streams. */ audioTracks?: { id: number; label: string; language: string; enabled: boolean }[]; /** `texttracks`: subtitle streams in the file. */ textTracks?: { id: number; label: string; language: string; enabled: boolean }[]; /** `cuechange`: the subtitle text shown now. */ cueText?: string; videoWidth?: number; videoHeight?: number }
  | { type: "escape" }
  | { type: "click"; id: string }
  | { type: "context"; id: string; x: number; y: number }
  | { type: "longPress"; id: string }
  /** A two-finger pinch: `scale` is cumulative (1 at "start"); `x`, `y` the fingers' midpoint. */
  | { type: "pinch"; id: string; phase: "start" | "move" | "end"; scale: number; x: number; y: number }
  | { type: "outside"; id: string }
  | { type: "change"; id: string; value: string }
  | { type: "submit"; id: string; value: string }
  | { type: "paste"; id: string; files?: string[]; image?: { width: number; height: number; rgba: string } }
  | { type: "valueChange"; id: string; value: number }
  | { type: "scroll"; id: string; offset: number; max: number; offsetX?: number; offsetY?: number; maxX?: number; maxY?: number; source?: ScrollSource }
  | { type: "virtualListLayout"; id: string; items: VirtualListMeasurement[] }
  | { type: "size"; id: string; width: number; height: number; x?: number; y?: number; borderWidth?: number; borderHeight?: number }
  /** The system text size, motion preference and pointer: when the window opens and when they change. */
  | { type: "environment"; fontScale: number; reducedMotion: boolean; pointer: "coarse" | "fine" }
  | { type: "pointerMove"; id: string; x: number; y: number }
  | { type: "pointerLeave"; id: string }
  | { type: "virtualListScrollToItem"; id: string; index: number; offset: number; smooth?: boolean }
  | { type: "virtualListFocus"; id: string; key: string | null }
  | { type: "markdownLink"; id: string; href: string }
  | { type: "diffToggleFile"; id: string; path: string }
  | { type: "diffShowMore"; id: string; hidden: number; path?: string | null }
  | { type: "diffLineClick"; id: string; text: string; path?: string | null; oldLine?: number | null; newLine?: number | null }
  | { type: "highlight"; id: string; matchCount: number; query?: string; caseSensitive?: boolean; wholeWord?: boolean }
  | { type: "hover"; id: string; entered: boolean }
  | { type: "dragStart"; id: string; x: number; y: number }
  | { type: "dragMove"; id: string; x: number; y: number; over: string | null }
  | { type: "drop"; id: string; target: string | null; x: number; y: number }
  | { type: "dragCancel"; id: string }
  /** Files dragged in from the system entered a file drop target. */
  | { type: "fileDragEnter"; id: string; paths: string[] }
  | { type: "fileDragLeave"; id: string }
  /** An item of the window's menu bar was chosen. */
  | { type: "menu"; id: string }
  /** The window's restored bounds (logical outer position, client size) and state changed (`reportWindowState`). */
  | { type: "windowState"; x: number; y: number; physical?: boolean; width: number; height: number; maximized: boolean; fullscreen: boolean }
  /** Files dropped from the system on the file drop target under the pointer. */
  | { type: "fileDrop"; id: string; paths: string[]; x: number; y: number }
  /** Files dropped from the system outside every file drop target. */
  | { type: "fileDrop"; paths: string[]; x: number; y: number }
  | { type: "key"; id: string; key: string }
  | { type: "pointer"; phase: "down" | "up" | "wheel"; id: string | null; x: number; y: number; button?: number; deltaX?: number; deltaY?: number; ctrlKey: boolean; altKey: boolean; shiftKey: boolean; metaKey: boolean }
  | { type: "keyboard"; phase: "down" | "up"; id: string | null; key: string; code: string; repeat: boolean; ctrlKey: boolean; altKey: boolean; shiftKey: boolean; metaKey: boolean }
  | { type: "blur"; id: string }
  /** An `image` node's source failed to load or decode. */
  | { type: "imageError"; id: string; src: string; message: string }
  | { type: "shortcut"; shortcut: string }
  | { type: "error"; message: string }
  | { type: "inspect"; requestId: string; snapshot: Snapshot }
  | { type: "layout"; requestId: string; boxes: Record<string, LayoutBox> }
  | { type: "selection"; requestId: string; target: string | null; anchor: number; focus: number }
  | { type: "stats"; requestId: string; stats: NativeStats }
  | { type: "captured"; requestId: string; path: string; error?: string }
  | { type: "motionComplete"; id: string; property: MotionProperty }
  | { type: "motionAdvanced"; requestId: string; milliseconds: number; activeMotions: number; error?: string }
  | { type: "fileDialog"; requestId: string; paths: string[]; error?: string }
  | { type: "webSignIn"; requestId: string; cookie?: string | null; error?: string }
  | { type: "permissions"; requestId: string; results: Record<string, PermissionState>; error?: string }
  | { type: "share"; requestId: string; supported: boolean; error?: string }
  | { type: "location"; requestId: string; supported: boolean; position?: GeoPosition; code?: GeoErrorCode; error?: string }
  /** A fix (or an error) of the watch started by the `location` command with `requestId` = `watchId`. */
  | { type: "position"; watchId: string; supported: boolean; position?: GeoPosition; code?: GeoErrorCode; error?: string }
  /** A dictation session's progress; `phase: "result"` is the last one (`text`, or `code`). */
  | { type: "speech"; sessionId: string; phase: "ready" | "partial" | "level" | "end" | "result"; supported?: boolean; text?: string; level?: number; code?: SpeechErrorCode; error?: string }
  | { type: "authenticate"; requestId: string; supported: boolean; success: boolean; code?: AuthErrorCode; error?: string }
  /** Links and files the OS asked the app to open (Android VIEW intents); `initial` for the launch's own. */
  | { type: "open"; urls: string[]; files: string[]; initial: boolean }
  | { type: "frame"; frames: number };
/** A runtime permission's state: "prompt" until the user has answered Android's dialog; always "granted" on desktops. */
export type PermissionState = "granted" | "prompt" | "denied";
/** A location fix, like the DOM `GeolocationCoordinates` plus its time (ms since the epoch); null when the source does not know. */
export interface GeoPosition {
  latitude: number; longitude: number; /** Metres. */ accuracy: number;
  altitude: number | null; altitudeAccuracy: number | null; /** Degrees from north. */ heading: number | null; /** Metres per second. */ speed: number | null;
  timestamp: number;
}
export type GeoErrorCode = "unsupported" | "denied" | "unavailable" | "timeout";
export type AuthErrorCode = "unsupported" | "not-enrolled" | "canceled" | "failed" | "lockout" | "busy";
/** Why a dictation ended without text: no recogniser here, no microphone permission, silence, no connection to the service, it is busy, a microphone fault, or none available. */
export type SpeechErrorCode = "unsupported" | "denied" | "no-speech" | "network" | "busy" | "audio" | "unavailable";
export interface NativeSystemMediaSession { title: string; artist?: string; album?: string; artwork?: string; playing: boolean; duration?: number; position?: number; canSeek?: boolean; canNext?: boolean; canPrevious?: boolean; }
