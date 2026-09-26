/** Renderer-independent, versioned messages crossing the C ABI as UTF-8 JSON. */
export const NATIVE_ABI_VERSION = 5;
export const PROTOCOL_VERSION = 41;
export type Renderer = "auto" | "gpu" | "cpu";
export type Length = number | `${number}%` | "auto";
export type NodeKind = "window" | "titlebar" | "view" | "row" | "column" | "text" | "markdown" | "code" | "diff" | "button" | "image" | "svg" | "scroll" | "input" | "textarea" | "pressable" | "slider" | "splitter";
export type SvgElementName = "path" | "circle" | "ellipse" | "g" | "line" | "polygon" | "polyline" | "rect";
export type SvgAttributeValue = string | number;
export type SvgAttributes = Record<string, SvgAttributeValue>;
export type SvgNode =
  | readonly [SvgElementName, SvgAttributes]
  | readonly [SvgElementName, SvgAttributes, readonly SvgNode[]];
export type Insets = number | { top?: number; right?: number; bottom?: number; left?: number };
export type OutlineStyle = "dotted" | "dashed" | "solid" | "double" | "groove" | "ridge" | "inset" | "outset" | "none" | "hidden";
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
  background?: string; foreground?: string; borderColor?: string; radius?: number;
  outlineWidth?: number; outlineColor?: string; outlineOffset?: number; outlineRadius?: number; outlineStyle?: OutlineStyle;
  placeholderColor?: string; selectionColor?: string; caretColor?: string;
  scrollbarColor?: string; placeholderBackground?: string; thumbColor?: string;
  textDecoration?: TextDecoration;
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
  strokeWidth?: number; pointerEvents?: "auto" | "block"; userSelect?: UserSelect;
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
export interface NativeNode {
  id: string; kind: NodeKind; style: Style; children: NativeNode[];
  text?: string; source?: string; language?: string; path?: string; oldText?: string; newText?: string;
  showLineNumbers?: boolean; syntaxTheme?: Partial<SyntaxTheme>;
  wordDiff?: boolean; collapsedPaths?: string[]; maxLines?: number;
  highlight?: TextHighlight;
  src?: string; fit?: "cover" | "contain"; disabled?: boolean;
  svg?: string;
  value?: string; placeholder?: string;
  inputType?: "text" | "password" | "email" | "number" | "search" | "tel" | "url";
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
  windowAction?: "minimize" | "toggleMaximize" | "close";
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
  | { type: "focus"; id: string }
  | { type: "scrollToItem"; id: string; index: number; offset?: number }
  | { type: "inspect"; requestId: string }
  | { type: "resize"; width: number; height: number }
  | { type: "capture"; path: string; requestId: string }
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
  | { type: "key"; id: string; key: string }
  | { type: "blur"; id: string }
  | { type: "shortcut"; shortcut: string }
  | { type: "error"; message: string }
  | { type: "inspect"; requestId: string; snapshot: Snapshot }
  | { type: "captured"; requestId: string; path: string; error?: string }
  | { type: "fileDialog"; requestId: string; paths: string[]; error?: string }
  | { type: "frame"; frames: number };
