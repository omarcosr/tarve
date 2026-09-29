import type { BoxShadow, Gradient, GradientCentre, GradientLength, GradientSide, GradientStop, RadialExtent, TextShadow, Transform } from "../../protocol/src/index";

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

/**
 * CSS `transform` syntax limited to translate/scale: "translateY(-2px) scale(1.02)".
 * Functions compose left to right as in CSS; "none" is the identity.
 */
export function parseTransform(value: string): Transform {
  let [x, y, scaleX, scaleY] = [0, 0, 1, 1];
  const input = value.trim();
  if (input.toLowerCase() === "none") return {};
  const pattern = /([a-zA-Z]+)\(([^)]*)\)/g;
  let consumed = "";
  for (const match of input.matchAll(pattern)) {
    consumed += match[0];
    const name = match[1]!;
    const args = match[2]!.split(/[\s,]+/).filter(Boolean);
    const px = (token: string | undefined) => {
      const number = token === undefined ? 0 : length(token);
      if (number === undefined) throw new TypeError(`Unsupported transform length: ${token}`);
      return number;
    };
    const factor = (token: string | undefined) => {
      const number = Number(token);
      if (token === undefined || !Number.isFinite(number) || number === 0) throw new TypeError(`Invalid scale: ${token}`);
      return number;
    };
    switch (name) {
      case "translate": x += scaleX * px(args[0]); y += scaleY * px(args[1]); break;
      case "translateX": x += scaleX * px(args[0]); break;
      case "translateY": y += scaleY * px(args[0]); break;
      case "scale": { const sx = factor(args[0]); scaleX *= sx; scaleY *= args[1] === undefined ? sx : factor(args[1]); break; }
      case "scaleX": scaleX *= factor(args[0]); break;
      case "scaleY": scaleY *= factor(args[0]); break;
      default: throw new TypeError(`Unsupported transform function: ${name}() (translate and scale only)`);
    }
  }
  if (consumed.replace(/\s/g, "") !== input.replace(/\s/g, "")) throw new TypeError(`Invalid transform: ${value}`);
  return {
    ...(x !== 0 ? { x } : {}), ...(y !== 0 ? { y } : {}),
    ...(scaleX === scaleY ? (scaleX !== 1 ? { scale: scaleX } : {}) : { scaleX, scaleY }),
  };
}

export const GRADIENT = /^\s*(repeating-)?(linear|radial)-gradient\(/i;

function angle(token: string): number | undefined {
  const match = token.match(/^(-?(?:\d+\.?\d*|\.\d+))(deg|rad|turn|grad)$/);
  if (!match) return undefined;
  const value = Number(match[1]);
  return { deg: value, rad: value * 180 / Math.PI, turn: value * 360, grad: value * 0.9 }[match[2] as "deg"];
}

const LENGTH_PERCENT = /^-?(?:\d+\.?\d*|\.\d+)(px|%)$/;

/** `N%` → fraction; `Npx` stays a px string; unitless 0 → 0. */
function position(token: string): number | `${number}px` {
  if (token === "0") return 0;
  const match = token.match(LENGTH_PERCENT);
  if (!match) throw new TypeError(`Gradient positions must be px or %: ${token}`);
  return match[1] === "%" ? Number(token.slice(0, -1)) / 100 : token as `${number}px`;
}

function parseStop(token: string): GradientStop[] {
  const [color, ...positions] = splitTopLevel(token, /\s/);
  if (!color || positions.length > 2) throw new TypeError(`Invalid colour stop: ${token}`);
  return positions.length === 0 ? [{ color }] : positions.map(value => ({ color, offset: position(value) }));
}

type Coordinate = number | `${number}px`;

/** CSS <position> for radial centres: 1–2 values (keywords, %, px) or 3–4 with edge offsets. */
function centre(tokens: string[]): GradientCentre {
  const invalid = () => new TypeError(`Invalid radial-gradient position: at ${tokens.join(" ")}`);
  const HORIZONTAL = /^(left|right)$/;
  const VERTICAL = /^(top|bottom)$/;
  const KEYWORD = /^(left|right|top|bottom|center)$/;
  const edge = (keyword: string): number => (keyword === "left" || keyword === "top" ? 0 : keyword === "center" ? 0.5 : 1);
  const result: GradientCentre = {};
  if (tokens.length === 0 || tokens.length > 4) throw invalid();
  if (tokens.length <= 2) {
    const loose: Coordinate[] = [];
    for (const token of tokens) {
      if (HORIZONTAL.test(token)) { if (result.x !== undefined) throw invalid(); result.x = edge(token); }
      else if (VERTICAL.test(token)) { if (result.y !== undefined) throw invalid(); result.y = edge(token); }
      else if (token === "center") loose.push(0.5);
      else loose.push(position(token));
    }
    if (tokens.length === 2 && loose.length === 2) return { x: loose[0]!, y: loose[1]! };
    if (tokens.length === 2 && loose.length === 1 && !KEYWORD.test(tokens[1]!) && result.y !== undefined) throw invalid();
    result.x ??= loose.shift() ?? 0.5;
    result.y ??= loose.shift() ?? 0.5;
    return result;
  }
  let index = 0;
  while (index < tokens.length) {
    const keyword = tokens[index]!;
    if (!KEYWORD.test(keyword)) throw invalid();
    const next = tokens[index + 1];
    const offset = next !== undefined && !KEYWORD.test(next) ? position(next) : undefined;
    index += offset === undefined ? 1 : 2;
    if (keyword === "center") {
      if (offset !== undefined) throw invalid();
      if (result.x === undefined) result.x = 0.5;
      else if (result.y === undefined) result.y = 0.5;
      else throw invalid();
      continue;
    }
    const axis = HORIZONTAL.test(keyword) ? "x" : "y";
    if (result[axis] !== undefined) throw invalid();
    const fromEnd = keyword === "right" || keyword === "bottom";
    if (offset === undefined) result[axis] = edge(keyword);
    else if (typeof offset === "number") result[axis] = fromEnd ? 1 - offset : offset;
    else {
      result[axis] = offset;
      if (fromEnd) {
        if (axis === "x") result.xEdge = "right";
        else result.yEdge = "bottom";
      }
    }
  }
  result.x ??= 0.5;
  result.y ??= 0.5;
  return result;
}

const EXTENT = /^(closest|farthest)-(side|corner)$/;

/** CSS `linear-gradient(…)` / `radial-gradient(…)` and their `repeating-` forms → gradient object. */
export function parseGradient(value: string): Gradient {
  const match = value.trim().match(/^(repeating-)?(linear|radial)-gradient\(([\s\S]*)\)$/i);
  if (!match) throw new TypeError(`Unsupported gradient: ${value}`);
  const repeating = match[1] ? { repeating: true } : {};
  const args = splitTopLevel(match[3]!, /,/);
  const first = (args[0] ?? "").toLowerCase().split(/\s+/);
  if (match[2]!.toLowerCase() === "linear") {
    const degrees = first.length === 1 ? angle(first[0]!) : undefined;
    if (degrees !== undefined) return { type: "linear", angle: degrees, ...repeating, stops: args.slice(1).flatMap(parseStop) };
    if (first[0] === "to") {
      const sides = first.slice(1).sort((a, b) => Number(a === "left" || a === "right") - Number(b === "left" || b === "right"));
      const valid = sides.length >= 1 && sides.length <= 2 && sides.every(side => /^(top|bottom|left|right)$/.test(side))
        && new Set(sides.map(side => side === "top" || side === "bottom")).size === sides.length;
      if (!valid) throw new TypeError(`Invalid gradient direction: ${args[0]}`);
      return { type: "linear", to: sides.join(" ") as GradientSide, ...repeating, stops: args.slice(1).flatMap(parseStop) };
    }
    return { type: "linear", ...repeating, stops: args.flatMap(parseStop) };
  }
  const header = first.some(word => /^(circle|ellipse|at)$/.test(word) || EXTENT.test(word) || LENGTH_PERCENT.test(word));
  if (!header) return { type: "radial", ...repeating, stops: args.flatMap(parseStop) };
  const at = first.indexOf("at");
  let shape: "circle" | "ellipse" | undefined;
  let extent: RadialExtent | undefined;
  const lengths: GradientLength[] = [];
  for (const word of at < 0 ? first : first.slice(0, at)) {
    if (word === "circle" || word === "ellipse") shape = word;
    else if (EXTENT.test(word)) extent = word as RadialExtent;
    else if (LENGTH_PERCENT.test(word)) lengths.push(word as GradientLength);
    else throw new TypeError(`Unsupported radial-gradient size: ${word}`);
  }
  if (extent && lengths.length) throw new TypeError(`A radial gradient takes an extent keyword or lengths, not both: ${args[0]}`);
  if (lengths.length > 2) throw new TypeError(`Too many radial-gradient sizes: ${args[0]}`);
  shape ??= lengths.length === 1 ? "circle" : lengths.length === 2 ? "ellipse" : undefined;
  if (shape === "circle" && (lengths.length > 1 || lengths.some(length => String(length).endsWith("%")))) {
    throw new TypeError(`A circle takes one px radius: ${args[0]}`);
  }
  if (shape === "ellipse" && lengths.length === 1) throw new TypeError(`An ellipse takes two radii: ${args[0]}`);
  const size = extent ?? (lengths.length === 1 ? lengths[0] : lengths.length === 2 ? [lengths[0]!, lengths[1]!] as const : undefined);
  return {
    type: "radial",
    ...(shape ? { shape } : {}),
    ...(size ? { size } : {}),
    ...(at >= 0 ? { at: centre(first.slice(at + 1)) } : {}),
    ...repeating,
    stops: args.slice(1).flatMap(parseStop),
  };
}

/** Resolves stop colours and converts `N%` offsets to fractions; px and omitted offsets resolve natively. */
export function normalizeGradient(gradient: Gradient, colour: (value: string) => string): Gradient {
  if (gradient.stops.length === 0) throw new TypeError("A gradient needs at least one colour stop");
  const stops = gradient.stops.map(stop => {
    const { color, offset } = typeof stop === "string" ? { color: stop, offset: undefined } : stop;
    let resolved: GradientStop["offset"] = offset;
    if (typeof offset === "string") {
      const parsed = position(offset.trim());
      resolved = parsed;
    } else if (offset !== undefined && !Number.isFinite(offset)) {
      throw new TypeError(`Invalid gradient offset: ${offset}`);
    }
    return resolved === undefined ? { color: colour(color) } : { color: colour(color), offset: resolved };
  });
  return { ...gradient, stops: stops.length === 1 ? [stops[0]!, { color: stops[0]!.color }] : stops };
}
