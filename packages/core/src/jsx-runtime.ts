import type { Control, MotionProperty, MotionValues, StateStyle, Style, SvgNode, TextHighlight } from "../../protocol/src/index";
import type { ImageSource } from "./components/image";
export type Child = VNode | string | number | boolean | null | undefined | Child[];
/** Clipboard content delivered to the focused element when the clipboard holds no text. */
export type PastePayload =
  | { kind: "files"; files: string[] }
  | { kind: "image"; width: number; height: number; rgba: Uint8Array };
export interface DragPosition { x: number; y: number }
/** Pointer position while dragging and the drop target currently under it. */
export interface DragMoveEvent extends DragPosition { over: string | null }
/** Fired once per drag: `target` is the accepting drop target, or null. */
export interface DragEndEvent extends DragPosition { target: string | null; cancelled: boolean }
/** Delivered to the drop target; `source` is the dragged node id. */
export interface DropEvent extends DragPosition { source: string }
/** Makes a node a drop target. Any of the drop handlers implies `dropTarget`. */
export interface DropTargetProps {
  dropTarget?: boolean;
  onDragEnter?: (source: string) => void;
  onDragLeave?: (source: string) => void;
  onDrop?: (event: DropEvent) => void;
}
/** Pointer drag on an interactive node. A press only becomes a drag after the
 * pointer travels 4px, so the node keeps its click; Escape or window blur cancels. */
export interface DraggableProps {
  draggable?: boolean;
  onDragStart?: (position: DragPosition) => void;
  onDragMove?: (event: DragMoveEvent) => void;
  onDragEnd?: (event: DragEndEvent) => void;
}
export interface BaseProps {
  id?: string;
  key?: string | number;
  children?: Child;
  style?: Style;
  rovingGroup?: boolean;
  highlight?: TextHighlight;
  onHighlight?: (event: { matchCount: number }) => void;
  /** Initial numeric values for a native enter transition. */
  motionFrom?: MotionValues;
  onTransitionEnd?: (event: { property: MotionProperty }) => void;
  /** Receives non-text clipboard content (files or a bitmap) pasted while focused. */
  onPaste?: (payload: PastePayload) => void;
}
export type IntrinsicStateStyle = StateStyle & {
  backgroundColor?: string;
  color?: string;
};
export type IntrinsicStyle = Omit<Style, "hover" | "focus" | "focusVisible" | "active" | "disabled"> & {
  /** CSS-like alias for Tarve's native `direction`. */
  flexDirection?: Style["direction"];
  /** CSS-like alias for Tarve's native `background`. */
  backgroundColor?: string;
  /** CSS-like alias for Tarve's native `foreground`. */
  color?: string;
  hover?: IntrinsicStateStyle;
  focus?: IntrinsicStateStyle;
  focusVisible?: IntrinsicStateStyle;
  active?: IntrinsicStateStyle;
  disabled?: IntrinsicStateStyle;
};
export type DivStyle = IntrinsicStyle;
export interface DivProps extends Omit<BaseProps, "style">, DropTargetProps {
  style?: IntrinsicStyle;
  gap?: number;
  padding?: Style["padding"];
  flex?: number | string;
  align?: Style["align"];
  justify?: Style["justify"];
  portal?: boolean;
  dismissOnOutside?: boolean;
  onOutsideClick?: () => void;
  dragRegion?: boolean;
  windowAction?: "minimize" | "toggleMaximize" | "close";
  focusable?: boolean;
  onClick?: () => void;
  onContextMenu?: (position: { x: number; y: number }) => void;
  onHover?: (entered: boolean) => void;
  onMouseEnter?: () => void;
  onMouseLeave?: () => void;
  onKeyDown?: (key: string) => void;
  onBlur?: () => void;
  onEscape?: () => void;
}
export interface SpanProps extends Omit<BaseProps, "style"> {
  style?: IntrinsicStyle;
  size?: number;
  weight?: number;
  color?: string;
  /** Inside a paragraph the span becomes a click target. */
  onClick?: () => void;
}
export type ParagraphProps = SpanProps;
export type HeadingProps = SpanProps;
export interface IntrinsicLabelProps extends Omit<BaseProps, "style"> {
  style?: IntrinsicStyle;
  htmlFor?: string;
  required?: boolean;
  disabled?: boolean;
  onClick?: () => void;
}
export interface ImgProps extends Omit<BaseProps, "style" | "children"> {
  style?: IntrinsicStyle;
  src: ImageSource;
  width?: number;
  height?: number;
  fit?: "cover" | "contain";
}
export type IntrinsicInputType = "text" | "password" | "email" | "number" | "search" | "tel" | "url" | "checkbox" | "radio" | "range" | "date" | "file" | "color" | "time";
export interface IntrinsicInputProps extends Omit<BaseProps, "style" | "children"> {
  style?: IntrinsicStyle;
  type?: IntrinsicInputType;
  /** Form field name: `<form onSubmit>` receives values keyed by it. */
  name?: string;
  required?: boolean;
  /** Initial value of an uncontrolled field. */
  defaultValue?: string;
  /** checkbox and radio. */
  checked?: boolean;
  defaultChecked?: boolean;
  /** Visible label of a checkbox, radio or range. */
  label?: string;
  ariaLabel?: string;
  /** range and date. */
  min?: number | string;
  max?: number | string;
  step?: number;
  /** file: `.png,.jpg` filters and multiple selection; onFiles receives every path. */
  accept?: string;
  multiple?: boolean;
  onFiles?: (paths: string[]) => void;
  onCheckedChange?: (checked: boolean) => void;
  value?: string;
  placeholder?: string;
  disabled?: boolean;
  onChange?: (value: string) => void;
  onSubmit?: (value: string) => void;
}
export interface IntrinsicTextareaProps extends Omit<BaseProps, "style" | "children"> {
  style?: IntrinsicStyle;
  value?: string;
  placeholder?: string;
  disabled?: boolean;
  submitOnEnter?: boolean;
  onChange?: (value: string) => void;
  onSubmit?: (value: string) => void;
}
export interface IntrinsicButtonProps extends Omit<BaseProps, "style"> {
  style?: IntrinsicStyle;
  variant?: "default" | "secondary" | "outline" | "ghost" | "destructive";
  size?: "sm" | "default" | "lg";
  disabled?: boolean;
  control?: Control;
  /** Inside a `<form>` a button submits unless `type="button"`. */
  type?: "submit" | "button" | "reset";
  onClick?: () => void;
  onHover?: (hovered: boolean) => void;
}
export interface IntrinsicAnchorProps extends Omit<BaseProps, "style"> {
  style?: IntrinsicStyle;
  href: string;
  ariaLabel?: string;
  disabled?: boolean;
  onClick?: () => void;
  onHover?: (hovered: boolean) => void;
}
export interface IntrinsicSvgProps extends Omit<BaseProps, "style"> {
  style?: IntrinsicStyle;
  size?: number;
  width?: number;
  height?: number;
  viewBox?: string | readonly [number, number, number, number];
  color?: string;
  fill?: string;
  stroke?: string;
  strokeWidth?: number;
  strokeLinecap?: "butt" | "round" | "square";
  strokeLinejoin?: "miter" | "round" | "bevel";
  nodes?: readonly SvgNode[];
}
export interface IntrinsicSvgElementProps {
  key?: string | number;
  id?: string;
  fill?: string;
  fillRule?: "nonzero" | "evenodd";
  fillOpacity?: number | string;
  stroke?: string;
  strokeWidth?: number | string;
  strokeLinecap?: "butt" | "round" | "square";
  strokeLinejoin?: "miter" | "round" | "bevel";
  strokeOpacity?: number | string;
  strokeDasharray?: number | string;
  strokeDashoffset?: number | string;
  opacity?: number | string;
  transform?: string;
  vectorEffect?: string;
}
export interface IntrinsicSvgPathProps extends IntrinsicSvgElementProps { d: string }
export interface IntrinsicSvgCircleProps extends IntrinsicSvgElementProps { cx: number | string; cy: number | string; r: number | string }
export interface IntrinsicSvgEllipseProps extends IntrinsicSvgElementProps { cx: number | string; cy: number | string; rx: number | string; ry: number | string }
export interface IntrinsicSvgLineProps extends IntrinsicSvgElementProps { x1: number | string; y1: number | string; x2: number | string; y2: number | string }
export interface IntrinsicSvgPolylineProps extends IntrinsicSvgElementProps { points: string }
export interface IntrinsicSvgPolygonProps extends IntrinsicSvgElementProps { points: string }
export interface IntrinsicSvgRectProps extends IntrinsicSvgElementProps {
  x?: number | string;
  y?: number | string;
  width: number | string;
  height: number | string;
  rx?: number | string;
  ry?: number | string;
}
export interface IntrinsicSvgGroupProps extends IntrinsicSvgElementProps { children?: Child }
export interface IntrinsicOptionProps {
  key?: string | number;
  value: string;
  disabled?: boolean;
  children?: Child;
}
export interface IntrinsicSelectProps extends Omit<BaseProps, "style"> {
  style?: IntrinsicStyle;
  value?: string;
  placeholder?: string;
  disabled?: boolean;
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  onChange?: (value: string) => void;
  onValueChange?: (value: string) => void;
}
export interface IntrinsicProgressProps extends Omit<BaseProps, "style" | "children"> {
  style?: IntrinsicStyle;
  value: number;
  max?: number;
  label?: string;
}
export interface IntrinsicHrProps extends Omit<BaseProps, "style" | "children"> {
  style?: IntrinsicStyle;
  orientation?: "horizontal" | "vertical";
}
export type Component<P = any> = (props: P) => VNode;
export interface VNode { type: Component | string; props: Record<string, any>; key?: string | number }
const NATIVE_VNODE = Symbol("tarve.native-vnode");
export function jsx(type: VNode["type"], props: Record<string, any> | null, key?: string | number): VNode {
  return { type, props: props ?? {}, key };
}
export function _nativeJsx(type: string, props: Record<string, any> | null, key?: string | number): VNode {
  const vnode = jsx(type, props, key) as VNode & { [NATIVE_VNODE]?: true };
  vnode[NATIVE_VNODE] = true;
  return vnode;
}
export function _isNativeVNode(vnode: VNode): boolean {
  return (vnode as VNode & { [NATIVE_VNODE]?: true })[NATIVE_VNODE] === true;
}
export const jsxs = jsx;
export const jsxDEV = jsx;
export function Fragment(props: { children?: Child }): VNode { return jsx("fragment", props); }
export interface IntrinsicBlockProps extends Omit<BaseProps, "style"> { style?: IntrinsicStyle }
export interface IntrinsicFormProps extends IntrinsicBlockProps {
  /** Enter in a field or a submit button: named values, after `required` fields are filled. */
  onSubmit?: (values: Record<string, string | boolean | string[]>) => void;
  /** A required field was empty; receives its name. */
  onInvalid?: (name: string) => void;
  ariaLabel?: string;
}
export interface IntrinsicListProps extends IntrinsicBlockProps { start?: number }
export interface IntrinsicDetailsProps extends IntrinsicBlockProps { open?: boolean; onToggle?: (open: boolean) => void }
export interface IntrinsicCellProps extends IntrinsicBlockProps { colSpan?: number; rowSpan?: number }
export interface IntrinsicMeterProps extends IntrinsicBlockProps { value: number; min?: number; max?: number; ariaLabel?: string; title?: string }
export namespace JSX {
  export type Element = VNode;
  export interface ElementChildrenAttribute { children: {} }
  export interface IntrinsicAttributes { key?: string | number }
  export interface IntrinsicElements {
    div: DivProps;
    form: IntrinsicFormProps;
    pre: SpanProps;
    blockquote: IntrinsicBlockProps;
    meter: IntrinsicMeterProps;
    abbr: SpanProps & { title?: string };
    fieldset: IntrinsicBlockProps;
    legend: IntrinsicBlockProps;
    ul: IntrinsicListProps;
    ol: IntrinsicListProps;
    li: IntrinsicBlockProps;
    dl: IntrinsicBlockProps;
    dt: IntrinsicBlockProps;
    dd: IntrinsicBlockProps;
    table: IntrinsicBlockProps;
    caption: IntrinsicBlockProps;
    thead: IntrinsicBlockProps;
    tbody: IntrinsicBlockProps;
    tfoot: IntrinsicBlockProps;
    tr: IntrinsicBlockProps;
    th: IntrinsicCellProps;
    td: IntrinsicCellProps;
    details: IntrinsicDetailsProps;
    summary: IntrinsicBlockProps;
    span: SpanProps;
    strong: SpanProps;
    b: SpanProps;
    em: SpanProps;
    i: SpanProps;
    u: SpanProps;
    s: SpanProps;
    del: SpanProps;
    ins: SpanProps;
    code: SpanProps;
    kbd: SpanProps;
    samp: SpanProps;
    var: SpanProps;
    cite: SpanProps;
    dfn: SpanProps;
    mark: SpanProps;
    small: SpanProps;
    sub: SpanProps;
    sup: SpanProps;
    br: Omit<SpanProps, "children">;
    p: ParagraphProps;
    h1: HeadingProps;
    h2: HeadingProps;
    h3: HeadingProps;
    h4: HeadingProps;
    h5: HeadingProps;
    h6: HeadingProps;
    label: IntrinsicLabelProps;
    img: ImgProps;
    input: IntrinsicInputProps;
    textarea: IntrinsicTextareaProps;
    button: IntrinsicButtonProps;
    a: IntrinsicAnchorProps;
    svg: IntrinsicSvgProps;
    path: IntrinsicSvgPathProps;
    circle: IntrinsicSvgCircleProps;
    ellipse: IntrinsicSvgEllipseProps;
    line: IntrinsicSvgLineProps;
    polyline: IntrinsicSvgPolylineProps;
    polygon: IntrinsicSvgPolygonProps;
    rect: IntrinsicSvgRectProps;
    g: IntrinsicSvgGroupProps;
    select: IntrinsicSelectProps;
    option: IntrinsicOptionProps;
    progress: IntrinsicProgressProps;
    hr: IntrinsicHrProps;
  }
}
