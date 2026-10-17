/** Renderer-independent, versioned messages crossing the C ABI as UTF-8 JSON. */
export const NATIVE_ABI_VERSION = 5;
export const PROTOCOL_VERSION = 59;
export type Renderer = "auto" | "gpu" | "cpu";
export type Length = number | `${number}%` | "auto";
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
export type MotionTransitions = Partial<Record<MotionProperty | "all", MotionTransition>>;
export type MotionValues = Partial<Record<NumericMotionProperty, number>>;
export type NodeKind = "window" | "titlebar" | "view" | "row" | "column" | "text" | "markdown" | "code" | "diff" | "button" | "image" | "svg" | "scroll" | "input" | "textarea" | "pressable" | "slider" | "splitter" | "video";
export type SvgElementName = "path" | "circle" | "ellipse" | "g" | "line" | "polygon" | "polyline" | "rect";
export type SvgAttributeValue = string | number;
export type SvgAttributes = Record<string, SvgAttributeValue>;
export type SvgNode =
  | readonly [SvgElementName, SvgAttributes]
  | readonly [SvgElementName, SvgAttributes, readonly SvgNode[]];
export type Insets = number | { top?: number; right?: number; bottom?: number; left?: number };
/** A margin side: px, a percentage of the container, or `"auto"` (CSS auto margins centre a box or push it aside). */
export type MarginSide = number | `${number}%` | "auto";
export type Margins = MarginSide | { top?: MarginSide; right?: MarginSide; bottom?: MarginSide; left?: MarginSide };
/** Corner radii: a number rounds every corner; an object names each (missing corners are square). */
export type CornerRadius = number | { topLeft?: number; topRight?: number; bottomRight?: number; bottomLeft?: number };
export type OutlineStyle = "dotted" | "dashed" | "solid" | "double" | "groove" | "ridge" | "inset" | "outset" | "none" | "hidden";
/** Same values as OutlineStyle. Non-solid styles apply when all four border widths are equal. */
export type BorderStyle = OutlineStyle;
/** Offset copy of the text; `blur` is the CSS blur radius (sigma = blur / 2, max 200), 0 for a solid copy. */
export interface TextShadow { x?: number; y?: number; blur?: number; color: string }
/** CSS-like box shadow. `blur` is the CSS blur radius (sigma = blur / 2); `inset` paints inside the padding box. */
/** Paint-time translate/scale about the box centre. Hit testing follows it; layout does not. */
/**
 * Paint-time transform about the box's origin (its centre unless `originX`/`originY`, fractions
 * of the box, say otherwise): translate, scale, `rotate` and `skewX`/`skewY` in degrees.
 */
export interface Transform {
  x?: number; y?: number; scale?: number; scaleX?: number; scaleY?: number;
  rotate?: number; skewX?: number; skewY?: number; originX?: number; originY?: number;
}
export interface BoxShadow { x?: number; y?: number; blur?: number; spread?: number; color: string; inset?: boolean }
/** Gradient length: a number is px; strings take `px` or `%`. */
export type GradientLength = number | `${number}px` | `${number}%`;
/**
 * A colour stop. A number `offset` is a fraction 0..1 of the gradient line (or radial ray);
 * strings take `px` or `%`. Omitted offsets are spread evenly and positions never go back, as in CSS.
 */
export interface GradientStop { color: string; offset?: number | `${number}px` | `${number}%` }
export type GradientSide = "top" | "bottom" | "left" | "right" | "top left" | "top right" | "bottom left" | "bottom right";
/** CSS `linear-gradient`: `angle` in CSS degrees (0 = to top, 90 = to right, default 180), or `to` a side/corner. */
export interface LinearGradient { type: "linear"; angle?: number; to?: GradientSide; repeating?: boolean; stops: readonly (GradientStop | string)[] }
/**
 * Radial centre. A number is a fraction of the box; strings take `px` or `%`.
 * `xEdge: "right"` / `yEdge: "bottom"` measure from the far edge (CSS `right 10px bottom 20%`).
 */
export interface GradientCentre {
  x?: number | `${number}px` | `${number}%`; y?: number | `${number}px` | `${number}%`;
  xEdge?: "left" | "right"; yEdge?: "top" | "bottom";
}
export type RadialExtent = "closest-side" | "closest-corner" | "farthest-side" | "farthest-corner";
/**
 * CSS `radial-gradient`. `at` is the centre as fractions of the box (default 0.5, 0.5).
 * `size` is an extent keyword (default `farthest-corner`), one length (circle radius) or two (ellipse radii).
 */
export interface RadialGradient {
  type: "radial"; shape?: "ellipse" | "circle"; at?: GradientCentre;
  size?: RadialExtent | GradientLength | readonly [GradientLength, GradientLength];
  repeating?: boolean; stops: readonly (GradientStop | string)[];
}
/** A conic colour stop: a number is a fraction of a turn; strings take `%`, `deg`, `turn`, `rad` or `grad`. */
export interface ConicGradientStop { color: string; offset?: number | `${number}%` | `${number}deg` | `${number}turn` | `${number}rad` | `${number}grad` }
/**
 * CSS `conic-gradient`: `from` in CSS degrees (0 points up, clockwise; default 0) and `at` the centre
 * (default the box centre). Stops sweep one turn clockwise from `from`.
 */
export interface ConicGradient {
  type: "conic"; from?: number; at?: GradientCentre;
  repeating?: boolean; stops: readonly (ConicGradientStop | string)[];
}
export type Gradient = LinearGradient | RadialGradient | ConicGradient;
export type UserSelect = "auto" | "text" | "none" | "all";
export type TextDecoration = "none" | "underline" | "overline" | "line-through";
export interface SyntaxTheme {
  comment: string; keyword: string; string: string; stringSpecial: string; escape: string;
  number: string; boolean: string; typeName: string; typeBuiltin: string; constructor: string;
  function: string; functionBuiltin: string; macro: string; property: string; constant: string;
  variable: string; variableSpecial: string; parameter: string; operator: string; punctuation: string;
  tag: string; attribute: string; label: string; embedded: string; invalid: string;
}
export interface TextHighlightRange { start: number; end: number }
export interface TextHighlight {
  query?: string;
  ranges?: TextHighlightRange[];
  activeIndex?: number;
  caseSensitive?: boolean;
  wholeWord?: boolean;
  color?: string;
  activeColor?: string;
}
/**
 * Liquid-glass material: what is behind the box shows through blurred and bent at the
 * edges, under the box's `background` colour as a tint. The D3D11 renderer paints it;
 * other renderers paint the tint alone.
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
  /** CSS `cursor` keyword; inherited by descendants. */
  cursor?: "auto" | "default" | "pointer" | "text" | "vertical-text" | "move" | "grab" | "grabbing" | "not-allowed" | "no-drop" | "wait" | "progress" | "help" | "crosshair" | "copy" | "alias" | "context-menu" | "cell" | "zoom-in" | "zoom-out" | "col-resize" | "row-resize" | "ew-resize" | "ns-resize" | "nesw-resize" | "nwse-resize" | "all-scroll";
  /** Grid row tracks as a CSS track list (`"auto 1fr"`); rows are implicit when omitted. */
  rows?: number | string;
  zIndex?: number;
  borderWidth?: Insets;
  radius?: CornerRadius; fontSize?: number; fontWeight?: number; fontFamily?: string;
  /** Native retained transitions. Bun sends the target once; Rust owns interpolation. */
  transition?: MotionTransitions;
  /** Continuous rotation about the centre, one turn per `spin` milliseconds. Rust drives the frames. */
  spin?: number;
  /** CSS text: `font-style`, `letter-spacing`, `word-spacing`, `text-transform`, `white-space`, `text-overflow` and `line-clamp`. */
  fontStyle?: "normal" | "italic" | "oblique"; letterSpacing?: number; wordSpacing?: number;
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
  /** Native sends a `size` event with the content-box size on first layout and on every change. */
  reportSize?: boolean;
  /** Native sends `pointerMove` events with the pointer's position inside the node while it is over it. */
  reportPointer?: boolean;
  windowAction?: "minimize" | "toggleMaximize" | "close";
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
export type WindowPosition = WindowPositionPreset | { x: number; y: number };
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
export interface SceneDocument {
  version: number; renderer: Renderer; window: WindowOptions; root: NativeNode;
  /** D3D11 MSAA samples: 0 (default) uses a coverage fringe instead; 2, 4 or 8. */
  msaa?: number;
  /** Idle ms after the last frame before the working set is trimmed (Windows); negative: never. */
  memoryTrimDelay?: number;
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
export type WindowAction = "show" | "hide" | "minimize" | "focus";
export interface NativeTrayMenuItem {
  id?: string; label?: string; separator?: boolean; checked?: boolean; disabled?: boolean; items?: NativeTrayMenuItem[];
}
export interface NativeTrayOptions { /** Base64 PNG/JPEG/WebP bytes. */ iconData?: string; tooltip?: string; menu: NativeTrayMenuItem[] }
export type NativeCommand =
  | { type: "patch"; nodes: NativeNode[] }
  | { type: "mutate"; mutations: TreeMutation[] }
  | { type: "update"; root: NativeNode }
  | { type: "close" }
  | { type: "cancelCloseRequest" }
  | { type: "window"; action: WindowAction }
  | { type: "windowLevel"; level: WindowLevel }
  | { type: "windowTitle"; title: string }
  | { type: "tray"; tray: NativeTrayOptions | null }
  | { type: "systemMedia"; session: NativeSystemMediaSession | null }
  | { type: "notify"; title: string; body: string }
  | { type: "media"; id: string; action: "load" | "unload" | "play" | "pause" | "seek" | "set"; src?: string; time?: number; volume?: number; muted?: boolean; loop?: boolean; /** `"video"` on a load: the platform video decoder plays it. */ kind?: "video" }
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
  | { type: "notificationClick" }
  /** Windows "Transparency effects" changed while the window has a `mica`, `acrylic` or `blur` backdrop. */
  | { type: "transparencyEffects"; enabled: boolean }
  | { type: "media"; id: string; event: "loadedmetadata" | "play" | "pause" | "timeupdate" | "seeked" | "ended" | "error"; time?: number; duration?: number | null; paused?: boolean; message?: string; videoWidth?: number; videoHeight?: number }
  | { type: "escape" }
  | { type: "click"; id: string }
  | { type: "context"; id: string; x: number; y: number }
  | { type: "outside"; id: string }
  | { type: "change"; id: string; value: string }
  | { type: "submit"; id: string; value: string }
  | { type: "paste"; id: string; files?: string[]; image?: { width: number; height: number; rgba: string } }
  | { type: "valueChange"; id: string; value: number }
  | { type: "scroll"; id: string; offset: number; max: number; offsetX?: number; offsetY?: number; maxX?: number; maxY?: number; source?: ScrollSource }
  | { type: "virtualListLayout"; id: string; items: VirtualListMeasurement[] }
  | { type: "size"; id: string; width: number; height: number; x?: number; y?: number; borderWidth?: number; borderHeight?: number }
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
  | { type: "key"; id: string; key: string }
  | { type: "pointer"; phase: "down" | "up" | "wheel"; id: string | null; x: number; y: number; button?: number; deltaX?: number; deltaY?: number; ctrlKey: boolean; altKey: boolean; shiftKey: boolean; metaKey: boolean }
  | { type: "keyboard"; phase: "down" | "up"; id: string | null; key: string; code: string; repeat: boolean; ctrlKey: boolean; altKey: boolean; shiftKey: boolean; metaKey: boolean }
  | { type: "blur"; id: string }
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
  | { type: "frame"; frames: number };
export interface NativeSystemMediaSession { title: string; artist?: string; album?: string; artwork?: string; playing: boolean; duration?: number; position?: number; canSeek?: boolean; canNext?: boolean; canPrevious?: boolean; }
