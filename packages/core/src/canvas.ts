import type { VNode } from "./jsx-runtime";
import { _nativeJsx } from "./jsx-runtime";
import { Text } from "./components/text";
import { View } from "./components/layout";
import { canonicalizeIntrinsicStyle } from "./intrinsic-style";

/**
 * `<canvas onDraw={ctx => …}>`: a CanvasRenderingContext2D recorder. Every render
 * replays `onDraw` into a fresh context; paths, fills, strokes, gradients and
 * transforms become one native SVG scene, and `fillText` becomes positioned
 * native text, so the drawing is vector-sharp at any DPI.
 */

type Matrix = [number, number, number, number, number, number];
interface CanvasState {
  fillStyle: string | CanvasGradient;
  strokeStyle: string | CanvasGradient;
  lineWidth: number;
  lineCap: "butt" | "round" | "square";
  lineJoin: "miter" | "round" | "bevel";
  miterLimit: number;
  globalAlpha: number;
  font: string;
  textAlign: "start" | "end" | "left" | "right" | "center";
  textBaseline: "top" | "hanging" | "middle" | "alphabetic" | "ideographic" | "bottom";
  transform: Matrix;
  lineDash: number[];
}

export class CanvasGradient {
  readonly stops: [number, string][] = [];
  constructor(readonly id: string, readonly kind: "linear" | "radial", readonly coords: number[]) {}
  addColorStop(offset: number, color: string): void {
    if (!(offset >= 0 && offset <= 1)) throw new RangeError("addColorStop offset must be between 0 and 1");
    this.stops.push([offset, color]);
  }
}

export interface CanvasText { text: string; x: number; y: number; font: string; color: string; align: CanvasState["textAlign"]; baseline: CanvasState["textBaseline"]; alpha: number; stroke: boolean; lineWidth: number }

const fmt = (n: number) => (Math.round(n * 1000) / 1000).toString();
const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;");

export class CanvasRenderingContext2D {
  private state: CanvasState = {
    fillStyle: "#000000", strokeStyle: "#000000", lineWidth: 1, lineCap: "butt", lineJoin: "miter", miterLimit: 10,
    globalAlpha: 1, font: "10px sans-serif", textAlign: "start", textBaseline: "alphabetic", transform: [1, 0, 0, 1, 0, 0], lineDash: [],
  };
  private stack: CanvasState[] = [];
  private path = "";
  private start: [number, number] | null = null;
  private current: [number, number] | null = null;
  /** SVG body and definitions, in paint order. */
  readonly elements: string[] = [];
  readonly defs: string[] = [];
  readonly texts: CanvasText[] = [];
  private gradients = 0;

  constructor(readonly width: number, readonly height: number) {}

  get fillStyle() { return this.state.fillStyle; } set fillStyle(v) { this.state.fillStyle = v; }
  get strokeStyle() { return this.state.strokeStyle; } set strokeStyle(v) { this.state.strokeStyle = v; }
  get lineWidth() { return this.state.lineWidth; } set lineWidth(v) { if (v > 0 && Number.isFinite(v)) this.state.lineWidth = v; }
  get lineCap() { return this.state.lineCap; } set lineCap(v) { this.state.lineCap = v; }
  get lineJoin() { return this.state.lineJoin; } set lineJoin(v) { this.state.lineJoin = v; }
  get miterLimit() { return this.state.miterLimit; } set miterLimit(v) { if (v > 0) this.state.miterLimit = v; }
  get globalAlpha() { return this.state.globalAlpha; } set globalAlpha(v) { if (v >= 0 && v <= 1) this.state.globalAlpha = v; }
  get font() { return this.state.font; } set font(v) { this.state.font = v; }
  get textAlign() { return this.state.textAlign; } set textAlign(v) { this.state.textAlign = v; }
  get textBaseline() { return this.state.textBaseline; } set textBaseline(v) { this.state.textBaseline = v; }
  setLineDash(segments: number[]): void { this.state.lineDash = segments.length % 2 ? [...segments, ...segments] : [...segments]; }
  getLineDash(): number[] { return [...this.state.lineDash]; }

  save(): void { this.stack.push({ ...this.state, transform: [...this.state.transform] as Matrix, lineDash: [...this.state.lineDash] }); }
  restore(): void { const state = this.stack.pop(); if (state) this.state = state; }

  setTransform(a: number, b: number, c: number, d: number, e: number, f: number): void { this.state.transform = [a, b, c, d, e, f]; }
  resetTransform(): void { this.state.transform = [1, 0, 0, 1, 0, 0]; }
  transform(a: number, b: number, c: number, d: number, e: number, f: number): void {
    const [A, B, C, D, E, F] = this.state.transform;
    this.state.transform = [A * a + C * b, B * a + D * b, A * c + C * d, B * c + D * d, A * e + C * f + E, B * e + D * f + F];
  }
  translate(x: number, y: number): void { this.transform(1, 0, 0, 1, x, y); }
  scale(x: number, y: number): void { this.transform(x, 0, 0, y, 0, 0); }
  rotate(angle: number): void { const c = Math.cos(angle), s = Math.sin(angle); this.transform(c, s, -s, c, 0, 0); }
  getTransform(): Matrix { return [...this.state.transform] as Matrix; }

  private point(x: number, y: number): [number, number] {
    const [a, b, c, d, e, f] = this.state.transform;
    return [a * x + c * y + e, b * x + d * y + f];
  }
  private scaleFactor(): number { const [a, b, c, d] = this.state.transform; return Math.sqrt(Math.abs(a * d - b * c)); }

  beginPath(): void { this.path = ""; this.start = null; this.current = null; }
  moveTo(x: number, y: number): void { const p = this.point(x, y); this.path += `M${fmt(p[0])} ${fmt(p[1])}`; this.start = p; this.current = p; }
  lineTo(x: number, y: number): void {
    if (!this.current) return this.moveTo(x, y);
    const p = this.point(x, y); this.path += `L${fmt(p[0])} ${fmt(p[1])}`; this.current = p;
  }
  closePath(): void { if (this.current) { this.path += "Z"; this.current = this.start; } }
  quadraticCurveTo(cx: number, cy: number, x: number, y: number): void {
    if (!this.current) this.moveTo(cx, cy);
    const c = this.point(cx, cy), p = this.point(x, y);
    this.path += `Q${fmt(c[0])} ${fmt(c[1])} ${fmt(p[0])} ${fmt(p[1])}`; this.current = p;
  }
  bezierCurveTo(c1x: number, c1y: number, c2x: number, c2y: number, x: number, y: number): void {
    if (!this.current) this.moveTo(c1x, c1y);
    const a = this.point(c1x, c1y), b = this.point(c2x, c2y), p = this.point(x, y);
    this.path += `C${fmt(a[0])} ${fmt(a[1])} ${fmt(b[0])} ${fmt(b[1])} ${fmt(p[0])} ${fmt(p[1])}`; this.current = p;
  }
  rect(x: number, y: number, w: number, h: number): void {
    this.moveTo(x, y); this.lineTo(x + w, y); this.lineTo(x + w, y + h); this.lineTo(x, y + h); this.closePath();
    this.moveTo(x, y);
  }
  roundRect(x: number, y: number, w: number, h: number, radius: number | number[] = 0): void {
    const r = Math.max(0, Math.min(Array.isArray(radius) ? radius[0] ?? 0 : radius, Math.abs(w) / 2, Math.abs(h) / 2));
    if (r === 0) return this.rect(x, y, w, h);
    const q = Math.PI / 2;
    this.moveTo(x + r, y);
    this.lineTo(x + w - r, y); this.arc(x + w - r, y + r, r, -q, 0);
    this.lineTo(x + w, y + h - r); this.arc(x + w - r, y + h - r, r, 0, q);
    this.lineTo(x + r, y + h); this.arc(x + r, y + h - r, r, q, 2 * q);
    this.lineTo(x, y + r); this.arc(x + r, y + r, r, 2 * q, 3 * q);
    this.closePath();
    this.moveTo(x, y);
  }
  /** Arc as cubic Béziers in user space, so any transform maps it exactly. */
  ellipse(x: number, y: number, rx: number, ry: number, rotation: number, start: number, end: number, ccw = false): void {
    if (rx < 0 || ry < 0) throw new RangeError("ellipse radii must be non-negative");
    let sweep = end - start;
    const full = Math.PI * 2;
    if (!ccw && sweep < 0) sweep = (sweep % full) + full;
    if (ccw && sweep > 0) sweep = (sweep % full) - full;
    if (Math.abs(end - start) >= full) sweep = ccw ? -full : full;
    const at = (t: number): [number, number] => {
      const cx = Math.cos(t) * rx, cy = Math.sin(t) * ry;
      return [x + cx * Math.cos(rotation) - cy * Math.sin(rotation), y + cx * Math.sin(rotation) + cy * Math.cos(rotation)];
    };
    const derivative = (t: number): [number, number] => {
      const dx = -Math.sin(t) * rx, dy = Math.cos(t) * ry;
      return [dx * Math.cos(rotation) - dy * Math.sin(rotation), dx * Math.sin(rotation) + dy * Math.cos(rotation)];
    };
    const first = at(start);
    if (!this.current) this.moveTo(first[0], first[1]);
    else {
      const [px, py] = this.point(first[0], first[1]);
      if (Math.abs(px - this.current[0]) > 1e-6 || Math.abs(py - this.current[1]) > 1e-6) this.lineTo(first[0], first[1]);
    }
    const segments = Math.max(1, Math.ceil(Math.abs(sweep) / (Math.PI / 2)));
    const step = sweep / segments;
    const k = (4 / 3) * Math.tan(step / 4);
    for (let i = 0; i < segments; i++) {
      const t0 = start + step * i, t1 = t0 + step;
      const p0 = at(t0), p1 = at(t1), d0 = derivative(t0), d1 = derivative(t1);
      this.bezierCurveTo(p0[0] + k * d0[0], p0[1] + k * d0[1], p1[0] - k * d1[0], p1[1] - k * d1[1], p1[0], p1[1]);
    }
  }
  arc(x: number, y: number, r: number, start: number, end: number, ccw = false): void { this.ellipse(x, y, r, r, 0, start, end, ccw); }
  arcTo(x1: number, y1: number, x2: number, y2: number, r: number): void {
    if (r < 0) throw new RangeError("arcTo radius must be non-negative");
    if (!this.current) this.moveTo(x1, y1);
    const [a, b, c, d, e, f] = this.state.transform;
    const det = a * d - b * c;
    const [cx, cy] = this.current!;
    const x0 = (d * (cx - e) - c * (cy - f)) / det, y0 = (-b * (cx - e) + a * (cy - f)) / det;
    const l1 = Math.hypot(x0 - x1, y0 - y1), l2 = Math.hypot(x2 - x1, y2 - y1);
    if (r === 0 || l1 === 0 || l2 === 0) return this.lineTo(x1, y1);
    const u1 = [(x0 - x1) / l1, (y0 - y1) / l1] as const, u2 = [(x2 - x1) / l2, (y2 - y1) / l2] as const;
    const cross = u1[0] * u2[1] - u1[1] * u2[0];
    if (Math.abs(cross) < 1e-9) return this.lineTo(x1, y1);
    const angle = Math.acos(Math.max(-1, Math.min(1, u1[0] * u2[0] + u1[1] * u2[1])));
    const tangent = r / Math.tan(angle / 2);
    const t1 = [x1 + u1[0] * tangent, y1 + u1[1] * tangent] as const;
    const bisector = [u1[0] + u2[0], u1[1] + u2[1]] as const;
    const length = Math.hypot(bisector[0], bisector[1]);
    const distance = r / Math.sin(angle / 2);
    const center = [x1 + bisector[0] / length * distance, y1 + bisector[1] / length * distance] as const;
    const t2 = [x1 + u2[0] * tangent, y1 + u2[1] * tangent] as const;
    const start = Math.atan2(t1[1] - center[1], t1[0] - center[0]);
    const end = Math.atan2(t2[1] - center[1], t2[0] - center[0]);
    // The corner arc is always the short way round.
    let sweep = end - start;
    while (sweep > Math.PI) sweep -= 2 * Math.PI;
    while (sweep < -Math.PI) sweep += 2 * Math.PI;
    this.lineTo(t1[0], t1[1]);
    this.arc(center[0], center[1], r, start, start + sweep, sweep < 0);
  }

  createLinearGradient(x0: number, y0: number, x1: number, y1: number): CanvasGradient {
    const a = this.point(x0, y0), b = this.point(x1, y1);
    return new CanvasGradient(`g${this.gradients++}`, "linear", [...a, ...b]);
  }
  createRadialGradient(x0: number, y0: number, r0: number, x1: number, y1: number, r1: number): CanvasGradient {
    const a = this.point(x0, y0), b = this.point(x1, y1), s = this.scaleFactor();
    return new CanvasGradient(`g${this.gradients++}`, "radial", [...a, r0 * s, ...b, r1 * s]);
  }

  private paint(style: string | CanvasGradient): string {
    if (typeof style === "string") return esc(style);
    if (!this.defs.some(def => def.includes(`id="${style.id}"`))) {
      const stops = [...style.stops].sort((p, q) => p[0] - q[0]).map(([o, c]) => `<stop offset="${fmt(o)}" stop-color="${esc(c)}"/>`).join("");
      const [p, q, r, s, t, u] = style.coords.map(fmt);
      this.defs.push(style.kind === "linear"
        ? `<linearGradient id="${style.id}" gradientUnits="userSpaceOnUse" x1="${p}" y1="${q}" x2="${r}" y2="${s}">${stops}</linearGradient>`
        : `<radialGradient id="${style.id}" gradientUnits="userSpaceOnUse" fx="${p}" fy="${q}" fr="${r}" cx="${s}" cy="${t}" r="${u}">${stops}</radialGradient>`);
    }
    return `url(#${style.id})`;
  }
  private emit(path: string, fill: string | null, stroke: string | null, rule: "nonzero" | "evenodd" = "nonzero"): void {
    if (!path) return;
    const s = this.state;
    const attrs = [`d="${path}"`, `fill="${fill ?? "none"}"`];
    if (fill) attrs.push(`fill-rule="${rule}"`);
    if (stroke) {
      const width = s.lineWidth * this.scaleFactor();
      attrs.push(`stroke="${stroke}"`, `stroke-width="${fmt(width)}"`, `stroke-linecap="${s.lineCap}"`, `stroke-linejoin="${s.lineJoin}"`, `stroke-miterlimit="${fmt(s.miterLimit)}"`);
      if (s.lineDash.length) attrs.push(`stroke-dasharray="${s.lineDash.map(v => fmt(v * this.scaleFactor())).join(" ")}"`);
    }
    if (s.globalAlpha < 1) attrs.push(`opacity="${fmt(s.globalAlpha)}"`);
    this.elements.push(`<path ${attrs.join(" ")}/>`);
  }
  fill(rule: "nonzero" | "evenodd" = "nonzero"): void { this.emit(this.path, this.paint(this.state.fillStyle), null, rule); }
  stroke(): void { this.emit(this.path, null, this.paint(this.state.strokeStyle)); }
  private rectPath(x: number, y: number, w: number, h: number): string {
    const corners = [this.point(x, y), this.point(x + w, y), this.point(x + w, y + h), this.point(x, y + h)];
    return `M${corners.map(p => `${fmt(p[0])} ${fmt(p[1])}`).join("L")}Z`;
  }
  fillRect(x: number, y: number, w: number, h: number): void { this.emit(this.rectPath(x, y, w, h), this.paint(this.state.fillStyle), null); }
  strokeRect(x: number, y: number, w: number, h: number): void { this.emit(this.rectPath(x, y, w, h), null, this.paint(this.state.strokeStyle)); }
  /** Clearing the whole canvas discards what was drawn; partial clears paint nothing over earlier content. */
  clearRect(x: number, y: number, w: number, h: number): void {
    const [a, b, c, d] = this.state.transform;
    const [ox, oy] = this.point(x, y);
    if (b === 0 && c === 0 && a > 0 && d > 0 && ox <= 0 && oy <= 0 && ox + w * a >= this.width && oy + h * d >= this.height) {
      this.elements.length = 0;
      this.texts.length = 0;
    }
  }
  private text(text: string, x: number, y: number, stroke: boolean): void {
    const [px, py] = this.point(x, y);
    const style = this.state[stroke ? "strokeStyle" : "fillStyle"];
    const color = typeof style === "string" ? style : style.stops[0]?.[1] ?? "#000000";
    this.texts.push({ text, x: px, y: py, font: this.state.font, color, align: this.state.textAlign, baseline: this.state.textBaseline, alpha: this.state.globalAlpha, stroke, lineWidth: this.state.lineWidth });
  }
  fillText(text: string, x: number, y: number): void { this.text(text, x, y, false); }
  strokeText(text: string, x: number, y: number): void { this.text(text, x, y, true); }

  /** The recorded scene as an SVG document. */
  toSvg(): string {
    return `<svg xmlns="http://www.w3.org/2000/svg" width="${this.width}" height="${this.height}" viewBox="0 0 ${this.width} ${this.height}">${this.defs.length ? `<defs>${this.defs.join("")}</defs>` : ""}${this.elements.join("")}</svg>`;
  }
}

/** CSS `font` shorthand: [style] [variant] [weight] size[/line-height] family. */
export function parseCanvasFont(font: string): { fontStyle?: "italic"; fontWeight?: number; fontSize: number; fontFamily: string } {
  const match = /^\s*(?:(italic|oblique|normal)\s+)?(?:(small-caps|normal)\s+)?(?:(bold|bolder|lighter|normal|[1-9]00)\s+)?([\d.]+)px(?:\/[\d.]+\w*)?\s+(.+?)\s*$/i.exec(font);
  if (!match) return { fontSize: 10, fontFamily: "sans-serif" };
  const weight = match[3]?.toLowerCase();
  return {
    ...(match[1] && match[1] !== "normal" ? { fontStyle: "italic" as const } : {}),
    ...(weight && weight !== "normal" ? { fontWeight: weight === "bold" || weight === "bolder" ? 700 : weight === "lighter" ? 300 : Number(weight) } : {}),
    fontSize: Number(match[4]),
    fontFamily: match[5]!.replace(/["']/g, "").split(",")[0]!.trim(),
  };
}

/** `<canvas width height onDraw>` — HTML's default size is 300×150. */
export function expandCanvas(props: Record<string, any>, key: string): VNode {
  const width = Number(props.width ?? 300), height = Number(props.height ?? 150);
  const context = new CanvasRenderingContext2D(width, height);
  props.onDraw?.(context);
  const id = String(props.id ?? key);
  return View({ id, ...(props.ariaLabel ? { control: { role: "group", label: props.ariaLabel } } : {}),
    style: { width, height, shrink: 0, position: "relative", overflow: "hidden", ...canonicalizeIntrinsicStyle(props.style) },
    children: [
      _nativeJsx("svg", { id: `${id}-scene`, svg: context.toSvg(), style: { position: "absolute", left: 0, top: 0, width, height } }),
      ...context.texts.map((text, index) => {
        const font = parseCanvasFont(text.font);
        // A 1.0 line box puts the alphabetic baseline ~0.86em below its top for common UI fonts.
        const top = text.baseline === "top" || text.baseline === "hanging" ? text.y
          : text.baseline === "middle" ? text.y - font.fontSize / 2
          : text.baseline === "bottom" || text.baseline === "ideographic" ? text.y - font.fontSize
          : text.y - font.fontSize * 0.86;
        const align = text.align === "center" ? "center" : text.align === "right" || text.align === "end" ? "end" : "start";
        return View({ key: index, style: { position: "absolute", left: text.x, top, width: 0, direction: "column", align, opacity: text.alpha },
          children: Text({ style: { ...font, lineHeight: 1, whiteSpace: "pre", foreground: text.color, ...(text.stroke ? { textDecoration: "none" } : {}) }, children: text.text }) } as never);
      }),
    ] } as never);
}
