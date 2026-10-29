/** Value types of the protocol: lengths, SVG nodes, insets, shadows, gradients, highlights. */
/** px, a percentage, `auto`, or a CSS viewport unit (`50vh`, `100vw`, `10vmin`, `10vmax`, `100dvh`): resolved to px for the window, again on resize. */
export type Length = number | `${number}%` | "auto" | ViewportLength;
/** A CSS viewport unit: resolved to px for the window when the tree compiles, again on resize. */
export type ViewportLength = `${number}${"vh" | "vw" | "vmin" | "vmax" | "dvh" | "svh" | "lvh" | "dvw" | "svw" | "lvw"}`;

export type NodeKind = "window" | "titlebar" | "view" | "row" | "column" | "text" | "markdown" | "code" | "diff" | "button" | "image" | "svg" | "scroll" | "input" | "textarea" | "pressable" | "slider" | "splitter" | "video";
export type SvgElementName = "path" | "circle" | "ellipse" | "g" | "line" | "polygon" | "polyline" | "rect";
export type SvgAttributeValue = string | number;
export type SvgAttributes = Record<string, SvgAttributeValue>;
export type SvgNode =
  | readonly [SvgElementName, SvgAttributes]
  | readonly [SvgElementName, SvgAttributes, readonly SvgNode[]];
export type Insets = number | { top?: number; right?: number; bottom?: number; left?: number };
/** A margin side: px, a percentage of the container, or `"auto"` (CSS auto margins centre a box or push it aside). */
export type MarginSide = number | `${number}%` | "auto" | ViewportLength;
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
 * `xPercent`/`yPercent` translate by percents of the box's own width/height (CSS `translateX(100%)`),
 * added to `x`/`y`.
 */
export interface Transform {
  x?: number; y?: number; xPercent?: number; yPercent?: number; scale?: number; scaleX?: number; scaleY?: number;
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
