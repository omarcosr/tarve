import type { BoxShadow, ConicGradient, ConicGradientStop, Gradient, GradientCentre, GradientLength, GradientSide, GradientStop, RadialExtent, TextShadow, Transform } from "../../protocol/src/index";

/** Every CSS named colour, packed as "name hex …" and expanded once. */
const NAMED: Record<string, string> = Object.fromEntries(
  "aliceblue f0f8ff antiquewhite faebd7 aqua 00ffff aquamarine 7fffd4 azure f0ffff beige f5f5dc bisque ffe4c4 black 000000 blanchedalmond ffebcd blue 0000ff blueviolet 8a2be2 brown a52a2a burlywood deb887 cadetblue 5f9ea0 chartreuse 7fff00 chocolate d2691e coral ff7f50 cornflowerblue 6495ed cornsilk fff8dc crimson dc143c cyan 00ffff darkblue 00008b darkcyan 008b8b darkgoldenrod b8860b darkgray a9a9a9 darkgreen 006400 darkgrey a9a9a9 darkkhaki bdb76b darkmagenta 8b008b darkolivegreen 556b2f darkorange ff8c00 darkorchid 9932cc darkred 8b0000 darksalmon e9967a darkseagreen 8fbc8f darkslateblue 483d8b darkslategray 2f4f4f darkslategrey 2f4f4f darkturquoise 00ced1 darkviolet 9400d3 deeppink ff1493 deepskyblue 00bfff dimgray 696969 dimgrey 696969 dodgerblue 1e90ff firebrick b22222 floralwhite fffaf0 forestgreen 228b22 fuchsia ff00ff gainsboro dcdcdc ghostwhite f8f8ff gold ffd700 goldenrod daa520 gray 808080 green 008000 greenyellow adff2f grey 808080 honeydew f0fff0 hotpink ff69b4 indianred cd5c5c indigo 4b0082 ivory fffff0 khaki f0e68c lavender e6e6fa lavenderblush fff0f5 lawngreen 7cfc00 lemonchiffon fffacd lightblue add8e6 lightcoral f08080 lightcyan e0ffff lightgoldenrodyellow fafad2 lightgray d3d3d3 lightgreen 90ee90 lightgrey d3d3d3 lightpink ffb6c1 lightsalmon ffa07a lightseagreen 20b2aa lightskyblue 87cefa lightslategray 778899 lightslategrey 778899 lightsteelblue b0c4de lightyellow ffffe0 lime 00ff00 limegreen 32cd32 linen faf0e6 magenta ff00ff maroon 800000 mediumaquamarine 66cdaa mediumblue 0000cd mediumorchid ba55d3 mediumpurple 9370db mediumseagreen 3cb371 mediumslateblue 7b68ee mediumspringgreen 00fa9a mediumturquoise 48d1cc mediumvioletred c71585 midnightblue 191970 mintcream f5fffa mistyrose ffe4e1 moccasin ffe4b5 navajowhite ffdead navy 000080 oldlace fdf5e6 olive 808000 olivedrab 6b8e23 orange ffa500 orangered ff4500 orchid da70d6 palegoldenrod eee8aa palegreen 98fb98 paleturquoise afeeee palevioletred db7093 papayawhip ffefd5 peachpuff ffdab9 peru cd853f pink ffc0cb plum dda0dd powderblue b0e0e6 purple 800080 rebeccapurple 663399 red ff0000 rosybrown bc8f8f royalblue 4169e1 saddlebrown 8b4513 salmon fa8072 sandybrown f4a460 seagreen 2e8b57 seashell fff5ee sienna a0522d silver c0c0c0 skyblue 87ceeb slateblue 6a5acd slategray 708090 slategrey 708090 snow fffafa springgreen 00ff7f steelblue 4682b4 tan d2b48c teal 008080 thistle d8bfd8 tomato ff6347 turquoise 40e0d0 violet ee82ee wheat f5deb3 white ffffff whitesmoke f5f5f5 yellow ffff00 yellowgreen 9acd32 transparent 00000000"
    .split(" ")
    .flatMap((word, index, words) => (index % 2 === 0 ? [[word, `#${words[index + 1]}`]] : [])),
);

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
  if ((lengths[2] ?? 0) < 0) throw new TypeError("textShadow blur must be >= 0");
  return { x: lengths[0], y: lengths[1], ...(lengths[2] ? { blur: lengths[2] } : {}), color };
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

export const GRADIENT = /^\s*(repeating-)?(linear|radial|conic)-gradient\(/i;

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

/** A conic stop position: an angle or `N%` → fraction of a turn; unitless 0 → 0. */
function turn(token: string): number {
  if (token === "0") return 0;
  if (/^-?(?:\d+\.?\d*|\.\d+)%$/.test(token)) return Number(token.slice(0, -1)) / 100;
  const degrees = angle(token);
  if (degrees === undefined) throw new TypeError(`Conic gradient positions must be angles or %: ${token}`);
  return degrees / 360;
}

function parseConicStop(token: string): ConicGradientStop[] {
  const [color, ...positions] = splitTopLevel(token, /\s/);
  if (!color || positions.length > 2) throw new TypeError(`Invalid colour stop: ${token}`);
  return positions.length === 0 ? [{ color }] : positions.map(value => ({ color, offset: turn(value) }));
}

/** `[from <angle>] [at <position>]`, the optional first argument of `conic-gradient()`. */
function conicHeader(words: string[]): Pick<ConicGradient, "from" | "at"> | undefined {
  if (words[0] !== "from" && words[0] !== "at") return undefined;
  const at = words.indexOf("at");
  const before = at < 0 ? words : words.slice(0, at);
  const header: Pick<ConicGradient, "from" | "at"> = {};
  if (before.length > 0) {
    const degrees = before.length === 2 && before[0] === "from" ? (before[1] === "0" ? 0 : angle(before[1]!)) : undefined;
    if (degrees === undefined) throw new TypeError(`Invalid conic-gradient angle: ${words.join(" ")}`);
    if (degrees !== 0) header.from = degrees;
  }
  if (at >= 0) header.at = centre(words.slice(at + 1));
  return header;
}

/** CSS `linear-gradient(…)` / `radial-gradient(…)` and their `repeating-` forms → gradient object. */
export function parseGradient(value: string): Gradient {
  const match = value.trim().match(/^(repeating-)?(linear|radial|conic)-gradient\(([\s\S]*)\)$/i);
  if (!match) throw new TypeError(`Unsupported gradient: ${value}`);
  const repeating = match[1] ? { repeating: true } : {};
  const args = splitTopLevel(match[3]!, /,/);
  const first = (args[0] ?? "").toLowerCase().trim().split(/\s+/);
  if (match[2]!.toLowerCase() === "conic") {
    const header = conicHeader(first);
    return { type: "conic", ...header, ...repeating, stops: (header ? args.slice(1) : args).flatMap(parseConicStop) };
  }
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
  const conic = gradient.type === "conic";
  const stops = gradient.stops.map(stop => {
    const { color, offset } = typeof stop === "string" ? { color: stop, offset: undefined } : stop;
    let resolved: GradientStop["offset"] = offset as GradientStop["offset"];
    if (typeof offset === "string") {
      resolved = conic ? turn(offset.trim()) : position(offset.trim());
    } else if (offset !== undefined && !Number.isFinite(offset)) {
      throw new TypeError(`Invalid gradient offset: ${offset}`);
    }
    return resolved === undefined ? { color: colour(color) } : { color: colour(color), offset: resolved };
  });
  return { ...gradient, stops: stops.length === 1 ? [stops[0]!, { color: stops[0]!.color }] : stops } as Gradient;
}
