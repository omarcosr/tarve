import { jsx, type Child } from "@tarve/core/jsx-runtime";
import { elementStyle } from "./css";
import { COMMENT_NODE, documentInstance, ELEMENT_NODE, setEditing, TEvent, TEXT_NODE, type TCharacterData, type TElement, type TNode } from "./dom";

/**
 * `contenteditable` as rich text: the element's text is the value of a native
 * text area, and its inline markup (`<b>`, `<em>`, `<span style>`…) styles runs
 * of that text. Edits go back into the DOM where they happened, so typing inside
 * `<b>` stays bold, and `execCommand` formats the native selection.
 */

/** Phrasing elements that style a run; any other element is a line of its own (a `<div>` per line). */
const INLINE = new Set(["span", "strong", "b", "em", "i", "cite", "var", "dfn", "u", "ins", "s", "strike", "del", "code", "kbd", "samp", "mark", "small", "sub", "sup", "a", "abbr", "font"]);
/** Tags core styles by themselves; others render as a styled span. */
const NATIVE_INLINE = new Set(["span", "strong", "b", "em", "i", "cite", "var", "dfn", "u", "ins", "s", "del", "code", "kbd", "samp", "mark", "small", "sub", "sup", "a", "abbr"]);

/** A piece of the editable text: a text node, a `<br>`, or the line break before a block. */
interface Segment { node: TNode; start: number; end: number; kind: "text" | "br" | "block" }
export interface EditableModel { text: string; segments: Segment[]; children: Child[] }

function styleOf(element: TElement): Record<string, unknown> | undefined {
  const classes = (element.getAttribute("class") ?? "").split(/\s+/).filter(Boolean);
  return elementStyle(element, classes);
}

/** The text, where each piece sits, and the phrasing children that style it. */
export function editableModel(root: TElement): EditableModel {
  let text = "";
  const segments: Segment[] = [];
  const children: Child[] = [];
  const visit = (node: TNode, chain: TElement[]): void => {
    for (let child = node._first; child; child = child._next) {
      if (child.nodeType === TEXT_NODE) {
        const data = (child as TCharacterData).data;
        if (!data) continue;
        segments.push({ node: child, start: text.length, end: text.length + data.length, kind: "text" });
        text += data;
        let piece: Child = data;
        for (let index = chain.length - 1; index >= 0; index--) {
          const element = chain[index]!;
          const style = styleOf(element);
          piece = jsx(NATIVE_INLINE.has(element.localName) ? element.localName : "span", { ...(style ? { style } : {}), children: piece });
        }
        children.push(piece);
      } else if (child.nodeType === ELEMENT_NODE) {
        const element = child as TElement;
        if (element.localName === "br") {
          segments.push({ node: element, start: text.length, end: text.length + 1, kind: "br" });
          text += "\n";
          children.push("\n");
        } else if (INLINE.has(element.localName)) {
          visit(element, [...chain, element]);
        } else {
          // A block (Chromium makes a <div> per line): it starts a new line.
          if (text && !text.endsWith("\n")) {
            segments.push({ node: element, start: text.length, end: text.length + 1, kind: "block" });
            text += "\n";
            children.push("\n");
          }
          visit(element, chain);
        }
      } else if (child.nodeType !== COMMENT_NODE) visit(child, chain);
    }
  };
  visit(root, []);
  return { text, segments, children };
}

/** The common prefix and suffix of two strings, never splitting a surrogate pair. */
function changedRange(before: string, after: string): { start: number; end: number; inserted: string } {
  let prefix = 0;
  const limit = Math.min(before.length, after.length);
  while (prefix < limit && before.charCodeAt(prefix) === after.charCodeAt(prefix)) prefix++;
  if (prefix > 0 && prefix < limit && isLowSurrogate(before.charCodeAt(prefix))) prefix--;
  let suffix = 0;
  while (suffix < limit - prefix && before.charCodeAt(before.length - 1 - suffix) === after.charCodeAt(after.length - 1 - suffix)) suffix++;
  if (suffix > 0 && isLowSurrogate(before.charCodeAt(before.length - suffix))) suffix--;
  return { start: prefix, end: before.length - suffix, inserted: after.slice(prefix, after.length - suffix) };
}
const isLowSurrogate = (code: number) => code >= 0xdc00 && code <= 0xdfff;

/** Applies a native edit (the whole new value) to the DOM. */
export function applyValue(root: TElement, value: string): { inputType: string; data: string | null } | undefined {
  const model = editableModel(root);
  if (model.text === value) return undefined;
  const { start, end, inserted } = changedRange(model.text, value);
  replaceRange(root, start, end, inserted, model);
  return {
    inputType: inserted.includes("\n") && end === start ? "insertLineBreak" : inserted ? (end > start ? "insertReplacementText" : "insertText") : "deleteContent" + (value.length < model.text.length ? "Backward" : ""),
    data: inserted || null,
  };
}

/** Replaces text [start, end) with `inserted`, which takes the style of the text before `start`. */
export function replaceRange(root: TElement, start: number, end: number, inserted: string, model = editableModel(root)): void {
  // Where the new text goes: the text node that ends at (or contains) start, else the one starting there.
  let anchor: Segment | undefined;
  for (const segment of model.segments) {
    if (segment.kind !== "text") continue;
    if (segment.start < start && start <= segment.end) { anchor = segment; break; }
    if (segment.start === start && start === 0 && !anchor) anchor = segment;
  }
  anchor ??= model.segments.find(segment => segment.kind === "text" && segment.start === start);
  // Delete, from the end so earlier offsets stay valid.
  for (const segment of [...model.segments].reverse()) {
    const from = Math.max(start, segment.start);
    const to = Math.min(end, segment.end);
    if (from >= to) continue;
    if (segment.kind === "text") {
      const node = segment.node as TCharacterData;
      node.data = node.data.slice(0, from - segment.start) + node.data.slice(to - segment.start);
    } else if (segment.kind === "br") segment.node.remove();
    else {
      // The line break before a block: the block's content joins the line before.
      const block = segment.node as TElement;
      while (block._first) block.parentNode!.insertBefore(block._first, block);
      block.remove();
    }
  }
  if (inserted) {
    const lines = inserted.split("\n");
    let node: TCharacterData;
    let tail = "";
    if (anchor && anchor.node.parentNode) {
      node = anchor.node as TCharacterData;
      const offset = Math.min(start - anchor.start, node.data.length);
      tail = node.data.slice(offset);
      node.data = node.data.slice(0, offset) + lines[0];
    } else {
      // No text there yet (empty editor, next to a <br>): a new text node at that point.
      node = documentInstance.createTextNode(lines[0]!);
      const after = model.segments.find(segment => segment.start >= start && segment.node.parentNode);
      if (after) after.node.parentNode!.insertBefore(node, after.node); else root.appendChild(node);
    }
    let last = node;
    for (const line of lines.slice(1)) {
      const br = documentInstance.createElement("br");
      last.parentNode!.insertBefore(br, last._next);
      const next = documentInstance.createTextNode(line);
      br.parentNode!.insertBefore(next, br._next);
      last = next;
    }
    if (tail) last.data += tail;
  }
  for (const segment of model.segments) {
    if (segment.kind === "text" && !(segment.node as TCharacterData).data && segment.node.parentNode) segment.node.remove();
  }
}

/** Splits text nodes at start and end and returns the text nodes inside [start, end). */
function textNodesIn(root: TElement, start: number, end: number): TCharacterData[] {
  const model = editableModel(root);
  const nodes: TCharacterData[] = [];
  for (const segment of model.segments) {
    if (segment.kind !== "text" || segment.end <= start || segment.start >= end) continue;
    let node = segment.node as TCharacterData;
    const from = Math.max(start, segment.start) - segment.start;
    const to = Math.min(end, segment.end) - segment.start;
    if (to < node.data.length) {
      const after = documentInstance.createTextNode(node.data.slice(to));
      node.parentNode!.insertBefore(after, node._next);
      node.data = node.data.slice(0, to);
    }
    if (from > 0) {
      const inside = documentInstance.createTextNode(node.data.slice(from));
      node.parentNode!.insertBefore(inside, node._next);
      node.data = node.data.slice(0, from);
      node = inside;
    }
    nodes.push(node);
  }
  return nodes;
}

const FORMATS: Record<string, { tags: string[]; wrap: string; off: string; style: (style: Record<string, unknown>) => boolean | undefined }> = {
  bold: { tags: ["b", "strong"], wrap: "b", off: "font-weight: 400", style: s => s.fontWeight === undefined ? undefined : Number(s.fontWeight) >= 600 || s.fontWeight === "bold" },
  italic: { tags: ["i", "em"], wrap: "i", off: "font-style: normal", style: s => s.fontStyle === undefined ? undefined : s.fontStyle === "italic" },
  underline: { tags: ["u", "ins"], wrap: "u", off: "text-decoration: none", style: s => s.textDecoration === undefined ? undefined : String(s.textDecoration).includes("underline") },
  strikethrough: { tags: ["s", "strike", "del"], wrap: "s", off: "text-decoration: none", style: s => s.textDecoration === undefined ? undefined : String(s.textDecoration).includes("line-through") },
};

/** Whether a format applies to a text node: the nearest element that sets it decides. */
function formatted(node: TNode, root: TElement, format: (typeof FORMATS)[string]): boolean {
  for (let element = node.parentElement; element && element !== root; element = element.parentElement) {
    const own = element.getAttribute("style") ? format.style(styleOf(element) ?? {}) : undefined;
    if (own !== undefined) return own;
    if (format.tags.includes(element.localName)) return true;
  }
  return false;
}

/** Joins a new format element with a plain neighbour of the same tag: `<b>a</b><b>b</b>` → `<b>ab</b>`. */
function mergeSiblings(element: TElement): void {
  const same = (node: TNode | null): node is TElement => !!node && node.nodeType === ELEMENT_NODE && (node as TElement).localName === element.localName && !(node as TElement).attributes?.length;
  const previous = element._prev;
  if (same(previous)) {
    while (element._first) previous.appendChild(element._first);
    element.remove();
    element = previous;
  }
  const next = element._next;
  if (same(next)) {
    while (next._first) element.appendChild(next._first);
    next.remove();
  }
}

/** execCommand bold / italic / underline / strikeThrough over [start, end). */
export function toggleFormat(root: TElement, command: string, start: number, end: number): boolean {
  const format = FORMATS[command];
  if (!format || start >= end) return false;
  const nodes = textNodesIn(root, start, end);
  if (!nodes.length) return false;
  const on = !nodes.every(node => formatted(node, root, format));
  for (const node of nodes) {
    if (formatted(node, root, format) === on) continue;
    const parent = node.parentElement!;
    // The node alone in a tag that sets exactly this: unwrap it instead of nesting an override.
    const alone = parent !== root && parent._first === node && parent._last === node;
    if (alone && (on ? (parent.getAttribute("style") ?? "").replace(/;\s*$/, "") === format.off : format.tags.includes(parent.localName) && !parent.getAttribute("style"))) {
      parent.parentNode!.insertBefore(node, parent);
      parent.remove();
      continue;
    }
    const wrapper = documentInstance.createElement(on ? format.wrap : "span");
    if (!on) wrapper.setAttribute("style", format.off);
    parent.insertBefore(wrapper, node);
    wrapper.appendChild(node);
    if (on) mergeSiblings(wrapper);
  }
  return true;
}

export function queryFormat(root: TElement, command: string, position: number): boolean {
  const format = FORMATS[command];
  if (!format) return false;
  const model = editableModel(root);
  const segment = model.segments.find(item => item.kind === "text" && item.start < position && position <= item.end)
    ?? model.segments.find(item => item.kind === "text" && item.start === position);
  return !!segment && formatted(segment.node, root, format);
}

/** A DOM position (node, offset) for a text offset, as Selection and Range report it. */
export function domPosition(root: TElement, offset: number): { node: TNode; offset: number } {
  const model = editableModel(root);
  for (const segment of model.segments) {
    if (segment.kind === "text" && segment.start <= offset && offset <= segment.end) return { node: segment.node, offset: offset - segment.start };
  }
  const children = root.childNodes;
  const after = model.segments.find(segment => segment.start >= offset);
  const index = after ? children.indexOf(after.node) : -1;
  return { node: root, offset: index >= 0 ? index : children.length };
}

export function fireInput(root: TElement, inputType: string, data: string | null): void {
  root.dispatchEvent(new TEvent("input", { bubbles: true, inputType, data, isComposing: false }));
}

/** The UTF-16 index of a UTF-8 offset (native reports selections in UTF-8). */
export function utf16Offset(text: string, bytes: number): number {
  let count = 0;
  for (let index = 0; index < text.length; index++) {
    if (count >= bytes) return index;
    const code = text.charCodeAt(index);
    if (code < 0x80) count += 1;
    else if (code < 0x800) count += 2;
    else if (code >= 0xd800 && code <= 0xdbff) { count += 4; index++; }
    else count += 3;
  }
  return text.length;
}

/** The focused editable's selection (UTF-16 offsets into its text), asked of native synchronously. */
export interface TextSelection { element: TElement; anchor: number; focus: number }
let readSelection: (() => TextSelection | undefined) | undefined;
export function setSelectionReader(next: (() => TextSelection | undefined) | undefined): void { readSelection = next; }

export function textOfEditable(element: TElement): string {
  return element.isContentEditable ? editableModel(element).text : element.value ?? "";
}

class TRange {
  constructor(readonly startContainer: TNode, readonly startOffset: number, readonly endContainer: TNode, readonly endOffset: number, private readonly text: string) {}
  get collapsed(): boolean { return this.startContainer === this.endContainer && this.startOffset === this.endOffset; }
  get commonAncestorContainer(): TNode {
    for (let node: TNode | null = this.startContainer; node; node = node.parentNode) if (node.contains(this.endContainer)) return node;
    return this.startContainer;
  }
  toString(): string { return this.text; }
  cloneRange(): TRange { return this; }
  getBoundingClientRect() { return (this.startContainer.nodeType === ELEMENT_NODE ? this.startContainer as TElement : this.startContainer.parentElement)?.getBoundingClientRect(); }
}

/** window.getSelection(): the native selection inside a contenteditable (read-only: native owns the caret). */
class TSelection {
  anchorNode: TNode | null = null;
  anchorOffset = 0;
  focusNode: TNode | null = null;
  focusOffset = 0;
  private range?: TRange;
  constructor(selection?: TextSelection) {
    if (!selection?.element.isContentEditable) return;
    const { element, anchor, focus } = selection;
    const start = Math.min(anchor, focus), end = Math.max(anchor, focus);
    const a = domPosition(element, anchor), f = domPosition(element, focus);
    this.anchorNode = a.node; this.anchorOffset = a.offset;
    this.focusNode = f.node; this.focusOffset = f.offset;
    const s = anchor <= focus ? a : f, e = anchor <= focus ? f : a;
    this.range = new TRange(s.node, s.offset, e.node, e.offset, editableModel(element).text.slice(start, end));
  }
  get rangeCount(): number { return this.range ? 1 : 0; }
  get isCollapsed(): boolean { return !this.range || this.range.collapsed; }
  get type(): string { return !this.range ? "None" : this.range.collapsed ? "Caret" : "Range"; }
  getRangeAt(index: number): TRange {
    if (index !== 0 || !this.range) throw new RangeError("The index is not in the allowed range.");
    return this.range;
  }
  toString(): string { return this.range?.toString() ?? ""; }
  containsNode(node: TNode): boolean { return !!this.range && this.range.commonAncestorContainer.contains(node); }
  removeAllRanges(): void {}
  addRange(): void {}
  collapse(): void {}
  collapseToEnd(): void {}
  collapseToStart(): void {}
}

const COMMANDS: Record<string, string> = { bold: "bold", italic: "italic", underline: "underline", strikethrough: "strikethrough" };

/** document.execCommand over the native selection of the focused contenteditable. */
function execCommand(command: string, _ui?: boolean, value?: string): boolean {
  const selection = readSelection?.();
  if (!selection?.element.isContentEditable) return false;
  const { element } = selection;
  let start = Math.min(selection.anchor, selection.focus), end = Math.max(selection.anchor, selection.focus);
  const name = command.toLowerCase();
  const format = COMMANDS[name];
  if (format) {
    if (!toggleFormat(element, format, start, end)) return false;
    fireInput(element, "format" + format[0]!.toUpperCase() + format.slice(1).replace("through", "Through"), null);
    return true;
  }
  const text = editableModel(element).text;
  let inserted = "";
  let inputType: string;
  if (name === "inserttext") { inserted = String(value ?? ""); inputType = "insertText"; }
  else if (name === "insertlinebreak" || name === "insertparagraph") { inserted = "\n"; inputType = name === "insertlinebreak" ? "insertLineBreak" : "insertParagraph"; }
  else if (name === "delete") { if (start === end) start = Math.max(0, start - 1); inputType = "deleteContentBackward"; }
  else if (name === "forwarddelete") { if (start === end) end = Math.min(text.length, end + 1); inputType = "deleteContentForward"; }
  else return false;
  if (start === end && !inserted) return false;
  replaceRange(element, start, end, inserted);
  fireInput(element, inputType, inserted || null);
  return true;
}

function queryCommandState(command: string): boolean {
  const format = COMMANDS[command.toLowerCase()];
  const selection = format ? readSelection?.() : undefined;
  if (!format || !selection?.element.isContentEditable) return false;
  return queryFormat(selection.element, format, Math.min(selection.anchor, selection.focus));
}

setEditing({
  getSelection: () => new TSelection(readSelection?.()),
  execCommand,
  queryCommandState,
  queryCommandSupported: command => command.toLowerCase() in COMMANDS || ["inserttext", "insertlinebreak", "insertparagraph", "delete", "forwarddelete"].includes(command.toLowerCase()),
  selectionOf: element => {
    const selection = readSelection?.();
    return selection && selection.element === element ? { start: Math.min(selection.anchor, selection.focus), end: Math.max(selection.anchor, selection.focus), backward: selection.focus < selection.anchor } : undefined;
  },
});
