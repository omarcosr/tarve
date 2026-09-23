import type { Style } from "../../protocol/src/index";
export type Child = VNode | string | number | boolean | null | undefined | Child[];
export interface BaseProps { id?: string; key?: string | number; children?: Child; style?: Style; rovingGroup?: boolean }
export type Component<P = any> = (props: P) => VNode;
export interface VNode { type: Component | string; props: Record<string, any>; key?: string | number }
export function jsx(type: VNode["type"], props: Record<string, any> | null, key?: string | number): VNode {
  return { type, props: props ?? {}, key };
}
export const jsxs = jsx;
export const jsxDEV = jsx;
export function Fragment(props: { children?: Child }): VNode { return jsx("fragment", props); }
export namespace JSX {
  export type Element = VNode;
  export interface ElementChildrenAttribute { children: {} }
  export interface IntrinsicAttributes { key?: string | number }
  export interface IntrinsicElements {}
}
