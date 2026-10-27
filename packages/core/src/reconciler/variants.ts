// Style variants the reconciler folds before the native tree sees the style.
import type { ThemeDefinition } from "../theme";
import { Style } from "../style";
import { readEnvironment } from "../viewport";

/**
 * A variant's `padding: { top: 0 }` overrides one side of the base's padding, as `first:pt-0`
 * over `p-2` does in CSS; a plain merge would drop the other three sides.
 */
function combineSides(base: Style, variant: Style): Partial<Style> {
  const out: Record<string, unknown> = {};
  for (const key of ["padding", "margin", "borderWidth"] as const) {
    const a = base[key], b = variant[key];
    if (a === undefined || b === undefined || typeof b !== "object") continue;
    const expanded = typeof a === "object" ? { ...a } : { top: a, right: a, bottom: a, left: a };
    out[key] = { ...expanded, ...b };
  }
  const a = base.radius, b = variant.radius;
  if (a !== undefined && b !== undefined && typeof b === "object") {
    const expanded = typeof a === "object" ? { ...a } : { topLeft: a, topRight: a, bottomRight: a, bottomLeft: a };
    out.radius = { ...expanded, ...b };
  }
  return out as Partial<Style>;
}

/** Where a node sits among its parent's element children, for `first`/`last`/`odd`/`even`. */
export interface Position { index: number; count: number }

/** Tailwind's breakpoints: the window must be at least this wide (CSS px) for the variant to apply. */
export const BREAKPOINTS: readonly [keyof Style, number][] = [["sm", 640], ["md", 768], ["lg", 1024], ["xl", 1280], ["2xl", 1536]];

export interface VariantContext { position?: Position; viewportWidth: number; viewportHeight: number; usedViewport: () => void; usedPosition?: () => void }

/**
 * Folds the reconciler-side variants into the style and drops their keys, so the native
 * tree never sees them: `first`/`last`/`odd`/`even` by position, `sm`…`2xl` by window
 * width (ascending, so a wider breakpoint wins), `portrait`/`landscape` by the window's
 * shape, `pointerCoarse`/`pointerFine` and `motionReduce`/`motionSafe` by the system
 * (see viewport.ts), then `dark` by theme, whose own variants fold the same way.
 */
const VARIANT_KEYS = new Set(["first", "last", "odd", "even", "sm", "md", "lg", "xl", "2xl", "portrait", "landscape", "pointerCoarse", "pointerFine", "motionReduce", "motionSafe", "dark"]);

/** `50vh`, `100vw`, `10vmin`, `10vmax` (and the `dvh`/`svh`/`lvh` forms): CSS viewport units. */
const VIEWPORT_UNIT = /^(-?\d*\.?\d+)(d|s|l)?(vh|vw|vmin|vmax)$/;

function viewportLength(value: unknown, context: VariantContext): unknown {
  if (typeof value !== "string") return value;
  const match = VIEWPORT_UNIT.exec(value.trim());
  if (!match) return value;
  context.usedViewport();
  const { viewportWidth: width, viewportHeight: height } = context;
  const base = match[3] === "vh" ? height : match[3] === "vw" ? width : match[3] === "vmin" ? Math.min(width, height) : Math.max(width, height);
  return Number(match[1]) * base / 100;
}

/** Viewport units become px for the window the tree renders for; reading them re-renders on resize. */
function resolveViewportUnits(style: Record<string, unknown>, context: VariantContext): Record<string, unknown> {
  let out: Record<string, unknown> | undefined;
  for (const key in style) {
    const value = style[key];
    let next = value;
    if (typeof value === "string") next = viewportLength(value, context);
    else if ((key === "padding" || key === "margin" || key === "inset" || key === "borderWidth") && value && typeof value === "object") {
      let sides: Record<string, unknown> | undefined;
      for (const side in value as Record<string, unknown>) {
        const raw = (value as Record<string, unknown>)[side];
        const resolved = viewportLength(raw, context);
        if (resolved !== raw) (sides ??= { ...(value as Record<string, unknown>) })[side] = resolved;
      }
      if (sides) next = sides;
    }
    if (next !== value) (out ??= { ...style })[key] = next;
  }
  return out ?? style;
}

function hasViewportUnit(style: Record<string, unknown>): boolean {
  for (const key in style) {
    const value = style[key];
    if (typeof value === "string" && value.includes("v") && VIEWPORT_UNIT.test(value.trim())) return true;
    if ((key === "padding" || key === "margin" || key === "inset" || key === "borderWidth") && value && typeof value === "object") {
      for (const side of Object.values(value)) if (typeof side === "string" && VIEWPORT_UNIT.test(side.trim())) return true;
    }
  }
  return false;
}

export function foldVariants(style: Record<string, unknown>, selected: ThemeDefinition, context: VariantContext): Record<string, unknown> {
  const folded = foldStyleVariants(style, selected, context);
  return hasViewportUnit(folded) ? resolveViewportUnits(folded, context) : folded;
}

function foldStyleVariants(style: Record<string, unknown>, selected: ThemeDefinition, context: VariantContext): Record<string, unknown> {
  // Most styles have no variants: skip the rest-destructuring copy and the variant objects.
  let variant = false;
  for (const key in style) if (VARIANT_KEYS.has(key)) { variant = true; break; }
  if (!variant) return style;
  const { first, last, odd, even, sm, md, lg, xl, "2xl": xxl, portrait, landscape, pointerCoarse, pointerFine, motionReduce, motionSafe, dark, ...base } = style;
  let out = base as Style;
  const merge = (variant: unknown) => {
    if (!variant || typeof variant !== "object") return;
    const sides = combineSides(out, variant as Style);
    out = { ...Style.merge(out, variant as Style), ...sides };
  };
  const { position } = context;
  if (position && (first !== undefined || last !== undefined || odd !== undefined || even !== undefined)) context.usedPosition?.();
  if (position) {
    const nth = position.index + 1;
    if (nth === 1) merge(first);
    if (nth === position.count) merge(last);
    merge(nth % 2 === 1 ? odd : even);
  }
  const responsive: Record<string, unknown> = { sm, md, lg, xl, "2xl": xxl };
  if (Object.values(responsive).some(Boolean)) context.usedViewport();
  for (const [name, minWidth] of BREAKPOINTS) if (context.viewportWidth >= minWidth) merge(responsive[name]);
  if (portrait !== undefined || landscape !== undefined) {
    context.usedViewport();
    merge(context.viewportHeight > context.viewportWidth ? portrait : landscape);
  }
  if (pointerCoarse !== undefined || pointerFine !== undefined || motionReduce !== undefined || motionSafe !== undefined) {
    // Memoized subtrees key on the environment through the viewport (currentBreakpoint).
    context.usedViewport();
    const system = readEnvironment();
    merge(system.pointer === "coarse" ? pointerCoarse : pointerFine);
    merge(system.reducedMotion ? motionReduce : motionSafe);
  }
  if (dark && typeof dark === "object") {
    const themed = luminance(selected.colors.background);
    if (themed !== null && themed < 0.5) out = foldStyleVariants(Style.merge(out, dark as Style) as Record<string, unknown>, selected, context) as Style;
  }
  return out as Record<string, unknown>;
}

/** Relative luminance (0–1) of `#rgb`/`#rrggbb`, or null for other colors. */
export function luminance(color: string): number | null {
  const hex = color.trim().replace(/^#/, "");
  const full = hex.length === 3 || hex.length === 4 ? [...hex.slice(0, 3)].map(c => c + c).join("") : hex.slice(0, 6);
  if (!/^[0-9a-f]{6}$/i.test(full)) return null;
  const [r, g, b] = [0, 2, 4].map(i => parseInt(full.slice(i, i + 2), 16) / 255);
  return 0.2126 * r! + 0.7152 * g! + 0.0722 * b!;
}
