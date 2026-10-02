/** Renderer-independent, versioned messages crossing the C ABI as UTF-8 JSON. */
export const NATIVE_ABI_VERSION = 5;
export const PROTOCOL_VERSION = 49;
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
export type NodeKind = "window" | "titlebar" | "view" | "row" | "column" | "text" | "markdown" | "code" | "diff" | "button" | "image" | "svg" | "scroll" | "input" | "textarea" | "pressable" | "slider" | "splitter";
export type SvgElementName = "path" | "circle" | "ellipse" | "g" | "line" | "polygon" | "polyline" | "rect";
export type SvgAttributeValue = string | number;
export type SvgAttributes = Record<string, SvgAttributeValue>;
export type SvgNode =
  | readonly [SvgElementName, SvgAttributes]
  | readonly [SvgElementName, SvgAttributes, readonly SvgNode[]];
export type Insets = number | { top?: number; right?: number; bottom?: number; left?: number };
export type OutlineStyle = "dotted" | "dashed" | "solid" | "double" | "groove" | "ridge" | "inset" | "outset" | "none" | "hidden";
/** Same values as OutlineStyle. Non-solid styles apply when all four border widths are equal. */
export type BorderStyle = OutlineStyle;
/** Offset copy of the text; `blur` is the CSS blur radius (sigma = blur / 2, max 200), 0 for a solid copy. */
export interface TextShadow { x?: number; y?: number; blur?: number; color: string }
/** CSS-like box shadow. `blur` is the CSS blur radius (sigma = blur / 2); `inset` paints inside the padding box. */
/** Paint-time translate/scale about the box centre. Hit testing follows it; layout does not. */
export interface Transform { x?: number; y?: number; scale?: number; scaleX?: number; scaleY?: number }
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
export interface StateStyle {
  /** Colour, gradient object, or CSS `linear-gradient(…)` / `radial-gradient(…)` string. */
  background?: string | Gradient; foreground?: string | Gradient; borderColor?: string | Gradient; borderStyle?: BorderStyle; radius?: number;
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
  maxWidth?: Length; maxHeight?: Length; flex?: number; shrink?: number; aspectRatio?: number;
  position?: "relative" | "absolute"; top?: Length; right?: Length; bottom?: Length; left?: Length;
  direction?: "row" | "row-reverse" | "column" | "column-reverse"; wrap?: boolean; gap?: number;
  padding?: Insets; margin?: Insets; align?: "start" | "center" | "end" | "stretch";
  justify?: "start" | "center" | "end" | "between";
  display?: "flex" | "grid" | "none"; columns?: number;
  zIndex?: number;
  borderWidth?: Insets;
  radius?: number; fontSize?: number; fontWeight?: number; fontFamily?: string;
  /** Native retained transitions. Bun sends the target once; Rust owns interpolation. */
  transition?: MotionTransitions;
  /** Continuous rotation about the centre, one turn per `spin` milliseconds. Rust drives the frames. */
  spin?: number;
  lineHeight?: number; textAlign?: "start" | "center" | "end";
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
  strokeWidth?: number; pointerEvents?: "auto" | "block" | "delegate"; userSelect?: UserSelect;
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
  scrollRequest?: { generation: number; offset: number };
}
export interface VirtualListMeasurement { key: string; height: number }
export interface VirtualListAnchor { index: number; key: string; offset: number }
export type NativeImageSource =
  | { kind: "encoded"; key: string; data: string; mediaType?: string }
  | { kind: "rgba"; key: string; data: string; width: number; height: number; premultiplied?: boolean };
export interface NativeNode {
  id: string; kind: NodeKind; style: Style; children: NativeNode[];
  text?: string; source?: string; language?: string; path?: string; oldText?: string; newText?: string;
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
  windowAction?: "minimize" | "toggleMaximize" | "close";
  /** Optional initial numeric values used only when the native node is first mounted. */
  motionFrom?: MotionValues;
}
export type ScrollOrientation = "vertical" | "horizontal" | "both";
export interface ScrollPosition { x: number; y: number; maxX: number; maxY: number }
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
}
export interface SceneDocument { version: number; renderer: Renderer; window: WindowOptions; root: NativeNode }
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
export type NativeCommand =
  | { type: "patch"; nodes: NativeNode[] }
  | { type: "mutate"; mutations: TreeMutation[] }
  | { type: "update"; root: NativeNode }
  | { type: "close" }
  | { type: "cancelCloseRequest" }
  | { type: "frameOverlay"; enabled: boolean }
  | { type: "focus"; id: string }
  | { type: "scrollToItem"; id: string; index: number; offset?: number }
  | { type: "inspect"; requestId: string }
  | { type: "resize"; width: number; height: number }
  | { type: "capture"; path: string; requestId: string }
  | { type: "motionAdvance"; milliseconds: number; requestId: string }
  | { type: "fileDialog"; mode: FileDialogMode; options: FileDialogOptions; requestId: string }
  | { type: "input"; action: "move" | "down" | "up" | "wheel" | "text" | "key"; x?: number; y?: number; delta?: number; deltaX?: number; deltaY?: number; text?: string };
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
  activeMotions: number;
  /** Glyphs rasterized so far on renderers with their own glyph atlas (D3D11); null elsewhere. */
  glyphRasterizations?: number | null;
  hovered: string | null; focused: string | null; nodes: NodeSnapshot[];
  width: number; height: number; scale: number;
}
export type NativeEvent =
  | { type: "ready" | "closed" }
  | { type: "closeRequest" }
  | { type: "escape" }
  | { type: "click"; id: string }
  | { type: "context"; id: string; x: number; y: number }
  | { type: "outside"; id: string }
  | { type: "change"; id: string; value: string }
  | { type: "submit"; id: string; value: string }
  | { type: "paste"; id: string; files?: string[]; image?: { width: number; height: number; rgba: string } }
  | { type: "valueChange"; id: string; value: number }
  | { type: "scroll"; id: string; offset: number; max: number; offsetX?: number; offsetY?: number; maxX?: number; maxY?: number }
  | { type: "virtualListLayout"; id: string; items: VirtualListMeasurement[] }
  | { type: "virtualListScrollToItem"; id: string; index: number; offset: number }
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
  | { type: "blur"; id: string }
  | { type: "shortcut"; shortcut: string }
  | { type: "error"; message: string }
  | { type: "inspect"; requestId: string; snapshot: Snapshot }
  | { type: "captured"; requestId: string; path: string; error?: string }
  | { type: "motionComplete"; id: string; property: MotionProperty }
  | { type: "motionAdvanced"; requestId: string; milliseconds: number; activeMotions: number; error?: string }
  | { type: "fileDialog"; requestId: string; paths: string[]; error?: string }
  | { type: "frame"; frames: number };
