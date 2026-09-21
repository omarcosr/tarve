/** Renderer-independent, versioned messages crossing the C ABI as UTF-8 JSON. */
export const PROTOCOL_VERSION = 6;
export type Length = number | `${number}%` | "auto";
export type NodeKind = "window" | "titlebar" | "view" | "row" | "column" | "text" | "button" | "image" | "scroll" | "input" | "pressable" | "icon" | "slider";
export type Insets = number | { top?: number; right?: number; bottom?: number; left?: number };
export interface Style {
  width?: Length; height?: Length; minWidth?: Length; minHeight?: Length;
  maxWidth?: Length; maxHeight?: Length; flex?: number; shrink?: number;
  position?: "relative" | "absolute"; top?: Length; right?: Length; bottom?: Length; left?: Length;
  direction?: "row" | "column"; wrap?: boolean; gap?: number;
  padding?: Insets; margin?: Insets; align?: "start" | "center" | "end" | "stretch";
  justify?: "start" | "center" | "end" | "between";
  display?: "flex" | "grid" | "none"; columns?: number;
  background?: string; foreground?: string; borderColor?: string; borderWidth?: number;
  radius?: number; fontSize?: number; fontWeight?: number; fontFamily?: string;
  lineHeight?: number; textAlign?: "start" | "center" | "end";
  hoverBackground?: string; activeBackground?: string; focusColor?: string;
  strokeWidth?: number; pointerEvents?: "auto" | "block";
}
export interface Control {
  role: "button" | "checkbox" | "switch" | "radio" | "radiogroup" | "tab" | "tablist" | "slider";
  label?: string; checked?: boolean; group?: string;
  orientation?: "horizontal" | "vertical";
  value?: number; min?: number; max?: number; step?: number;
}
export interface NativeNode {
  id: string; kind: NodeKind; style: Style; children: NativeNode[];
  text?: string; src?: string; fit?: "cover" | "contain"; disabled?: boolean;
  value?: string; placeholder?: string;
  control?: Control;
  modal?: boolean; focusable?: boolean;
  dragRegion?: boolean;
  windowAction?: "minimize" | "toggleMaximize" | "close";
}
export interface WindowOptions {
  title: string; width: number; height: number; minWidth: number; minHeight: number;
  background: string; decorations: boolean; resizable: boolean; debug?: boolean;
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
  control?: Control;
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
  | { type: "change"; id: string; value: string }
  | { type: "valueChange"; id: string; value: number }
  | { type: "hover"; id: string; entered: boolean }
  | { type: "error"; message: string }
  | { type: "inspect"; requestId: string; snapshot: Snapshot }
  | { type: "captured"; requestId: string; path: string }
  | { type: "frame"; frames: number };
