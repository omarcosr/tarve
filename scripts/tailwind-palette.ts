/**
 * Generates `packages/core/src/tailwind-palette.ts` from the Tailwind CSS 4 theme:
 * every `--color-*` of the default palette, converted from OKLCH to the sRGB hex the
 * native renderer paints (chroma-reduced into gamut, as browsers do).
 *
 *   bun scripts/tailwind-palette.ts            # writes the table
 *   bun scripts/tailwind-palette.ts --check    # exits 1 when the table is stale
 */
import { readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

export const FAMILIES = [
  "red", "orange", "amber", "yellow", "lime", "green", "emerald", "teal", "cyan", "sky", "blue", "indigo",
  "violet", "purple", "fuchsia", "pink", "rose", "slate", "gray", "zinc", "neutral", "stone",
] as const;
export const SHADES = ["50", "100", "200", "300", "400", "500", "600", "700", "800", "900", "950"] as const;

const clamp01 = (v: number) => Math.min(1, Math.max(0, v));

/** OKLab → linear sRGB (Björn Ottosson's matrices). */
function oklabToLinearSrgb(L: number, a: number, b: number): [number, number, number] {
  const l = (L + 0.3963377774 * a + 0.2158037573 * b) ** 3;
  const m = (L - 0.1055613458 * a - 0.0638541728 * b) ** 3;
  const s = (L - 0.0894841775 * a - 1.291485548 * b) ** 3;
  return [
    4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s,
    -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s,
    -0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s,
  ];
}

const inGamut = (rgb: number[]) => rgb.every(c => c >= -1e-6 && c <= 1 + 1e-6);
const gamma = (c: number) => { const v = clamp01(c); return v <= 0.0031308 ? 12.92 * v : 1.055 * v ** (1 / 2.4) - 0.055; };
const hex2 = (v: number) => Math.round(clamp01(v) * 255).toString(16).padStart(2, "0");

/** Linear sRGB → OKLab, the inverse of `oklabToLinearSrgb`. */
function linearSrgbToOklab(r: number, g: number, b: number): [number, number, number] {
  const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b);
  const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b);
  const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b);
  return [
    0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s,
    1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s,
    0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s,
  ];
}

/**
 * CSS Color 4 gamut mapping: reduce chroma until the colour fits sRGB, accepting a
 * clipped colour once it is within a just-noticeable difference (ΔE OK < 0.02) of the
 * target, as browsers do when they paint an out-of-gamut `oklch()`.
 */
function mapToSrgb(L: number, C: number, h: number): [number, number, number] {
  const toRgb = (chroma: number) => oklabToLinearSrgb(L, chroma * Math.cos(h), chroma * Math.sin(h));
  const clip = (rgb: number[]): [number, number, number] => [clamp01(rgb[0]!), clamp01(rgb[1]!), clamp01(rgb[2]!)];
  const deltaE = (a: number[], b: number[]) => {
    const [l1, a1, b1] = linearSrgbToOklab(a[0]!, a[1]!, a[2]!), [l2, a2, b2] = linearSrgbToOklab(b[0]!, b[1]!, b[2]!);
    return Math.hypot(l1 - l2, a1 - a2, b1 - b2);
  };
  if (L >= 1) return [1, 1, 1];
  if (L <= 0) return [0, 0, 0];
  let current = toRgb(C);
  if (inGamut(current)) return clip(current);
  const JND = 0.02, EPSILON = 0.0001;
  let min = 0, max = C, minInGamut = true;
  while (max - min > EPSILON) {
    const chroma = (min + max) / 2;
    current = toRgb(chroma);
    if (minInGamut && inGamut(current)) { min = chroma; continue; }
    const clipped = clip(current);
    const E = deltaE(clipped, current);
    if (E < JND) {
      if (JND - E < EPSILON) return clipped;
      minInGamut = false;
      min = chroma;
    } else max = chroma;
  }
  return clip(current);
}

/** `oklch(63.7% 0.237 25.331)` → `#rrggbb`, gamut-mapped into sRGB as a browser paints it. */
export function oklchToHex(value: string): string {
  // Hue is `none` for the greys (chroma 0).
  const match = /^oklch\(\s*([\d.]+)(%?)\s+([\d.]+)\s+([\d.]+|none)(?:deg)?\s*(?:\/\s*([\d.]+%?))?\s*\)$/i.exec(value.trim());
  if (!match) throw new Error(`Not an oklch colour: ${value}`);
  const L = Number(match[1]) / (match[2] ? 100 : 1);
  const C = Number(match[3]);
  const h = (match[4] === "none" ? 0 : Number(match[4]) * Math.PI) / 180;
  const rgb = mapToSrgb(L, C, h);
  const alpha = match[5] === undefined ? 1 : match[5].endsWith("%") ? Number(match[5].slice(0, -1)) / 100 : Number(match[5]);
  return `#${hex2(gamma(rgb[0]))}${hex2(gamma(rgb[1]))}${hex2(gamma(rgb[2]))}${alpha === 1 ? "" : hex2(alpha)}`;
}

/** Any CSS colour Tailwind's theme uses, as hex. */
export function cssColorToHex(value: string): string {
  const v = value.trim();
  if (v.startsWith("oklch(")) return oklchToHex(v);
  if (/^#[0-9a-f]{3}$/i.test(v)) return "#" + [...v.slice(1)].map(c => c + c).join("").toLowerCase();
  if (/^#[0-9a-f]{6}$/i.test(v)) return v.toLowerCase();
  throw new Error(`Unsupported theme colour: ${value}`);
}

/** The `--color-*` variables of Tailwind's default theme, from its stylesheet. */
export function themeColors(): Map<string, string> {
  const css = readFileSync(join(resolve(import.meta.dir, ".."), "node_modules", "tailwindcss", "theme.css"), "utf8");
  const colors = new Map<string, string>();
  for (const match of css.matchAll(/--color-([a-z]+)-(\d+):\s*([^;]+);/g)) colors.set(`${match[1]}-${match[2]}`, match[3]!.trim());
  return colors;
}

export function renderPalette(): string {
  const colors = themeColors();
  const lines = [
    "// Generated by `bun scripts/tailwind-palette.ts` from Tailwind CSS 4's default theme; do not edit.",
    "// Each family lists its shades 50 … 950 as sRGB hex (OKLCH mapped into gamut).",
    "export const PALETTE: Record<string, string> = {",
  ];
  for (const family of FAMILIES) {
    const shades = SHADES.map(shade => {
      const value = colors.get(`${family}-${shade}`);
      if (!value) throw new Error(`Tailwind theme has no --color-${family}-${shade}`);
      return cssColorToHex(value).slice(1);
    });
    lines.push(`  ${family}: "${shades.join(" ")}",`);
  }
  lines.push("};", "");
  return lines.join("\n");
}

if (import.meta.main) {
  const target = join(resolve(import.meta.dir, ".."), "packages", "core", "src", "tailwind-palette.ts");
  const next = renderPalette();
  if (process.argv.includes("--check")) {
    let current = "";
    try { current = readFileSync(target, "utf8"); } catch {}
    if (current.replace(/\r\n/g, "\n") !== next) {
      console.error(`${target} is stale; run bun scripts/tailwind-palette.ts`);
      process.exit(1);
    }
    console.log("tailwind palette up to date");
  } else {
    writeFileSync(target, next);
    console.log(`wrote ${target}`);
  }
}
