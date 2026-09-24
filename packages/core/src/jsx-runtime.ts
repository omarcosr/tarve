import type { Control, Style, SvgNode } from "../../protocol/src/index";
export type Child = VNode | string | number | boolean | null | undefined | Child[];
export interface BaseProps { id?: string; key?: string | number; children?: Child; style?: Style; rovingGroup?: boolean }
export type IntrinsicStyle = Style & {
  /** CSS-like alias for Tarve's native `direction`. */
  flexDirection?: Style["direction"];
  /** CSS-like alias for Tarve's native `background`. */
  backgroundColor?: string;
  /** CSS-like alias for Tarve's native `foreground`. */
  color?: string;
};
export type DivStyle = IntrinsicStyle;
export interface DivProps extends Omit<BaseProps, "style"> {
  style?: IntrinsicStyle;
  gap?: number;
  padding?: Style["padding"];
  flex?: number;
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
}
export type ParagraphProps = SpanProps;
export interface ImgProps extends Omit<BaseProps, "style" | "children"> {
  style?: IntrinsicStyle;
  src: string;
  width?: number;
  height?: number;
  fit?: "cover" | "contain";
}
export type IntrinsicInputType = "text" | "password" | "email" | "number" | "search" | "tel" | "url";
export interface IntrinsicInputProps extends Omit<BaseProps, "style" | "children"> {
  style?: IntrinsicStyle;
  type?: IntrinsicInputType;
  value?: string;
  placeholder?: string;
  disabled?: boolean;
  onChange?: (value: string) => void;
}
export interface IntrinsicTextareaProps extends Omit<BaseProps, "style" | "children"> {
  style?: IntrinsicStyle;
  value?: string;
  placeholder?: string;
  disabled?: boolean;
  onChange?: (value: string) => void;
}
export interface IntrinsicButtonProps extends Omit<BaseProps, "style"> {
  style?: IntrinsicStyle;
  variant?: "default" | "secondary" | "outline" | "ghost" | "destructive";
  size?: "sm" | "default" | "lg";
  disabled?: boolean;
  control?: Control;
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
export namespace JSX {
  export type Element = VNode;
  export interface ElementChildrenAttribute { children: {} }
  export interface IntrinsicAttributes { key?: string | number }
  export interface IntrinsicElements {
    div: DivProps;
    span: SpanProps;
    p: ParagraphProps;
    img: ImgProps;
    input: IntrinsicInputProps;
    textarea: IntrinsicTextareaProps;
    button: IntrinsicButtonProps;
    svg: IntrinsicSvgProps;
  }
}
