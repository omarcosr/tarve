/**
 * Draws the launcher icons of the examples that have none of their own (`bun scripts/example-icons.ts`):
 * a rounded square with a gradient and a white line glyph on the 24-unit Lucide grid, like pulse/ and widget/.
 */
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { encodePng } from "../packages/core/src/png";

type P = [number, number];
type RGB = [number, number, number];
type Shape =
  | { kind: "stroke"; points: P[]; closed?: boolean; color?: (x: number, y: number) => RGB }
  | { kind: "arc"; center: P; radius: number; from: number; to: number; color?: (x: number, y: number) => RGB }
  | { kind: "fill"; points: P[]; round?: number };

const SIZE = 256;
const MARGIN = 12;
const CORNER = 44;
const SCALE = 6;
const OFFSET = SIZE / 2 - 12 * SCALE;
const STROKE = 2.2 * SCALE;
const WHITE: RGB = [255, 255, 255];

const hex = (value: string): RGB => [0, 2, 4].map(index => Number.parseInt(value.slice(1 + index, 3 + index), 16)) as RGB;
const mix = (a: RGB, b: RGB, t: number): RGB => a.map((channel, index) => channel + (b[index]! - channel) * t) as RGB;
const clamp = (value: number) => Math.min(1, Math.max(0, value));
const grid = ([x, y]: P): P => [OFFSET + x * SCALE, OFFSET + y * SCALE];

function arcPoints(cx: number, cy: number, r: number, from: number, to: number, steps = 8): P[] {
  return Array.from({ length: steps + 1 }, (_, index) => {
    const angle = (from + (to - from) * index / steps) * Math.PI / 180;
    return [cx + r * Math.cos(angle), cy + r * Math.sin(angle)];
  });
}

/** A rounded rectangle outline on the grid, clockwise from the top-left corner's end. */
function roundedRect(x: number, y: number, w: number, h: number, r: number): P[] {
  return [
    ...arcPoints(x + w - r, y + r, r, -90, 0),
    ...arcPoints(x + w - r, y + h - r, r, 0, 90),
    ...arcPoints(x + r, y + h - r, r, 90, 180),
    ...arcPoints(x + r, y + r, r, 180, 270),
  ];
}

function segment(px: number, py: number, [ax, ay]: P, [bx, by]: P): number {
  const [dx, dy] = [bx - ax, by - ay];
  const t = clamp(((px - ax) * dx + (py - ay) * dy) / (dx * dx + dy * dy || 1));
  return Math.hypot(px - ax - dx * t, py - ay - dy * t);
}

/** Signed distance to a polygon: negative inside. */
function polygon(px: number, py: number, points: P[]): number {
  let distance = Infinity;
  let inside = false;
  for (let index = 0, previous = points.length - 1; index < points.length; previous = index++) {
    const [a, b] = [points[index]!, points[previous]!];
    distance = Math.min(distance, segment(px, py, a, b));
    if ((a[1] > py) !== (b[1] > py) && px < (b[0] - a[0]) * (py - a[1]) / (b[1] - a[1]) + a[0]) inside = !inside;
  }
  return inside ? -distance : distance;
}

function roundedBox(px: number, py: number): number {
  const half = SIZE / 2 - MARGIN;
  const [qx, qy] = [Math.abs(px - SIZE / 2) - half + CORNER, Math.abs(py - SIZE / 2) - half + CORNER];
  return Math.hypot(Math.max(qx, 0), Math.max(qy, 0)) + Math.min(Math.max(qx, qy), 0) - CORNER;
}

function arcDistance(px: number, py: number, center: P, radius: number, from: number, to: number): number {
  const [cx, cy] = grid(center);
  const r = radius * SCALE;
  let angle = Math.atan2(py - cy, px - cx) * 180 / Math.PI;
  while (angle < from) angle += 360;
  if (angle <= to) return Math.abs(Math.hypot(px - cx, py - cy) - r);
  const end = (degrees: number): P => [cx + r * Math.cos(degrees * Math.PI / 180), cy + r * Math.sin(degrees * Math.PI / 180)];
  return Math.min(Math.hypot(px - end(from)[0], py - end(from)[1]), Math.hypot(px - end(to)[0], py - end(to)[1]));
}

function draw(background: [string, string], shapes: Shape[]): Uint8Array {
  const [top, bottom] = background.map(hex) as [RGB, RGB];
  const rgba = new Uint8Array(SIZE * SIZE * 4);
  const scaled = shapes.map(shape => shape.kind === "arc" ? shape : { ...shape, points: shape.points.map(grid) });
  for (let y = 0; y < SIZE; y++) {
    for (let x = 0; x < SIZE; x++) {
      const [px, py] = [x + 0.5, y + 0.5];
      const alpha = clamp(0.5 - roundedBox(px, py));
      if (!alpha) continue;
      let color = mix(top, bottom, clamp((px + py) / (2 * SIZE)));
      for (const shape of scaled) {
        let coverage: number;
        if (shape.kind === "fill") coverage = clamp(0.5 - (polygon(px, py, shape.points) - (shape.round ?? 0) * SCALE));
        else {
          let distance: number;
          if (shape.kind === "arc") distance = arcDistance(px, py, shape.center, shape.radius, shape.from, shape.to);
          else {
            distance = Infinity;
            const count = shape.closed ? shape.points.length : shape.points.length - 1;
            for (let index = 0; index < count; index++) {
              distance = Math.min(distance, segment(px, py, shape.points[index]!, shape.points[(index + 1) % shape.points.length]!));
            }
          }
          coverage = clamp(STROKE / 2 - distance + 0.5);
        }
        if (coverage) color = mix(color, shape.kind !== "fill" && shape.color ? shape.color(px, py) : WHITE, coverage);
      }
      const offset = (y * SIZE + x) * 4;
      rgba.set([...color.map(Math.round), Math.round(alpha * 255)], offset);
    }
  }
  return encodePng(rgba, SIZE, SIZE);
}

const sweep = (stops: string[]) => (x: number): RGB => {
  const t = clamp((x - OFFSET) / (24 * SCALE)) * (stops.length - 1);
  const index = Math.min(stops.length - 2, Math.floor(t));
  return mix(hex(stops[index]!), hex(stops[index + 1]!), t - index);
};
const gauge = sweep(["#2dd4bf", "#a3e635", "#f87171"]);

export const ICONS: Record<string, Uint8Array> = {
  fps: draw(["#26262e", "#17171c"], [
    { kind: "arc", center: [12, 13], radius: 10, from: 141, to: 399, color: gauge },
    { kind: "stroke", points: [[12, 15], [16.5, 10.5]] },
  ]),
  tray: draw(["#3b82f6", "#06b6d4"], [
    { kind: "stroke", points: [[22, 12], [16, 12], [14, 15], [10, 15], [8, 12], [2, 12]] },
    {
      kind: "stroke", closed: true, points: [
        [7.24, 4], [16.76, 4], [18.55, 5.11], [22, 12],
        ...arcPoints(20, 18, 2, 0, 90), ...arcPoints(4, 18, 2, 90, 180), [2, 12], [5.45, 5.11],
      ],
    },
  ]),
  video: draw(["#f43f5e", "#f97316"], [
    { kind: "stroke", closed: true, points: roundedRect(2, 5, 20, 14, 3) },
    { kind: "fill", points: [[10.2, 9.2], [15, 12], [10.2, 14.8]], round: 0.5 },
  ]),
  intrinsics: draw(["#14b8a6", "#22c55e"], [
    { kind: "stroke", closed: true, points: [[12, 3], [16.2, 10], [7.8, 10]] },
    { kind: "stroke", closed: true, points: roundedRect(3, 14, 7, 7, 1) },
    { kind: "arc", center: [17.5, 17.5], radius: 3.5, from: 0, to: 360 },
  ]),
  "rich-content": draw(["#f59e0b", "#ea580c"], [
    {
      kind: "stroke", closed: true, points: [
        [14, 2], [20, 8], ...arcPoints(18, 20, 2, 0, 90), ...arcPoints(6, 20, 2, 90, 180), ...arcPoints(6, 4, 2, 180, 270),
      ],
    },
    { kind: "stroke", points: [[14, 2], [14, 8], [20, 8]] },
    { kind: "stroke", points: [[8, 9], [10, 9]] },
    { kind: "stroke", points: [[8, 13], [16, 13]] },
    { kind: "stroke", points: [[8, 17], [16, 17]] },
  ]),
  motion: draw(["#ec4899", "#8b5cf6"], [
    { kind: "arc", center: [16, 12], radius: 5, from: 0, to: 360 },
    { kind: "stroke", points: [[4, 8], [9, 8]] },
    { kind: "stroke", points: [[2, 12], [8, 12]] },
    { kind: "stroke", points: [[4, 16], [9, 16]] },
  ]),
};

if (import.meta.main) {
  const examples = join(import.meta.dir, "..", "examples");
  for (const [name, png] of Object.entries(ICONS)) writeFileSync(join(examples, name, "icon.png"), png);
}
