import { Code, Column, Markdown, memo, Row, Scroll, Text, TitleBar, tw, View } from "@tarve/core";
import { jsx, type Child, type VNode } from "@tarve/core/jsx-runtime";
import { elementStyle, isComponentClass, usesPreflight } from "./css";
import { camelCase, COMMENT_NODE, documentInstance, ELEMENT_NODE, elementToClient, layout, scheduleIntersections, TDataTransfer, TEvent, TEXT_NODE, windowInstance, type TCharacterData, type TElement, type THTMLMediaElement, type TNode } from "./dom";
import { generatedContent, type GeneratedContent } from "./css";
import { applyValue, editableModel, fireInput } from "./editable";

/**
 * Turns the Svelte-owned DOM into Tarve VNodes. Every element is a memoized
 * component keyed by its own identity and version: a Svelte update touches only
 * the elements it changed (and their ancestors), so the reconciler re-renders
 * that path and reuses every other compiled subtree without rendering or diffing it.
 */

const NATIVE: Record<string, (props: any) => VNode> = { row: Row, column: Column, view: View, scroll: Scroll, text: Text, markdown: Markdown, code: Code };
const INLINE = new Set(["span", "strong", "b", "em", "i", "cite", "var", "dfn", "u", "ins", "s", "del", "code", "kbd", "samp", "mark", "small", "sub", "sup", "a", "abbr", "br"]);
/** Elements whose content is one run of text with inline markup. */
const TEXT_CONTAINERS = new Set(["p", "span", "h1", "h2", "h3", "h4", "h5", "h6", "label", "a", "text", "legend", "summary", "dt", "caption", "th", "td", "option", ...INLINE]);
/** Intrinsics the reconciler expands; any other tag (section, header, nav…) is a block `div`. */
const KNOWN = new Set(["div", "audio", "p", "span", "h1", "h2", "h3", "h4", "h5", "h6", "img", "form", "audio", "canvas", "input", "textarea", "button", "a", "svg", "label", "select", "progress", "hr",
  "pre", "blockquote", "meter", "fieldset", "legend", "ul", "ol", "li", "dl", "dt", "dd", "table", "thead", "tbody", "tfoot", "tr", "th", "td", "caption", "details", "summary", ...INLINE]);
const BOOLEAN = new Set(["disabled", "checked", "selected", "required", "readonly", "multiple", "hidden", "open", "autofocus", "draggable", "drag-region", "focusable"]);
const SKIPPED = new Set(["class", "style", "role", "xmlns"]);
/** Elements the pointer is over (per native's reports): kept across rebuilds of their handlers. */
const pointerInside = new WeakSet<TElement>();
const HOVER = ["mouseenter", "mouseleave", "mouseover", "mouseout", "pointerenter", "pointerleave", "pointerover", "pointerout"];
const SCOPE_CLASS = /^svelte-[a-z0-9]+$/;

let eventsSymbol: symbol | undefined;
/** Event types Svelte handles on `element`: its listeners and its delegated handlers. */
function interest(element: TElement): Set<string> {
  const out = new Set<string>(element._listeners?.keys());
  if (!eventsSymbol) {
    for (const symbol of Object.getOwnPropertySymbols(element)) if (symbol.description === "events") eventsSymbol = symbol;
  }
  const delegated = eventsSymbol ? (element as unknown as Record<symbol, Record<string, unknown> | undefined>)[eventsSymbol] : undefined;
  if (delegated) for (const type of Object.keys(delegated)) if (delegated[type] != null) out.add(type);
  return out;
}

/** The last pointer position a `mousemove` listener saw: clicks carry it as their coordinates. */
const pointer: { position: { clientX: number; clientY: number; pageX: number; pageY: number; screenX: number; screenY: number } | Record<string, never> } = { position: {} };

export function setPointerPosition(x: number, y: number): void {
  pointer.position = { clientX: x, clientY: y, pageX: x, pageY: y, screenX: x, screenY: y };
}

function fire(element: TElement, type: string, init: Record<string, unknown> = {}): TEvent {
  const event = new TEvent(type, { bubbles: true, cancelable: true, ...init });
  element.dispatchEvent(event);
  return event;
}

/** Fires each type Svelte listens for, in order. */
function fireAll(element: TElement, types: readonly string[], wanted: Set<string>, init?: Record<string, unknown>): void {
  for (const type of types) if (wanted.has(type)) fire(element, type, init);
}

function settle(node: TNode): void {
  node._pending = false;
  for (let child = node._first; child; child = child._next) if (child.nodeType === ELEMENT_NODE) settle(child);
}

function textOf(node: TNode): string {
  if (node.nodeType === TEXT_NODE) return (node as TCharacterData).data;
  if (node.nodeType === COMMENT_NODE) return "";
  if (node.nodeType === ELEMENT_NODE && (node as TElement).localName === "br") return "\n";
  let out = "";
  for (let child = node._first; child; child = child._next) out += textOf(child);
  return out;
}

const NON_BLANK = /\S/;
function isBlank(node: TNode): boolean {
  return node.nodeType === COMMENT_NODE || (node.nodeType === TEXT_NODE && !NON_BLANK.test((node as TCharacterData).data));
}

/** Native node ids of rendered elements: native events name the node, Svelte wants the element. */
const elementsById = new Map<string, WeakRef<TElement>>();

/** The element a native node id belongs to (a control's inner nodes, like `<id>-trigger`, too). */
export function elementForNativeId(id: string | null | undefined): TElement | undefined {
  for (let candidate = id; candidate; ) {
    const ref = elementsById.get(candidate);
    const element = ref?.deref();
    if (element) return element;
    if (ref) elementsById.delete(candidate);
    const cut = Math.max(candidate.lastIndexOf("/"), candidate.lastIndexOf("-"));
    candidate = cut > 0 ? candidate.slice(0, cut) : undefined;
  }
  return undefined;
}

/** The native id an element renders with: its own `id`, else one from its stable key. */
export function nativeIdOf(element: TElement): string {
  return element.getAttribute("id") ?? "s" + element._key;
}

function props(element: TElement, tag: string): Record<string, any> {
  const out: Record<string, any> = {};
  const id = nativeIdOf(element);
  out.id = id;
  if (elementsById.get(id)?.deref() !== element) elementsById.set(id, new WeakRef(element));
  for (const [name, value] of element._attributes) {
    if (SKIPPED.has(name) || name.startsWith("data-") || name.startsWith("on")) continue;
    if (name === "for") out.htmlFor = value;
    else if (name === "tabindex") out.focusable = Number(value) >= 0;
    else if (name === "aria-label") out.ariaLabel = value;
    else if (name.startsWith("aria-")) continue;
    else if (BOOLEAN.has(name)) out[name === "readonly" ? "readOnly" : camelCase(name)] = value !== "false";
    else out[tag === "svg" || element.namespaceURI.endsWith("svg") ? (name === "viewBox" ? name : camelCase(name)) : camelCase(name)] = value;
  }
  const classes = (element._attributes.get("class") ?? "").split(/\s+/).filter(Boolean);
  const style = elementStyle(element, classes);
  // CSS: `display: flex` lays out in a row unless flex-direction says otherwise, whatever the element.
  if (style) out.style = inheritValues(element, style);
  if (out.style && "inline" in out.style) out.style = inlineLevel(element, out.style);
  // Classes the component's own CSS selects are not Tailwind utilities (`.filter`, `.container`).
  const plain = classes.filter(name => !SCOPE_CLASS.test(name) && !isComponentClass(name));
  if (plain.length) out.class = plain.join(" ");
  // Tailwind's preflight: headings and paragraphs inherit their font and lose their margins.
  if (PREFLIGHT_TEXT.has(tag) && usesPreflight()) out.userAgentStyles = false;
  // CSS: `display: flex` lays out in a row unless flex-direction says otherwise, whatever the element.
  if (displayOf(out) === "flex" && out.style?.direction === undefined && !/(^|\s)flex-(row|col)/.test(out.class ?? "")) out.style = { ...out.style, direction: "row" };
  if (out.hidden) { out.style = { ...out.style, display: "none" }; delete out.hidden; }
  return out;
}

/** The HTML drag in progress between elements of the app. */
let drag: { source: TElement; data: TDataTransfer; over?: TElement; accepted: boolean } | undefined;

function addDragAndDrop(element: TElement, wanted: Set<string>, out: Record<string, any>): void {
  if (element.getAttribute("draggable") === "true") {
    out.draggable = true;
    // Native drags interactive nodes only: a plain element becomes pressable.
    out.onClick ??= () => {};
    out.onDragStart = (position: { x: number; y: number }) => {
      drag = { source: element, data: new TDataTransfer(), accepted: false };
      const event = fire(element, "dragstart", { dataTransfer: drag.data, clientX: position.x, clientY: position.y });
      if (event.defaultPrevented) drag = undefined;
    };
    out.onDragMove = (event: { x: number; y: number; over: string | null }) => {
      if (!drag) return;
      const init = { dataTransfer: drag.data, clientX: event.x, clientY: event.y };
      fire(element, "drag", init);
      const over = elementForNativeId(event.over);
      if (over !== drag.over) {
        if (drag.over) fire(drag.over, "dragleave", init);
        if (over) fire(over, "dragenter", init);
        drag.over = over;
        drag.accepted = false;
      }
      // As in HTML, a target accepts the drop by cancelling dragover.
      if (over) drag.accepted = fire(over, "dragover", init).defaultPrevented;
    };
    out.onDragEnd = (event: { x: number; y: number; target: string | null; cancelled: boolean }) => {
      if (!drag) return;
      const init = { dataTransfer: drag.data, clientX: event.x, clientY: event.y };
      const target = elementForNativeId(event.target) ?? drag.over;
      if (!event.cancelled && target && drag.accepted) {
        drag.data.dropEffect = drag.data.dropEffect === "none" ? "move" : drag.data.dropEffect;
        fire(target, "drop", init);
      } else if (drag.over) fire(drag.over, "dragleave", init);
      fire(element, "dragend", init);
      drag = undefined;
    };
  }
  if (wanted.has("drop") || wanted.has("dragover") || wanted.has("dragenter")) out.dropTarget = true;
}

function addMedia(element: THTMLMediaElement, out: Record<string, any>): void {
  out.onLoadedMetadata = (info: object) => element._media("loadedmetadata", info);
  out.onPlay = (info: object) => element._media("play", info);
  out.onPause = (info: object) => element._media("pause", info);
  out.onTimeUpdate = (info: object) => element._media("timeupdate", info);
  out.onSeeking = (info: object) => element._media("seeking", info);
  out.onSeeked = (info: object) => element._media("seeked", info);
  out.onEnded = (info: object) => element._media("ended", info);
  out.onWaiting = (info: object) => element._media("waiting", info);
  out.onCanPlay = (info: object) => element._media("canplay", info);
  out.onProgress = (info: object) => element._media("progress", info);
  out.onAudioTracksChange = (info: object) => element._media("audiotracks", info);
  out.onTextTracksChange = (info: object) => element._media("texttracks", info);
  out.onCueChange = (info: object) => element._media("cuechange", info);
  out.onError = (message: string, error: { code: string }) => element._media("error", { message, code: error?.code });
}

function addEvents(element: TElement, tag: string, out: Record<string, any>): void {
  const wanted = interest(element);
  if (tag === "audio" || tag === "video") addMedia(element as THTMLMediaElement, out);
  // Layout readers (ResizeObserver, getBoundingClientRect) need size reports; the events module routes them.
  if (element._resizeObservers?.size || element._measured) out.onSize = () => {};
  if (element.hasAttribute("draggable") || wanted.has("drop") || wanted.has("dragover") || wanted.has("dragenter")) addDragAndDrop(element, wanted, out);
  if (wanted.has("scroll") || element._scrollTracked) {
    out.onScroll = (offset: number) => {
      element.scrollTop = offset;
      scheduleIntersections();
      if (wanted.has("scroll")) fire(element, "scroll", { bubbles: false });
    };
  }
  if (wanted.size === 0 && tag !== "input" && tag !== "textarea" && tag !== "select" && tag !== "form") return;
  // mousedown/mouseup/wheel come from native pointer events (events.ts); click is the native activation.
  if (wanted.has("click") || wanted.has("dblclick") || wanted.has("auxclick")) {
    let lastClick = -Infinity;
    out.onClick = () => {
      const now = performance.now();
      const detail = now - lastClick < 400 ? 2 : 1;
      lastClick = detail === 2 ? -Infinity : now;
      const init = { button: 0, buttons: 0, detail, ...pointer.position };
      fireAll(element, ["click"], wanted, init);
      if (detail === 2) fireAll(element, ["dblclick"], wanted, init);
    };
  }
  const moves = wanted.has("mousemove") || wanted.has("pointermove");
  const hovers = HOVER.some(type => wanted.has(type));
  if (moves || hovers) {
    // Native reports the pointer over every element under it that asks (`pointerMove` with the point
    // inside its box, `pointerLeave` when it goes), as the DOM sends enter/leave to each element
    // on the path. Its `hover` names only the topmost interactive node: a plain div under a
    // full-window button (a player's click-to-pause layer) would never see the pointer leave.
    if (moves) { element._measure(); out.onSize ??= () => {}; }
    out.onPointerMove = (point: { x: number; y: number }) => {
      if (!pointerInside.has(element)) {
        pointerInside.add(element);
        if (hovers) fireAll(element, ["pointerover", "pointerenter", "mouseover", "mouseenter"], wanted);
      }
      if (!moves) return;
      // The point is inside this element's box; clientX/clientY are the viewport's.
      const client = elementToClient(element, point.x, point.y);
      if (!client) return;
      setPointerPosition(client.x, client.y);
      fireAll(element, ["pointermove", "mousemove"], wanted, pointer.position);
    };
    out.onPointerLeave = () => {
      if (!pointerInside.delete(element)) return;
      if (hovers) fireAll(element, ["pointerout", "pointerleave", "mouseout", "mouseleave"], wanted);
    };
  }
  if (wanted.has("contextmenu")) out.onContextMenu = (point: { x: number; y: number }) => fire(element, "contextmenu", { clientX: point.x, clientY: point.y, pageX: point.x, pageY: point.y, button: 2 });
  if (tag === "form") out.onSubmit = () => fire(element, "submit");
  if (tag === "input" || tag === "textarea") {
    const type = element.type;
    if (type === "checkbox") {
      out.onCheckedChange = (checked: boolean) => { element.checked = checked; fireAll(element, ["click", "input", "change"], wanted); };
    } else if (type === "radio") {
      out.onChange = () => { element.checked = true; fireAll(element, ["click", "input", "change"], wanted); };
    } else {
      out.onChange = (value: string) => { element.value = String(value); fireAll(element, ["input", "change"], wanted); };
    }
  }
  if (tag === "select") {
    out.onValueChange = (value: string) => {
      element.selectedIndex = Number(value);
      fireAll(element, ["input", "change"], wanted);
    };
  }
}

/** An element and its whole subtree as plain VNodes (inline content, controls). */
function plain(node: TNode): Child {
  if (node.nodeType === TEXT_NODE) return (node as TCharacterData).data;
  if (node.nodeType !== ELEMENT_NODE) return null;
  return build(node as TElement);
}

/** Elements whose content is drawn by the element itself: never worth a memo entry. */
const LEAVES = new Set(["button", "input", "textarea", "select", "img", "hr", "br", "svg", "progress", "meter"]);

/**
 * A child element. An unchanged one with element children is memoized; a leaf
 * is built in place: a memo entry costs more than rebuilding it, and its changes
 * re-render this parent anyway. Both keep the element's own key, so moves keep native nodes.
 */
function elementChild(node: TElement): VNode {
  let structured = false;
  if (!TEXT_CONTAINERS.has(node.localName) && !LEAVES.has(node.localName)) {
    for (let child = node._first; child; child = child._next) if (child.nodeType === ELEMENT_NODE) { structured = true; break; }
  }
  // A changed element renders now either way; a memo entry for it would only copy
  // its whole subtree's ids. It is memoized once it renders unchanged.
  if (structured && !node._pending) return jsx(ElementView, { element: node, version: node._version }, node._key);
  const vnode = build(node);
  vnode.key = node._key;
  return vnode;
}

function children(element: TElement, tag: string, display?: unknown): Child {
  const out: Child[] = [];
  if (TEXT_CONTAINERS.has(tag)) {
    for (let child = element._first; child; child = child._next) out.push(plain(child));
    return out;
  }
  let elements = false, inlineOnly = true;
  for (let child = element._first; child; child = child._next) {
    if (child.nodeType !== ELEMENT_NODE) continue;
    elements = true;
    // A phrasing element holding a block (`<span><svg/></span>`) lays out as a block, not inside a text run.
    if (!isInlineContent(child as TElement)) { inlineOnly = false; break; }
  }
  // Text and phrasing elements side by side flow as one paragraph, as in a CSS block. In a
  // flex or grid container each one is an item of its own (CSS blockifies them).
  if (elements && inlineOnly && display !== "flex" && display !== "grid") {
    for (let child = element._first; child; child = child._next) out.push(plain(child));
    return jsx("span", { children: out });
  }
  const orders: number[] = [];
  for (let child = element._first; child; child = child._next) {
    if (child.nodeType === ELEMENT_NODE) {
      out.push(elementChild(child as TElement));
      orders.push(Number((child as TElement)._renderCache?.props.style?.order ?? 0) || 0);
    } else if (child.nodeType === TEXT_NODE && !isBlank(child)) { out.push((child as TCharacterData).data); orders.push(0); }
  }
  // CSS `order`: a flex or grid container lays its items out by it (stable for equal values).
  if ((display === "flex" || display === "grid") && orders.some(order => order !== 0)) {
    return out.map((item, index) => ({ item, order: orders[index]!, index })).sort((a, b) => a.order - b.order || a.index - b.index).map(entry => entry.item);
  }
  return out.length ? out : undefined;
}

/**
 * A phrasing element that flows inside a run of text: not one the CSS makes a box of its own
 * (`inline-block`, `inline-flex`, `block`, `flex`…) and holding only phrasing content.
 */
function isInlineContent(element: TElement): boolean {
  if (!INLINE.has(element.localName)) return false;
  const style = (element._renderCache?.props.style ?? elementStyle(element, (element.getAttribute("class") ?? "").split(/\s+/).filter(Boolean))) as Record<string, unknown> | undefined;
  if (style && (style.inline === "block" || style.display !== undefined && style.display !== "inline")) return false;
  return !hasNonPhrasingChild(element);
}

function hasNonPhrasingChild(element: TElement): boolean {
  for (let child = element._first; child; child = child._next) {
    if (child.nodeType === ELEMENT_NODE && !isInlineContent(child as TElement)) return true;
  }
  return false;
}

/**
 * Text with controls inside (`<label><input type="checkbox"> Mint</label>`): a
 * wrapping row of text runs and elements, as inline formatting lays it out. A
 * label passes its clicks to its control, as in HTML.
 */
function mixedFlow(element: TElement, tag: string, out: Record<string, any>, blockify = false): VNode {
  const items: Child[] = [];
  let run: Child[] = [];
  const flush = () => { if (run.length) items.push(jsx("span", { children: run })); run = []; };
  for (let child = element._first; child; child = child._next) {
    if (child.nodeType === TEXT_NODE) { if (!isBlank(child)) run.push((child as TCharacterData).data); continue; }
    if (child.nodeType !== ELEMENT_NODE) continue;
    const item = child as TElement;
    if (!blockify && isInlineContent(item)) { run.push(build(item)); continue; }
    flush();
    items.push(elementChild(item));
  }
  flush();
  // A line of mixed content wraps; a flex container's items stay on one line unless it says `wrap`.
  const flex = displayOf(out) === "flex";
  // Defaults the element's CSS and Tailwind classes have not set (a class loses to a style key).
  const classes = out.class ?? "";
  const style = {
    ...(/(^|\s)flex-(row|col)/.test(classes) ? {} : { direction: "row" }),
    ...(/(^|\s)flex-(wrap|nowrap)/.test(classes) ? {} : { wrap: !flex }),
    ...(out.style?.align !== undefined || /(^|\s)items-/.test(classes) ? {} : { alignItems: flex ? "stretch" : "center" }),
    ...(/(^|\s)(gap|space-x)-/.test(classes) ? {} : { gap: flex ? 0 : 4 }),
    ...out.style,
  };
  const props: Record<string, any> = { ...out, style, children: items };
  if (tag === "label") {
    const target = labelTarget(element);
    if (target) {
      const own = props.onClick as (() => void) | undefined;
      props.onClick = () => { own?.(); target.click(); };
    }
    delete props.htmlFor;
  }
  return jsx("div", props);
}

/** The control a `<label>` activates: its `for` target, else the first control inside it. */
function labelTarget(label: TElement): TElement | null {
  const id = label.getAttribute("for");
  if (id) return label.ownerDocument.getElementById(id);
  return label.querySelector("input, select, textarea, button");
}

/** `::before` / `::after` content around an element's children. */
function withGenerated(content: Child, generated: { before?: GeneratedContent; after?: GeneratedContent }, inline: boolean): Child {
  const box = (part: GeneratedContent) => {
    const { inline: _inline, ...style } = part.style;
    return part.text || inline ? jsx("span", { style, children: part.text }) : jsx("div", { style });
  };
  const items: Child[] = [];
  if (generated.before) items.push(box(generated.before));
  if (Array.isArray(content)) items.push(...content); else if (content != null) items.push(content);
  if (generated.after) items.push(box(generated.after));
  return items;
}

/**
 * `<titlebar>`: Tarve's custom title bar (the window drops its native frame). With
 * children they are its content; otherwise it shows `title`. Any element can be a
 * window control with `window-action="minimize|toggleMaximize|toggleFullscreen|close"` and a drag handle with `drag-region`.
 */
function titleBar(element: TElement, out: Record<string, any>): VNode {
  const flag = (name: string) => { const value = element.getAttribute(name); return value === null ? undefined : value !== "false"; };
  const height = element.getAttribute("height");
  const { showMinimize: _min, showMaximize: _max, showClose: _close, ...rest } = out;
  const glass = element.getAttribute("glass");
  return TitleBar({
    ...rest,
    // Without its own `title`, the bar shows the document's (`<svelte:head><title>`), like the window does.
    title: element.getAttribute("title") ?? (documentInstance.title || undefined),
    ...(height ? { height: Number(height) } : {}),
    showMinimize: flag("show-minimize"), showMaximize: flag("show-maximize"), showClose: flag("show-close"),
    ...(glass !== null ? { glass: glass === "" || glass === "true" ? true : glass as never } : {}),
    ...(element.getAttribute("appearance") ? { appearance: element.getAttribute("appearance") as "light" | "dark" } : {}),
    children: hasElementOrText(element) ? children(element, "div") : undefined,
  });
}

/**
 * `<surface>`: a box another renderer presents into (libmpv, a game engine). Its `surface`
 * events (`ready`, `resize`, `destroyed`) carry the native event as `detail`; children draw on top.
 */
function surface(element: TElement, out: Record<string, any>): VNode {
  return jsx("surface", {
    ...out,
    ...(element.hasAttribute("native") ? { native: element.getAttribute("native") !== "false" } : {}),
    onSurface: (event: object) => fire(element, "surface", { bubbles: false, detail: event }),
    children: children(element, "div"),
  });
}

function hasElementOrText(element: TElement): boolean {
  for (let child = element._first; child; child = child._next) if (child.nodeType === ELEMENT_NODE || (child.nodeType === TEXT_NODE && !isBlank(child))) return true;
  return false;
}

/** `contenteditable`: rich text in a native text area. Its markup styles the text; edits land in the DOM where they happened. */
function editable(element: TElement, out: Record<string, any>): VNode {
  settle(element);
  const model = editableModel(element);
  return jsx("textarea", {
    ...out, value: model.text, richText: model.children,
    onChange: (value: string) => {
      const edit = applyValue(element, value);
      if (edit) fireInput(element, edit.inputType, edit.data);
    },
  });
}

/** One element as a VNode, its child elements as memoized references. */
export function build(element: TElement): VNode {
  element._pending = false;
  const tag = element.localName;
  // Attributes, style and listeners change far less often than content: reuse their props.
  let cache = element._renderCache;
  if (!cache || cache.version !== element._attrVersion) {
    const base = props(element, tag);
    addEvents(element, tag, base);
    element._renderCache = cache = { version: element._attrVersion, props: base };
  }
  const out: Record<string, any> = { ...cache.props };
  boxDefaults(element, tag, out);
  if (element.isContentEditable) return editable(element, out);
  if (tag === "audio") {
    const media = element as THTMLMediaElement;
    settle(element);
    return jsx("audio", { ...out, volume: media.volume, muted: media.muted, playbackRate: media.playbackRate, autoPlay: element.hasAttribute("autoplay"), loop: element.hasAttribute("loop"), controls: element.hasAttribute("controls") });
  }
  if (tag === "video") {
    // The platform decoder draws the picture; CSS object-fit picks how it fills the box.
    const media = element as THTMLMediaElement;
    settle(element);
    return jsx("video", { ...out, volume: media.volume, muted: media.muted, playbackRate: media.playbackRate, autoPlay: element.hasAttribute("autoplay"), loop: element.hasAttribute("loop"), controls: element.hasAttribute("controls") });
  }
  if (tag === "input") {
    const type = element.type;
    if (type === "checkbox" || type === "radio") {
      out.checked = element.checked;
      out.value = element.value || "on";
      // aria-label names the control; only a <label> is drawn beside it.
      out.label ??= "";
    }
    else if (element._value !== undefined) out.value = element._value;
    return jsx("input", out);
  }
  if (tag === "textarea") {
    out.value = element.value;
    settle(element);
    return jsx("textarea", out);
  }
  if (tag === "select") {
    const options: VNode[] = [];
    // Native values are option indexes: Svelte binds any value (objects too) through `__value`.
    element.options.forEach((option, index) => {
      settle(option);
      options.push(jsx("option", { value: String(index), disabled: option._isDisabled, children: option.text }));
    });
    settle(element);
    const index = element.selectedIndex;
    out.value = index < 0 ? undefined : String(index);
    return jsx("select", { ...out, children: options });
  }
  if (tag === "button") {
    // A button made a flex or grid container lays out like any other one: items stretch across
    // and pack at the start (`align-items`/`justify-content: normal`), not centred as a plain button.
    const display = displayOf(out);
    if (display === "flex" || display === "grid") {
      const classes = out.class ?? "";
      out.style = { ...(/(^|\s)items-/.test(classes) ? {} : { alignItems: "stretch" }), ...(/(^|\s)justify-/.test(classes) ? {} : { justifyContent: "flex-start" }), ...out.style };
    }
    // A button the page paints keeps its paint when hovered or pressed unless its CSS says otherwise:
    // the theme's state colours belong to the unstyled button.
    const painted = out.style && (out.style.background !== undefined || out.style.backgroundColor !== undefined || out.style.backgroundImage !== undefined)
      || /(^|\s)bg-/.test(out.class ?? "");
    if (painted) out.style = { hover: {}, active: {}, disabled: {}, ...out.style };
    // Tailwind's preflight: a button takes its parent's font and colour (`font: inherit; color: inherit`)
    // and has no fill of its own. Utility classes still set their own.
    if (usesPreflight()) {
      const classes = out.class ?? "";
      const inherited: Record<string, unknown> = {};
      const take = (key: string, skip: RegExp) => { if (out.style?.[key] === undefined && !skip.test(classes)) { const value = inheritedValue(element, key); if (value !== undefined) inherited[key] = value; } };
      take("fontSize", /(^|\s)text-(xs|sm|base|lg|[0-9]*xl|\[\d)/);
      take("fontWeight", /(^|\s)font-(thin|extralight|light|normal|medium|semibold|bold|extrabold|black|\[)/);
      take("lineHeight", /(^|\s)leading-/);
      take("foreground", /(^|\s)text-(?!xs|sm|base|lg|[0-9]*xl|\[\d|left|right|center|justify)/);
      if (!painted) inherited.background = "transparent";
      out.style = { ...inherited, ...out.style };
    }
    // A button the CSS lays out or pads is as tall as its content, not the fixed height of an unstyled one.
    if ((display === "flex" || display === "grid" || out.style?.padding !== undefined || /(^|\s)p[xytrbl]?-/.test(out.class ?? "")) && out.style?.height === undefined && !/(^|\s)(h|size)-/.test(out.class ?? "")) out.style = { ...out.style, height: "auto" };
    // An icon beside the label (`<button><svg/> Play</button>`) keeps its elements; plain text stays one label.
    if (element.querySelector("*")) {
      out.children = children(element, tag);
      const generated = generatedContent(element);
      if (generated) out.children = withGenerated(out.children, generated, false);
      return jsx("button", out);
    }
    settle(element);
    out.children = textOf(element);
    return jsx("button", out);
  }
  if (tag === "svg" || element.namespaceURI.endsWith("svg")) {
    // An HTML <svg> starts from SVG's initial values (filled black, no stroke), not the stroked
    // line-icon defaults of Tarve's <Svg>: icon sets fill their paths with currentColor.
    if (tag === "svg") for (const [key, value] of Object.entries({ fill: "black", stroke: "none", strokeWidth: 1, strokeLinecap: "butt", strokeLinejoin: "miter" })) out[key] ??= value;
    // `currentColor` is the colour the svg inherits, as in CSS, not the theme's foreground.
    if (tag === "svg" && out.color === undefined && out.style?.color === undefined && out.style?.foreground === undefined
      && !/(^|\s)text-(?!\[?\d|xs|sm|base|lg|xl|[2-9]xl|left|right|center|justify|start|end|wrap|nowrap|clip|ellipsis)/.test(out.class ?? "")) out.color = "currentColor";
    // Icon sets size an icon to the text (`width="1.2em"`): an em is the font size it inherits.
    for (const side of ["width", "height"] as const) {
      const em = typeof out[side] === "string" ? /^(\d*\.?\d+)em$/.exec(out[side].trim()) : null;
      if (em) out[side] = Number(em[1]) * inheritedFontSize(element);
      // `width="24"` (and `24px`) is a length in user units: a number, as the native box wants.
      const px = typeof out[side] === "string" ? /^(\d*\.?\d+)(px)?$/.exec(out[side].trim()) : null;
      if (px) out[side] = Number(px[1]);
    }
    const shapes = element.childNodes.filter(node => node.nodeType === ELEMENT_NODE).map(node => {
      const shape = build(node as TElement);
      // A shape's own attributes draw it; box styles from CSS rules (`* { … }`) and classes do not apply.
      const { style: _style, class: _class, ...attributes } = shape.props as Record<string, unknown>;
      return { ...shape, props: attributes };
    });
    // Leaves (`<path/>`, `<circle/>`) take no children, not even an empty list.
    if (shapes.length) out.children = shapes;
    else delete out.children;
    return jsx(tag, out);
  }
  if (tag === "titlebar") return titleBar(element, out);
  if (tag === "surface") return surface(element, out);
  if (TEXT_CONTAINERS.has(tag) && hasNonPhrasingChild(element)) return mixedFlow(element, tag, out);
  // A flex or grid text element (`<h2 class="flex"><span class="accent"></span>Title</h2>`) lays
  // its children out as items, each element a box of its own and each text run an anonymous item.
  if (TEXT_CONTAINERS.has(tag) && (displayOf(out) === "flex" || displayOf(out) === "grid") && element.querySelector("*")) return mixedFlow(element, tag, out, true);
  // A block holding only text that clamps or ellipsizes it (`text-overflow`, `line-clamp`) is that text:
  // the text node takes the box style, so its lines are the ones the box cuts.
  if (!TEXT_CONTAINERS.has(tag) && (out.style?.textOverflow !== undefined || out.style?.lineClamp !== undefined) && !element.querySelector("*") && element.textContent?.trim()) {
    settle(element);
    return jsx("span", { ...out, style: { ...out.style, display: undefined }, children: textOf(element) });
  }
  out.children = children(element, tag, displayOf(out));
  const generated = generatedContent(element);
  if (generated) out.children = withGenerated(out.children, generated, TEXT_CONTAINERS.has(tag));
  backgroundImage(out);
  const native = NATIVE[tag];
  if (native) return native(out);
  if (FLEX_TEXT.has(tag) && (out.style?.display === "flex" || out.style?.display === "grid")) return flexText(out);
  return jsx(KNOWN.has(tag) ? tag : "div", out);
}

/**
 * The display an element renders with: its CSS, else its Tailwind classes (`flex`, `inline-grid`,
 * `hidden`…; the unprefixed ones, which hold at every width).
 */
function displayOf(props: { style?: Record<string, any>; class?: string }): string | undefined {
  if (props.style?.display !== undefined) return props.style.display;
  let display: string | undefined;
  for (const name of (props.class ?? "").split(/\s+/)) {
    if (name === "flex" || name === "inline-flex") display = "flex";
    else if (name === "grid" || name === "inline-grid") display = "grid";
    else if (name === "block" || name === "inline-block") display = "block";
    else if (name === "hidden") display = "none";
  }
  return display;
}

const PREFLIGHT_TEXT = new Set(["p", "h1", "h2", "h3", "h4", "h5", "h6"]);

const BLOCK_TAGS = new Set(["div", "section", "main", "header", "footer", "article", "aside", "nav", "form", "fieldset", "ul", "ol", "li", "figure", "blockquote", "dl", "dd"]);

function hasInlineLevelChild(element: TElement): boolean {
  for (let child = element._first; child; child = child._next) {
    if (child.nodeType !== ELEMENT_NODE) continue;
    const item = child as TElement;
    const style = (item._renderCache?.props.style ?? elementStyle(item, (item.getAttribute("class") ?? "").split(/\s+/).filter(Boolean))) as Record<string, unknown> | undefined;
    if (style?.inline !== undefined || /(^|\s)inline-(flex|block|grid)(\s|$)/.test(item.getAttribute("class") ?? "")) return true;
    if (INLINE.has(item.localName) && !style?.display) return true;
  }
  return false;
}

const CONTROL_TAGS = new Set(["button", "input", "select", "textarea", "img", "svg", "progress", "meter", "video", "audio", "canvas", "surface", "titlebar"]);

/**
 * CSS defaults Tarve's layout does not share: `box-sizing: content-box` (unless the page resets it,
 * as Tailwind's preflight does), and a block's children never shrink to fit it (only a flex
 * container's items do).
 */
function boxDefaults(element: TElement, tag: string, out: Record<string, any>): void {
  const style = out.style as Record<string, unknown> | undefined;
  if (!CONTROL_TAGS.has(tag) && style && style.boxSizing === undefined && !usesPreflight()
    && (style.padding !== undefined || style.borderWidth !== undefined)) out.style = { ...style, boxSizing: "content-box" };
  // A CSS block lays out as one (Taffy's block layout): vertical margins collapse, `margin: auto`
  // centres, children stack at full width. One holding inline-level boxes (`inline-block` badges)
  // stays a flex column, where those can shrink to their content.
  // (`space-y-*` and `gap` are spacing Tarve gives flex columns; a block would drop them.)
  if (BLOCK_TAGS.has(tag) && displayOf(out) === undefined && !hasInlineLevelChild(element)
    && out.style?.gap === undefined && out.style?.rowGap === undefined && !/(^|\s)(space-y-|gap-)/.test(out.class ?? "")) out.style = { ...out.style, display: "block" };
  const parent = element.parentElement;
  const parentProps = parent?._renderCache?.props;
  const parentDisplay = parentProps ? displayOf(parentProps) : undefined;
  if (parent && parentDisplay !== "flex" && parentDisplay !== "grid" && out.style?.shrink === undefined && out.style?.flex === undefined && out.style?.position !== "absolute"
    // Clamped by max-height, the item already is no taller than CSS makes it.
    && out.style?.maxHeight === undefined
    && !/(^|\s)(shrink|flex-)/.test(out.class ?? "")) out.style = { ...out.style, shrink: 0 };
}

/** Text elements that can be made flex containers of their own text (`<span class="badge">1</span>`). */
const FLEX_TEXT = new Set(["span", "p", "h1", "h2", "h3", "h4", "h5", "h6", "strong", "em", "b", "i", "small", "dt", "dd"]);
const TEXT_STYLE = new Set(["fontSize", "fontWeight", "fontStyle", "fontFamily", "color", "foreground", "letterSpacing", "wordSpacing", "lineHeight",
  "textTransform", "textAlign", "textDecoration", "textShadow", "whiteSpace", "textOverflow", "lineClamp", "fontVariantNumeric", "fontFeatureSettings"]);

/**
 * A text element with `display: flex` (or grid) is a box laying out its text as an item, which
 * `justify-content`/`align-items` place (a centred number in a round badge). The box keeps the
 * element's box style; the text inside takes its text style.
 */
function flexText(out: Record<string, any>): VNode {
  const box: Record<string, unknown> = {}, text: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(out.style as Record<string, unknown>)) (TEXT_STYLE.has(key) ? text : box)[key] = value;
  // The box's hover colours its text: the text follows the box as a hover group.
  const hover = box.hover as Record<string, unknown> | undefined;
  if (hover && Object.keys(hover).some(key => TEXT_STYLE.has(key))) {
    box.hover = Object.fromEntries(Object.entries(hover).filter(([key]) => !TEXT_STYLE.has(key)));
    text.groupHover = Object.fromEntries(Object.entries(hover).filter(([key]) => TEXT_STYLE.has(key)));
    box.group = true;
  }
  return jsx("div", { ...out, style: box, children: jsx("span", { style: text, children: out.children }) });
}

/**
 * CSS `background-image: url(…)` (with `background-size`): an image drawn under the
 * element's children, filling its box like `cover` (default), `contain` or `100% 100%`.
 * Gradients in `background-image` are the element's background.
 */
function backgroundImage(out: Record<string, any>): void {
  const style = out.style as Record<string, any> | undefined;
  if (!style || (style.backgroundImage === undefined && style.backgroundSize === undefined && style.backgroundPosition === undefined && style.backgroundRepeat === undefined)) return;
  const { backgroundImage: image, backgroundSize: size, backgroundPosition: _position, backgroundRepeat: _repeat, ...rest } = style;
  out.style = rest;
  if (typeof image !== "string" || image.trim() === "none") return;
  const layers = image.split(/,(?![^(]*\))/).map(layer => layer.trim());
  const url = layers.map(layer => /^url\(\s*(['"]?)(.*?)\1\s*\)$/.exec(layer)?.[2]).find(Boolean);
  const gradient = layers.find(layer => /gradient\(/.test(layer));
  if (gradient && rest.background === undefined) rest.background = gradient;
  if (!url) return;
  const fit = size === "contain" ? "contain" : /^100%(\s+100%)?$/.test(String(size ?? "")) ? "fill" : "cover";
  if (rest.position === undefined || rest.position === "static") rest.position = "relative";
  const layer = jsx("img", {
    src: url, fit, "aria-hidden": "true",
    style: { position: "absolute", top: 0, right: 0, bottom: 0, left: 0, width: "100%", height: "100%", pointerEvents: "none", ...(rest.radius !== undefined ? { radius: rest.radius } : {}) },
  });
  out.children = [layer, ...(Array.isArray(out.children) ? out.children : out.children == null ? [] : [out.children])];
}

const ElementView = memo(
  ({ element }: { element: TElement; version: number }) => build(element),
  (previous, next) => previous.element === next.element && previous.version === next.version,
);

/**
 * The page's canvas colour, as a browser paints it: `<html>`'s background, else `<body>`'s.
 * Undefined when the CSS sets neither (the window keeps its own).
 */
export function canvasBackground(): unknown {
  for (const element of [documentInstance.documentElement, documentInstance.body]) {
    const style = elementStyle(element, (element.getAttribute("class") ?? "").split(/\s+/).filter(Boolean)) as Record<string, unknown> | undefined;
    const background = style?.background ?? style?.backgroundColor;
    if (background !== undefined) return background;
  }
  return undefined;
}

/** Text properties a page inherits from `<html>` and `<body>`. */
const CANVAS_TEXT = ["fontFamily", "fontSize", "fontWeight", "fontStyle", "lineHeight", "letterSpacing", "color", "foreground", "textAlign", "textTransform"] as const;

/**
 * What `<html>` and `<body>` pass down to the page, as in a browser: their text properties
 * (`font-family`, `line-height`, `color`…; body's over html's). The mount target holds the
 * page, so the body itself never renders; its inherited values start the page's.
 */
export function canvasText(): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const element of [documentInstance.documentElement, documentInstance.body]) {
    const style = elementStyle(element, (element.getAttribute("class") ?? "").split(/\s+/).filter(Boolean)) as Record<string, unknown> | undefined;
    if (!style) continue;
    for (const key of CANVAS_TEXT) if (style[key] !== undefined) out[key === "color" ? "foreground" : key] = style[key];
  }
  return out;
}

/** The native id of the box standing for the viewport: the mount target's, so layout reads reach it. */
export function viewportId(target: TElement): string {
  const id = nativeIdOf(target);
  if (elementsById.get(id)?.deref() !== target) elementsById.set(id, new WeakRef(target));
  return id;
}

/** The children of the mount target, as the Window's content. */
export function rootChildren(target: TElement): Child {
  target._pending = false;
  const out: Child[] = [];
  for (let child = target._first; child; child = child._next) {
    if (child.nodeType === ELEMENT_NODE) out.push(elementChild(child as TElement));
    else if (child.nodeType === TEXT_NODE && !isBlank(child)) out.push((child as TCharacterData).data);
  }
  return out;
}

/**
 * An ancestor's style for inheritance lookups: its rendered props when built, else its CSS, computed
 * once per render. Each descendant asks its whole parent chain (font, colour, `inherit`), and before
 * an ancestor has finished building, recomputing its rules for every descendant made a first render
 * of a large page take over a second.
 */
const ancestorStyles = new WeakMap<TElement, { epoch: string; version: number; style: Record<string, unknown> | undefined }>();
/** One render's key: the DOM epoch it renders and the viewport (`vw`, `@media`) it styles for. */
const renderKey = () => `${layout.rendered}:${windowInstance.innerWidth}x${windowInstance.innerHeight}`;
function styleOf(element: TElement): Record<string, unknown> | undefined {
  const built = element._renderCache?.props.style as Record<string, unknown> | undefined;
  if (built) return built;
  const cached = ancestorStyles.get(element);
  const epoch = renderKey();
  if (cached && cached.epoch === epoch && cached.version === element._attrVersion) return cached.style;
  const style = elementStyle(element, (element.getAttribute("class") ?? "").split(/\s+/).filter(Boolean)) as Record<string, unknown> | undefined;
  ancestorStyles.set(element, { epoch, version: element._attrVersion, style });
  return style;
}

/** An inherited text property of `element`'s parent chain (CSS inheritance), else the page's own (`body`). */
function inheritedValue(element: TElement, key: string): unknown {
  for (let current = element.parentElement; current; current = current.parentElement) {
    const classes = current.getAttribute("class") ?? "";
    const own = styleOf(current);
    // Utility classes count too (`<div class="text-white">`); the element's CSS wins over them.
    let utilities: Record<string, unknown> | undefined;
    try { utilities = classes && usesPreflight() ? tw(classes) as Record<string, unknown> : undefined; } catch { utilities = undefined; }
    const style = { ...utilities, ...own };
    const value = key === "foreground" ? style.foreground ?? style.color : style[key];
    if (value !== undefined) return value;
  }
  // The page's own values, once per render (every element without an ancestor value asks).
  if (canvasCache?.epoch !== renderKey()) canvasCache = { epoch: renderKey(), text: canvasText() };
  return canvasCache.text[key];
}
let canvasCache: { epoch: string; text: Record<string, unknown> } | undefined;

/** CSS `inherit`: the parent's value of the same property (`border-radius: inherit`). */
function inheritValues(element: TElement, style: Record<string, unknown>): Record<string, unknown> {
  let out = style;
  for (const [key, value] of Object.entries(style)) {
    if (value !== "inherit") continue;
    if (out === style) out = { ...style };
    const parent = element.parentElement;
    const parentStyle = parent ? styleOf(parent) : undefined;
    const inherited = parentStyle?.[key];
    if (inherited === undefined || inherited === "inherit") delete out[key]; else out[key] = inherited;
  }
  return out;
}

/** The font size `element` inherits (CSS `em`): its own or its nearest ancestor's, else 16 px. */
function inheritedFontSize(element: TElement): number {
  for (let current: TElement | null = element; current; current = current.parentElement) {
    const style = current === element ? (current._renderCache?.props.style ?? elementStyle(current, (current.getAttribute("class") ?? "").split(/\s+/).filter(Boolean))) as Record<string, unknown> | undefined : styleOf(current);
    if (typeof style?.fontSize === "number") return style.fontSize;
  }
  return 16;
}

/**
 * An inline-level box (`inline-block`, `inline-flex`) in a block shrinks to its content and sits
 * where the line puts it (`text-align`); a flex or grid parent makes it an item like any other.
 */
function inlineLevel(element: TElement, style: Record<string, unknown>): Record<string, unknown> {
  const { inline, ...rest } = style;
  if (!inline || rest.alignSelf !== undefined || rest.position === "absolute") return rest;
  const parent = element.parentElement;
  // A line of text and phrasing elements already sizes each to its content.
  if (!parent || TEXT_CONTAINERS.has(parent.localName)) return rest;
  const parentProps = parent._renderCache?.props ?? { style: elementStyle(parent, (parent.getAttribute("class") ?? "").split(/\s+/).filter(Boolean)), class: parent.getAttribute("class") ?? "" };
  const parentStyle = parentProps.style as Record<string, unknown> | undefined;
  const parentDisplay = displayOf(parentProps);
  if (parentDisplay === "flex" || parentDisplay === "grid") return rest;
  const align = parentStyle?.textAlign;
  return { ...rest, alignSelf: align === "center" ? "center" : align === "right" || align === "end" ? "end" : "start" };
}
