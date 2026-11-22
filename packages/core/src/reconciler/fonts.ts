/** CSS font inheritance: what a node passes to its descendants and what it takes from its parent. */
import { theme } from "../theme";

/**
 * Font properties a node passes to its descendants, as CSS inherits them. The
 * theme font is the initial value at the root; Code, Diff and `<code>` set
 * monospace explicitly, like the user-agent style sheet.
 */
export const INHERITED_FONT = ["fontFamily", "fontStyle", "letterSpacing", "wordSpacing", "fontVariantNumeric", "fontFeatureSettings", "fontSize", "fontWeight", "lineHeight", "foreground", "textAlign", "textTransform", "whiteSpace", "textShadow"] as const;
export const INHERITED_FONT_SET: ReadonlySet<string> = new Set(INHERITED_FONT);
/** The computed value of `text-align: match-parent` under a parent whose computed value is `parent`. */
export function matchParentTextAlign(parent: unknown): string {
  if (parent === undefined || parent === "start" || parent === "match-parent") return "left";
  if (parent === "end") return "right";
  return String(parent);
}
/** Inherited font values that controls (buttons, inputs, code) take too. */
export const CONTROL_FONT = ["fontFamily", "fontStyle", "letterSpacing", "wordSpacing", "textTransform"] as const;
/** Kinds whose text takes every inherited value; controls keep their own size, weight and colour. */
export const INHERITING_TEXT = new Set(["text", "markdown"]);
export const TEXT_KINDS = new Set(["text", "button", "input", "textarea", "markdown", "code", "diff"]);

/**
 * A node's resolved style with what it inherits written in (CSS inherited font properties,
 * `text-align: match-parent`), and the inherited font its children get.
 */
export function finishStyle(
  fontStyle: Record<string, unknown>, parentFont: Record<string, unknown>, fontClass: "inherit" | "control" | "none",
  /** The CSS initial font values (the theme's), for what nothing above sets. */
  initialFont: () => Record<string, unknown>,
): Record<string, unknown> {
  // CSS `text-align: match-parent` computes to the parent's value, with start/end resolved against the
  // parent's direction (left-to-right: there is no `direction` property), so descendants inherit left/right.
  if (fontStyle.textAlign === "match-parent") fontStyle.textAlign = matchParentTextAlign(parentFont.textAlign);
  if (fontClass === "inherit") {
    const initial = initialFont();
    for (let index = 0; index < INHERITED_FONT.length; index++) {
      const key = INHERITED_FONT[index]!;
      if (fontStyle[key] !== undefined) continue;
      const value = parentFont[key] ?? initial[key];
      if (value !== undefined) fontStyle[key] = value;
    }
  } else if (fontClass === "control") {
    for (const key of CONTROL_FONT) {
      if (fontStyle[key] === undefined && parentFont[key] !== undefined) fontStyle[key] = parentFont[key];
    }
    fontStyle.fontFamily ??= theme.font.family;
  }
  let ownFont = parentFont;
  // A style has a few keys; INHERITED_FONT has thirteen.
  for (const key in fontStyle) {
    if (!INHERITED_FONT_SET.has(key)) continue;
    const value = fontStyle[key];
    if (value !== undefined && value !== parentFont[key]) {
      if (ownFont === parentFont) ownFont = { ...parentFont };
      ownFont[key] = value;
    }
  }
  return ownFont;
}
