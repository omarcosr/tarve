/** Node values bound to signals: style keys, text pieces and control values, resolved as the node's own. */
import { resolveStyleString, resolveThemeStyle, type ThemeDefinition } from "../theme";
import { isSignal, type Signal } from "../signal";
import { foldVariants, type VariantContext } from "./variants";

/**
 * A node's value bound to a signal: a style key (resolved like the rest of the style when the
 * signal changes) or the text, made of the pieces it was written with (`Clicks: {count}`).
 */
export interface NodeBinding {
  signal: Signal<unknown>;
  /** The style key, and the theme and viewport the node compiled with (`resolveBoundStyle`). */
  style?: { key: string; theme: ThemeDefinition; viewport: [number, number] };
  text?: unknown[];
  /** A control field (a slider's `value`), set by a patch of the node. */
  control?: "value";
}
/** A bound control value as the control takes it: a number within its `min` and `max`. */
export function boundControlValue(value: unknown, control: { min?: number; max?: number }): number {
  const number = Number(value);
  if (!Number.isFinite(number)) return control.min ?? 0;
  return Math.max(control.min ?? -Infinity, Math.min(number, control.max ?? Infinity));
}
const noop = (): void => {};
/** Writes the style values a bound signal's `value` stands for into `out`, resolved like the rest of the style. */
export function resolveBoundStyle(binding: NonNullable<NodeBinding["style"]>, value: unknown, out: Map<string, unknown>): void {
  const { key, theme: bindingTheme } = binding;
  // Strings and numbers (a colour, an opacity) resolve on their own, as resolveThemeStyle
  // would; anything else (a gradient, a shadow) goes through the whole resolution.
  if (typeof value === "string") out.set(key, resolveStyleString(key, value, bindingTheme));
  else if (typeof value === "number") out.set(key, value);
  else {
    const context: VariantContext = { viewportWidth: binding.viewport[0], viewportHeight: binding.viewport[1], usedViewport: noop, usedPosition: noop };
    const resolved = resolveThemeStyle(foldVariants({ [key]: value } as never, bindingTheme, context), bindingTheme) as Record<string, unknown>;
    for (const name in resolved) out.set(name, resolved[name]);
  }
}
/** The text of bound pieces now: signals read, the rest as written. */
export function boundText(parts: readonly unknown[]): string {
  let text = "";
  for (let index = 0; index < parts.length; index++) {
    const part = parts[index];
    if (part == null || typeof part === "boolean") continue;
    text += isSignal(part) ? String(part.value ?? "") : String(part);
  }
  return text;
}
/** Text pieces when they hold a signal: a signal, or a list of strings, numbers and signals. */
export function signalParts(children: unknown): unknown[] | undefined {
  if (isSignal(children)) return [children];
  if (!Array.isArray(children)) return undefined;
  let found = false;
  for (let index = 0; index < children.length; index++) {
    const child = children[index];
    if (isSignal(child)) found = true;
    else if (child != null && typeof child !== "string" && typeof child !== "number" && typeof child !== "boolean") return undefined;
  }
  return found ? children : undefined;
}
