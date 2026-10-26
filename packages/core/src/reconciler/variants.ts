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

export function foldVariants(style: Record<string, unknown>, selected: ThemeDefinition, context: VariantContext): Record<string, unknown> {
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
    if (themed !== null && themed < 0.5) out = foldVariants(Style.merge(out, dark as Style) as Record<string, unknown>, selected, context) as Style;
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
