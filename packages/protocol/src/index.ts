/** Renderer-independent, versioned messages crossing the C ABI as UTF-8 JSON. */
export const PROTOCOL_VERSION = 21;
export type Length = number | `${number}%` | "auto";
export type NodeKind = "window" | "titlebar" | "view" | "row" | "column" | "text" | "button" | "image" | "scroll" | "input" | "textarea" | "pressable" | "icon" | "slider" | "splitter";
export type Insets = number | { top?: number; right?: number; bottom?: number; left?: number };
export type OutlineStyle = "dotted" | "dashed" | "solid" | "double" | "groove" | "ridge" | "inset" | "outset" | "none" | "hidden";
export interface StateStyle {
  background?: string; foreground?: string; borderColor?: string; radius?: number;
  outlineWidth?: number; outlineColor?: string; outlineOffset?: number; outlineRadius?: number; outlineStyle?: OutlineStyle;
  placeholderColor?: string; selectionColor?: string; caretColor?: string;
  scrollbarColor?: string; placeholderBackground?: string; thumbColor?: string;
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
  hover?: StateStyle; focus?: StateStyle; active?: StateStyle; disabled?: StateStyle;
  strokeWidth?: number; pointerEvents?: "auto" | "block";
}
export interface Control {
  role: "button" | "checkbox" | "switch" | "radio" | "radiogroup" | "tab" | "tablist" | "navigation" | "menuitem" | "toggle" | "togglegroup" | "slider" | "progress" | "virtualList" | "select" | "group" | "alert" | "status" | "label" | "option";
  label?: string; checked?: boolean; group?: string;
  orientation?: "horizontal" | "vertical";
  value?: number; min?: number; max?: number; step?: number;
}
export interface NativeNode {
  id: string; kind: NodeKind; style: Style; children: NativeNode[];
  text?: string; src?: string; fit?: "cover" | "contain"; disabled?: boolean;
  value?: string; placeholder?: string;
  control?: Control | null;
  modal?: boolean; focusable?: boolean;
  portal?: boolean;
  dismissOnOutside?: boolean;
  dragRegion?: boolean;
  windowAction?: "minimize" | "toggleMaximize" | "close";
}
export type WindowPositionPreset =
  | "top-left" | "top" | "top-right"
  | "left" | "center" | "right"
  | "bottom-left" | "bottom" | "bottom-right";
export type WindowPosition = WindowPositionPreset | { x: number; y: number };
export interface WindowOptions {
  title: string; width: number; height: number; minWidth: number; minHeight: number;
  background: string; decorations: boolean; resizable: boolean; position?: WindowPosition; debug?: boolean;
}
export interface SceneDocument { version: number; window: WindowOptions; root: NativeNode }
export type NativeCommand =
  | { type: "patch"; nodes: NativeNode[] }
  | { type: "update"; root: NativeNode }
  | { type: "close" }
  | { type: "focus"; id: string }
  | { type: "inspect"; requestId: string }
  | { type: "resize"; width: number; height: number }
  | { type: "capture"; path: string; requestId: string }
  | { type: "input"; action: "move" | "down" | "up" | "wheel" | "text" | "key"; x?: number; y?: number; delta?: number; text?: string };
export interface NodeSnapshot {
  id: string; kind: NodeKind; x: number; y: number; width: number; height: number;
  scroll: number; scrollMax: number; text: string;
  control?: Control | null;
}
export interface Snapshot {
  layoutNodes: number; layoutNodesCreated: number; measureCalls: number; paintedNodes: number;
  frames: number; layouts: number; shapes: number; paints: number;
  hovered: string | null; focused: string | null; nodes: NodeSnapshot[];
  width: number; height: number; scale: number;
}
export type NativeEvent =
  | { type: "ready" | "closed" }
  | { type: "escape" }
  | { type: "click"; id: string }
  | { type: "context"; id: string; x: number; y: number }
  | { type: "outside"; id: string }
  | { type: "change"; id: string; value: string }
  | { type: "valueChange"; id: string; value: number }
  | { type: "scroll"; id: string; offset: number; max: number }
  | { type: "hover"; id: string; entered: boolean }
  | { type: "key"; id: string; key: string }
  | { type: "blur"; id: string }
  | { type: "error"; message: string }
  | { type: "inspect"; requestId: string; snapshot: Snapshot }
  | { type: "captured"; requestId: string; path: string }
  | { type: "frame"; frames: number };
