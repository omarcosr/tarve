import { type BaseProps, type VNode } from "../jsx-runtime";
import { theme } from "../theme";
import { Svg, type SvgNode } from "./svg";

export type IconName =
  | "check" | "x" | "plus" | "minus"
  | "chevron-down" | "chevron-up" | "chevron-right" | "chevron-left"
  | "search" | "info"
  | "house" | "settings" | "user" | "bell" | "heart" | "star"
  | "download" | "trash-2" | "folder" | "mail";

export interface IconProps extends BaseProps {
  name?: IconName;
  iconNode?: readonly SvgNode[];
  size?: number;
  color?: string;
  strokeWidth?: number;
}

const icons: Record<IconName, readonly SvgNode[]> = {
  check: [["path", { d: "M20 6 9 17l-5-5" }]],
  x: [["path", { d: "M18 6 6 18M6 6l12 12" }]],
  plus: [["path", { d: "M5 12h14M12 5v14" }]],
  minus: [["path", { d: "M5 12h14" }]],
  "chevron-down": [["path", { d: "m6 9 6 6 6-6" }]],
  "chevron-up": [["path", { d: "m18 15-6-6-6 6" }]],
  "chevron-right": [["path", { d: "m9 18 6-6-6-6" }]],
  "chevron-left": [["path", { d: "m15 18-6-6 6-6" }]],
  search: [["circle", { cx: 11, cy: 11, r: 8 }], ["path", { d: "m21 21-4.3-4.3" }]],
  info: [["circle", { cx: 12, cy: 12, r: 10 }], ["path", { d: "M12 16v-4M12 8h.01" }]],
  house: [["path", { d: "M3 10.8 12 3l9 7.8V21h-6v-7H9v7H3z" }]],
  settings: [
    ["circle", { cx: 12, cy: 12, r: 3 }],
    ["path", { d: "M12 2v2.2M12 19.8V22M4.9 4.9l1.6 1.6M17.5 17.5l1.6 1.6M2 12h2.2M19.8 12H22M4.9 19.1l1.6-1.6M17.5 6.5l1.6-1.6" }],
  ],
  user: [["circle", { cx: 12, cy: 8, r: 4 }], ["path", { d: "M4 21a8 8 0 0 1 16 0" }]],
  bell: [["path", { d: "M18 8a6 6 0 0 0-12 0c0 7-3 7-3 9h18c0-2-3-2-3-9M10 21h4" }]],
  heart: [["path", { d: "M20.8 4.6a5.5 5.5 0 0 0-7.8 0L12 5.7l-1-1.1a5.5 5.5 0 0 0-7.8 7.8L12 21l8.8-8.6a5.5 5.5 0 0 0 0-7.8z" }]],
  star: [["path", { d: "m12 2 3.1 6.3 6.9 1-5 4.8 1.2 6.9-6.2-3.3L5.8 21 7 14.1l-5-4.8 6.9-1z" }]],
  download: [["path", { d: "M12 3v12m0 0 4-4m-4 4-4-4M4 21h16" }]],
  "trash-2": [["path", { d: "M3 6h18M8 6V4h8v2m-9 0 1 15h8l1-15M10 10v7M14 10v7" }]],
  folder: [["path", { d: "M3 5h6l2 2h10v12H3z" }]],
  mail: [["rect", { x: 3, y: 5, width: 18, height: 14, rx: 2 }], ["path", { d: "m3 7 9 6 9-6" }]],
};

export function Icon({ name, iconNode, size = 16, color = theme.colors.foreground, strokeWidth = 1.75, style, ...props }: IconProps): VNode {
  const nodes = iconNode ?? (name ? icons[name] : undefined);
  if (!nodes) throw new Error("Icon requires either name or iconNode.");
  return Svg({ ...props, size, color, strokeWidth, nodes, viewBox: [0, 0, 24, 24], fill: "none", stroke: "currentColor", style });
}

export { icons as iconNodes };
