import type { BoxShadow, TextShadow } from "../../protocol/src/index";

const NAMED: Record<string, string> = {
  transparent: "#00000000", black: "#000000", white: "#ffffff", red: "#ff0000", green: "#008000",
  blue: "#0000ff", gray: "#808080", grey: "#808080", yellow: "#ffff00", orange: "#ffa500",
  purple: "#800080", pink: "#ffc0cb", cyan: "#00ffff", magenta: "#ff00ff",
};

function hex2(value: number): string {
  return Math.round(Math.min(255, Math.max(0, value))).toString(16).padStart(2, "0");
}

function channel(token: string, scale: number): number {
  const value = token.endsWith("%") ? Number(token.slice(0, -1)) / 100 * scale : Number(token);
  if (!Number.isFinite(value)) throw new TypeError(`Invalid colour channel: ${token}`);
  return value;
}

function alpha(token: string | undefined): number {
  if (token === undefined) return 1;
  return Math.min(1, Math.max(0, channel(token, 1)));
}

function hslToRgb(h: number, s: number, l: number): [number, number, number] {
  const k = (n: number) => (n + h / 30) % 12;
  const a = s * Math.min(l, 1 - l);
  const f = (n: number) => l - a * Math.max(-1, Math.min(k(n) - 3, Math.min(9 - k(n), 1)));
  return [f(0) * 255, f(8) * 255, f(4) * 255];
}

/**
 * CSS colour → "#rrggbbaa". Hex, rgb()/rgba(), hsl()/hsla() and a few names are
 * converted; theme tokens (`var(--…)`) pass through for theme resolution.
 */
export function cssColor(value: string): string {
  const input = value.trim().toLowerCase();
  if (input.startsWith("var(")) return value.trim();
  if (Object.hasOwn(NAMED, input)) return NAMED[input]!;
  if (/^#([0-9a-f]{3,4}|[0-9a-f]{6}|[0-9a-f]{8})$/.test(input)) {
    const digits = input.slice(1);
    return digits.length <= 4 ? `#${[...digits].map(d => d + d).join("")}` : input;
  }
  const fn = input.match(/^(rgba?|hsla?)\((.*)\)$/);
  if (!fn) throw new TypeError(`Unsupported colour: ${value}`);
  const [body, slash] = fn[2]!.split("/").map(part => part.trim());
  const parts = body!.split(/[\s,]+/).filter(Boolean);
  const a = alpha(slash ?? parts[3]);
  if (parts.length < 3) throw new TypeError(`Unsupported colour: ${value}`);
  const [r, g, b] = fn[1]!.startsWith("rgb")
    ? [channel(parts[0]!, 255), channel(parts[1]!, 255), channel(parts[2]!, 255)]
    : hslToRgb(Number.parseFloat(parts[0]!), channel(parts[1]!, 1), channel(parts[2]!, 1));
  return `#${hex2(r)}${hex2(g)}${hex2(b)}${hex2(a * 255)}`;
}

function splitTopLevel(value: string, separator: RegExp): string[] {
  const parts: string[] = [];
  let depth = 0;
  let current = "";
  for (const character of value) {
    if (character === "(") depth++;
    if (character === ")") depth--;
    if (depth === 0 && separator.test(character)) {
      if (current.trim()) parts.push(current.trim());
      current = "";
    } else {
      current += character;
    }
  }
  if (current.trim()) parts.push(current.trim());
  return parts;
}

function length(token: string): number | undefined {
  const match = token.match(/^(-?(?:\d+\.?\d*|\.\d+))(px)?$/);
  if (!match) return undefined;
  const number = Number(match[1]);
  if (match[2] === undefined && number !== 0) return undefined;
  return number;
}

function parseLayer(layer: string, allowInset: boolean): { lengths: number[]; color: string; inset: boolean } {
  let inset = false;
  let color: string | undefined;
  const lengths: number[] = [];
  for (const token of splitTopLevel(layer, /\s/)) {
    if (token.toLowerCase() === "inset" && allowInset && !inset) { inset = true; continue; }
    const value = length(token);
    if (value !== undefined) { lengths.push(value); continue; }
    if (color !== undefined) throw new TypeError(`Unexpected token in shadow: ${token}`);
    color = cssColor(token);
  }
  if (lengths.length < 2) throw new TypeError(`A shadow needs x and y offsets: ${layer}`);
  return { lengths, color: color ?? "#000000", inset };
}

/** CSS `box-shadow` syntax: "inset 0 1px 2px rgba(0,0,0,.2), 0 8px 24px #0003" or "none". */
export function parseBoxShadow(value: string): BoxShadow[] {
  if (value.trim().toLowerCase() === "none") return [];
  return splitTopLevel(value, /,/).map(layer => {
    const { lengths, color, inset } = parseLayer(layer, true);
    if (lengths.length > 4) throw new TypeError(`Too many lengths in box-shadow: ${layer}`);
    const [x, y, blur = 0, spread = 0] = lengths;
    if (blur < 0) throw new RangeError(`box-shadow blur must not be negative: ${layer}`);
    return { x, y, blur, spread, color, ...(inset ? { inset: true } : {}) } as BoxShadow;
  });
}

/** CSS `text-shadow` syntax for one solid shadow: "1px 2px #0006". Blur must be 0. */
export function parseTextShadow(value: string): TextShadow | undefined {
  if (value.trim().toLowerCase() === "none") return undefined;
  const layers = splitTopLevel(value, /,/);
  if (layers.length !== 1) throw new TypeError("textShadow supports a single shadow");
  const { lengths, color } = parseLayer(layers[0]!, false);
  if (lengths.length > 3) throw new TypeError(`Too many lengths in text-shadow: ${value}`);
  if ((lengths[2] ?? 0) !== 0) throw new TypeError("textShadow blur is not supported");
  return { x: lengths[0], y: lengths[1], color };
}
