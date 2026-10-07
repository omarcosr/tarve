import type { TextRun } from "../../protocol/src/index";
import { Fragment, type Child, type VNode } from "./jsx-runtime";
import { canonicalizeIntrinsicStyle } from "./intrinsic-style";

/**
 * Inline content of a text node, flattened the way a browser lays out a
 * paragraph: phrasing elements (`<strong>`, `<a>`, nested `<span>`…) become
 * styled runs over one string, and white space follows CSS `white-space`.
 */

/** User-agent styles of phrasing elements, as in Chromium's html.css. */
const INLINE_TAGS: Record<string, Record<string, unknown>> = {
  span: {}, strong: { fontWeight: "bolder" }, b: { fontWeight: "bolder" },
  em: { fontStyle: "italic" }, i: { fontStyle: "italic" }, cite: { fontStyle: "italic" }, var: { fontStyle: "italic" }, dfn: { fontStyle: "italic" },
  u: { textDecoration: "underline" }, ins: { textDecoration: "underline" },
  s: { textDecoration: "line-through" }, del: { textDecoration: "line-through" },
  code: { fontFamily: "monospace" }, kbd: { fontFamily: "monospace" }, samp: { fontFamily: "monospace" },
  mark: { background: "#ffff00", foreground: "#000000" },
  small: { fontSize: "smaller" },
  sub: { verticalAlign: "sub", fontSize: "smaller" },
  sup: { verticalAlign: "super", fontSize: "smaller" },
  a: { textDecoration: "underline" },
  abbr: {},
};
export const INLINE_TAG_NAMES = new Set([...Object.keys(INLINE_TAGS), "br"]);

const RUN_KEYS = ["fontWeight", "fontStyle", "fontSize", "fontFamily", "foreground", "background", "textDecoration", "letterSpacing", "wordSpacing", "textTransform", "baselineShift", "textDecorationStyle"] as const;
type RunStyle = Record<string, unknown>;
type Piece = { text: string; style: RunStyle; id?: string; transform?: string } | { br: true };

export interface InlineContext {
  /** Computed style of the text node itself: inheritance starts here. */
  base: RunStyle;
  linkColor: string;
  /** Resolves theme tokens in a run style. */
  resolve(style: RunStyle): RunStyle;
  /** Registers a click target for a run and returns its id. */
  register(id: string | undefined, onClick: () => void): string;
  openExternal(href: string): void;
}

function pick(style: Record<string, unknown> | undefined): RunStyle {
  const out: RunStyle = {};
  if (!style) return out;
  for (const key of RUN_KEYS) if (style[key] !== undefined) out[key] = style[key];
  return out;
}

/** CSS relative font-weight and font-size keywords against the parent value. */
function computeStyle(parent: RunStyle, own: RunStyle): RunStyle {
  const next = { ...parent, ...own };
  if (own.fontWeight === "bolder") {
    const weight = Number(parent.fontWeight ?? 400);
    next.fontWeight = weight < 350 ? 400 : weight < 550 ? 700 : 900;
  } else if (own.fontWeight === "lighter") {
    const weight = Number(parent.fontWeight ?? 400);
    next.fontWeight = weight < 550 ? 100 : weight < 750 ? 400 : 700;
  }
  // Chromium: super raises by the parent font size / 3 + 1px, sub lowers by / 5 + 1px;
  // nested shifts add up.
  if (own.verticalAlign === "super" || own.verticalAlign === "sub") {
    const size = Number(parent.fontSize ?? 14);
    const shift = own.verticalAlign === "super" ? size / 3 + 1 : -(size / 5 + 1);
    next.baselineShift = Math.round((Number(parent.baselineShift ?? 0) + shift) * 100) / 100;
  }
  delete next.verticalAlign;
  if (own.fontSize === "smaller") next.fontSize = Number(parent.fontSize ?? 14) / 1.2;
  else if (own.fontSize === "larger") next.fontSize = Number(parent.fontSize ?? 14) * 1.2;
  if (own.textDecoration !== undefined && parent.textDecoration && parent.textDecoration !== "none" && own.textDecoration !== "none") {
    const lines = new Set(`${parent.textDecoration} ${own.textDecoration}`.split(/\s+/));
    next.textDecoration = [...lines].join(" ");
  }
  return next;
}

function transformText(text: string, transform: unknown, wordStart: boolean): string {
  if (transform === "uppercase") return text.toUpperCase();
  if (transform === "lowercase") return text.toLowerCase();
  if (transform === "capitalize") {
    let start = wordStart;
    let out = "";
    for (const char of text) {
      out += start && /\p{L}/u.test(char) ? char.toUpperCase() : char;
      start = /\s/.test(char);
    }
    return out;
  }
  return text;
}

function utf8Length(text: string): number {
  let length = 0;
  for (let index = 0; index < text.length; index++) {
    const code = text.charCodeAt(index);
    if (code < 0x80) length += 1;
    else if (code < 0x800) length += 2;
    else if (code >= 0xd800 && code <= 0xdbff) { length += 4; index++; }
    else length += 3;
  }
  return length;
}

function collect(child: Child, style: RunStyle, id: string | undefined, ctx: InlineContext, out: Piece[]): void {
  if (child == null || typeof child === "boolean") return;
  if (Array.isArray(child)) {
    for (const item of child) collect(item, style, id, ctx, out);
    return;
  }
  if (typeof child === "string" || typeof child === "number") {
    out.push({ text: String(child), style, id });
    return;
  }
  const node = child as VNode;
  if (node.type === Fragment || node.type === "fragment") {
    collect(node.props.children, style, id, ctx, out);
    return;
  }
  if (typeof node.type === "function") {
    collect(node.type(node.props), style, id, ctx, out);
    return;
  }
  const props = node.props as Record<string, any>;
  if (node.type === "br") {
    out.push({ br: true });
    return;
  }
  if (node.type === "text") {
    // A nested Text component: its explicit style applies to the run.
    collect(props.children, computeStyle(style, pick(props.style)), id, ctx, out);
    return;
  }
  if (typeof node.type !== "string" || !(node.type in INLINE_TAGS) || (node.type === "code" && props.code !== undefined)) {
    throw new Error(`<${String(node.type)}> cannot be inside text; only phrasing elements (span, strong, em, a, code, br…) can.`);
  }
  const own: RunStyle = { ...INLINE_TAGS[node.type] };
  // Chromium: abbr[title] { text-decoration: underline dotted }.
  if (node.type === "abbr" && props.title) { own.textDecoration = "underline"; own.textDecorationStyle = "dotted"; }
  if (node.type === "a") own.foreground = ctx.linkColor;
  Object.assign(own, pick(canonicalizeIntrinsicStyle(props.style) as Record<string, unknown>));
  if (props.size !== undefined) own.fontSize = props.size;
  if (props.weight !== undefined) own.fontWeight = props.weight;
  if (props.color !== undefined) own.foreground = props.color;
  let runId = id;
  const href = node.type === "a" && typeof props.href === "string" ? props.href : undefined;
  if (props.onClick || href) {
    const onClick = props.onClick as (() => void) | undefined;
    runId = ctx.register(props.id, () => {
      if (props.disabled) return;
      onClick?.();
      if (href) ctx.openExternal(href);
    });
  }
  collect(props.children, computeStyle(style, ctx.resolve(own)), runId, ctx, out);
}

export function hasInlineElements(children: Child): boolean {
  if (Array.isArray(children)) return children.some(hasInlineElements);
  return children != null && typeof children === "object";
}

/** Flattens inline children into text plus runs, applying CSS white-space. */
export function compileInline(children: Child, whiteSpace: string, ctx: InlineContext): { text: string; runs: TextRun[] } {
  const pieces: Piece[] = [];
  collect(children, ctx.base, undefined, ctx, pieces);
  const collapseSpaces = whiteSpace === "normal" || whiteSpace === "nowrap" || whiteSpace === "pre-line";
  const keepNewlines = whiteSpace !== "normal" && whiteSpace !== "nowrap";
  let text = "";
  let bytes = 0;
  const runs: TextRun[] = [];
  let pendingSpace = false;
  let lineStart = true;
  let wordStart = true;
  const append = (value: string) => {
    text += value;
    bytes += utf8Length(value);
  };
  // A collapsed space belongs to the element it came from (its font sizes the
  // gap); a space left at the end of a line is removed, as CSS does.
  const trimLineEnd = () => {
    if (!text.endsWith(" ") || !pendingSpace) return;
    text = text.slice(0, -1);
    bytes -= 1;
    for (const run of runs) if (run.end > bytes) run.end = bytes;
    while (runs.length && runs.at(-1)!.end <= runs.at(-1)!.start) runs.pop();
  };
  for (const piece of pieces) {
    if ("br" in piece) {
      trimLineEnd();
      append("\n");
      pendingSpace = false;
      lineStart = true;
      wordStart = true;
      continue;
    }
    const start = bytes;
    const source = piece.text.replace(/\r\n?/g, "\n");
    if (!collapseSpaces) {
      append(transformText(source, piece.style.textTransform, wordStart));
      if (source) wordStart = /\s$/.test(source);
    } else {
      for (const char of source) {
        if (char === "\n" && keepNewlines) {
          trimLineEnd();
          append("\n");
          pendingSpace = false;
          lineStart = true;
          wordStart = true;
        } else if (char === " " || char === "\t" || char === "\n" || char === "\f") {
          if (!lineStart && !pendingSpace) {
            append(" ");
            pendingSpace = true;
            wordStart = true;
          }
        } else {
          pendingSpace = false;
          append(transformText(char, piece.style.textTransform, wordStart));
          wordStart = false;
          lineStart = false;
        }
      }
    }
    const style: RunStyle = {};
    for (const key of RUN_KEYS) {
      if (key === "textTransform") continue;
      if (piece.style[key] !== undefined && piece.style[key] !== ctx.base[key]) style[key] = piece.style[key];
    }
    if (bytes > start && (Object.keys(style).length > 0 || piece.id)) {
      const last = runs.at(-1);
      if (last && last.end === start && last.id === piece.id && JSON.stringify(last.style) === JSON.stringify(style)) last.end = bytes;
      else runs.push({ start, end: bytes, style, ...(piece.id ? { id: piece.id } : {}) });
    }
  }
  trimLineEnd();
  return { text, runs };
}
