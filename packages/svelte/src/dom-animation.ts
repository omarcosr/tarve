
export type Keyframe = { offset: number; values: Record<string, string> };

/** Keyframes with offsets (missing ones spread evenly, as Web Animations does). */
export function keyframesOf(input: Record<string, string | number | null | undefined>[]): Keyframe[] {
  const frames = input.map(frame => {
    const values: Record<string, string> = {};
    for (const [key, value] of Object.entries(frame)) if (key !== "offset" && key !== "easing" && key !== "composite" && value != null) values[key] = String(value);
    return { offset: typeof frame.offset === "number" ? frame.offset : NaN, values };
  });
  if (frames.length === 1) frames.unshift({ offset: 0, values: { ...frames[0]!.values } });
  frames.forEach((frame, index) => { if (Number.isNaN(frame.offset)) frame.offset = frames.length > 1 ? index / (frames.length - 1) : 0; });
  return frames.sort((a, b) => a.offset - b.offset);
}

export const COLOR = /#([0-9a-f]{3,8})\b|rgba?\(([^)]*)\)/gi;
/** Colours as `rgba(r, g, b, a)`, so they interpolate as numbers. */
export function normalizeColors(value: string): string {
  return value.replace(COLOR, (_match, hex: string | undefined, rgb: string | undefined) => {
    if (rgb !== undefined) {
      const parts = rgb.split(/[\s,/]+/).filter(Boolean).map(Number);
      return `rgba(${parts[0] ?? 0}, ${parts[1] ?? 0}, ${parts[2] ?? 0}, ${parts[3] ?? 1})`;
    }
    let digits = hex!;
    if (digits.length <= 4) digits = [...digits].map(char => char + char).join("");
    const value = (index: number) => parseInt(digits.slice(index, index + 2), 16);
    return `rgba(${value(0)}, ${value(2)}, ${value(4)}, ${digits.length === 8 ? value(6) / 255 : 1})`;
  });
}

export const NUMBER = /-?\d*\.?\d+(?:e-?\d+)?/gi;
/** Interpolates two CSS values number by number when they share a shape; else switches halfway. */
export function mix(from: string, to: string, t: number): string {
  const a = normalizeColors(from), b = normalizeColors(to);
  const shapeA = a.replace(NUMBER, "#"), shapeB = b.replace(NUMBER, "#");
  if (shapeA !== shapeB) return t < 0.5 ? from : to;
  const numbersB = b.match(NUMBER) ?? [];
  let index = 0;
  return a.replace(NUMBER, number => {
    const start = Number(number), end = Number(numbersB[index++]);
    const value = start + (end - start) * t;
    return String(Math.round(value * 1000) / 1000);
  });
}

export function interpolateFrames(frames: Keyframe[], progress: number): Record<string, string> | undefined {
  if (!frames.length) return undefined;
  if (progress <= frames[0]!.offset) return frames[0]!.values;
  for (let index = 1; index < frames.length; index++) {
    const previous = frames[index - 1]!, next = frames[index]!;
    if (progress > next.offset) continue;
    const span = next.offset - previous.offset;
    const t = span ? (progress - previous.offset) / span : 1;
    const out: Record<string, string> = {};
    for (const key of new Set([...Object.keys(previous.values), ...Object.keys(next.values)])) {
      const from = previous.values[key], to = next.values[key];
      out[key] = from === undefined ? to! : to === undefined ? from : mix(from, to, t);
    }
    return out;
  }
  return frames[frames.length - 1]!.values;
}

/** A CSS timing function as a function of progress. */
export function easing(name: string): (t: number) => number {
  const bezier = (x1: number, y1: number, x2: number, y2: number) => (t: number) => {
    // Solve x(u) = t by Newton's method, then return y(u).
    let u = t;
    for (let index = 0; index < 8; index++) {
      const x = 3 * x1 * u * (1 - u) ** 2 + 3 * x2 * u ** 2 * (1 - u) + u ** 3 - t;
      const slope = 3 * x1 * (1 - u) ** 2 + 6 * (x2 - x1) * u * (1 - u) + 3 * (1 - x2) * u ** 2;
      if (Math.abs(x) < 1e-5 || !slope) break;
      u = Math.min(1, Math.max(0, u - x / slope));
    }
    return 3 * y1 * u * (1 - u) ** 2 + 3 * y2 * u ** 2 * (1 - u) + u ** 3;
  };
  const value = name.trim();
  if (value === "ease") return bezier(0.25, 0.1, 0.25, 1);
  if (value === "ease-in") return bezier(0.42, 0, 1, 1);
  if (value === "ease-out") return bezier(0, 0, 0.58, 1);
  if (value === "ease-in-out") return bezier(0.42, 0, 0.58, 1);
  const cubic = /^cubic-bezier\(([^)]*)\)$/.exec(value);
  if (cubic) { const [a = 0, b = 0, c = 1, e = 1] = cubic[1]!.split(",").map(Number); return bezier(a, b, c, e); }
  const steps = /^steps\(\s*(\d+)\s*(?:,\s*(start|end|jump-start|jump-end))?\s*\)$/.exec(value);
  if (steps) { const count = Number(steps[1]); const start = steps[2]?.includes("start"); return t => Math.min(1, (start ? Math.ceil(t * count) : Math.floor(t * count)) / count); }
  if (value === "step-start") return t => (t > 0 ? 1 : 0);
  if (value === "step-end") return t => (t >= 1 ? 1 : 0);
  return t => t;
}
