import { Code, Column, Markdown, memo, Row, Scroll, Text, TitleBar, View } from "@tarve/core";
import { jsx, type Child, type VNode } from "@tarve/core/jsx-runtime";
import { elementStyle, isComponentClass } from "./css";
import { camelCase, COMMENT_NODE, documentInstance, ELEMENT_NODE, scheduleIntersections, TDataTransfer, TEvent, TEXT_NODE, type TCharacterData, type TElement, type THTMLMediaElement, type TNode } from "./dom";
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
  if (style) out.style = style;
  // Classes the component's own CSS selects are not Tailwind utilities (`.filter`, `.container`).
  const plain = classes.filter(name => !SCOPE_CLASS.test(name) && !isComponentClass(name));
  if (plain.length) out.class = plain.join(" ");
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
  if (wanted.has("mousemove") || wanted.has("pointermove")) {
    out.onPointerMove = (point: { x: number; y: number }) => {
      setPointerPosition(point.x, point.y);
      fireAll(element, ["pointermove", "mousemove"], wanted, pointer.position);
    };
  }
  if (HOVER.some(type => wanted.has(type))) {
    out.onHover = (entered: boolean) => fireAll(element, entered ? ["pointerover", "pointerenter", "mouseover", "mouseenter"] : ["pointerout", "pointerleave", "mouseout", "mouseleave"], wanted);
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

function children(element: TElement, tag: string): Child {
  const out: Child[] = [];
  if (TEXT_CONTAINERS.has(tag)) {
    for (let child = element._first; child; child = child._next) out.push(plain(child));
    return out;
  }
  let elements = false, inlineOnly = true;
  for (let child = element._first; child; child = child._next) {
    if (child.nodeType !== ELEMENT_NODE) continue;
    elements = true;
    if (!INLINE.has((child as TElement).localName)) { inlineOnly = false; break; }
  }
  // Text and phrasing elements side by side flow as one paragraph, as in a CSS block.
  if (elements && inlineOnly) {
    for (let child = element._first; child; child = child._next) out.push(plain(child));
    return jsx("span", { children: out });
  }
  for (let child = element._first; child; child = child._next) {
    if (child.nodeType === ELEMENT_NODE) out.push(elementChild(child as TElement));
    else if (child.nodeType === TEXT_NODE && !isBlank(child)) out.push((child as TCharacterData).data);
  }
  return out.length ? out : undefined;
}

function hasNonPhrasingChild(element: TElement): boolean {
  for (let child = element._first; child; child = child._next) {
    if (child.nodeType === ELEMENT_NODE && (!INLINE.has((child as TElement).localName) || hasNonPhrasingChild(child as TElement))) return true;
  }
  return false;
}

/**
 * Text with controls inside (`<label><input type="checkbox"> Mint</label>`): a
 * wrapping row of text runs and elements, as inline formatting lays it out. A
 * label passes its clicks to its control, as in HTML.
 */
function mixedFlow(element: TElement, tag: string, out: Record<string, any>): VNode {
  const items: Child[] = [];
  let run: Child[] = [];
  const flush = () => { if (run.length) items.push(jsx("span", { children: run })); run = []; };
  for (let child = element._first; child; child = child._next) {
    if (child.nodeType === TEXT_NODE) { if (!isBlank(child)) run.push((child as TCharacterData).data); continue; }
    if (child.nodeType !== ELEMENT_NODE) continue;
    const item = child as TElement;
    if (INLINE.has(item.localName) && !hasNonPhrasingChild(item)) { run.push(build(item)); continue; }
    flush();
    items.push(elementChild(item));
  }
  flush();
  const style = { direction: "row", wrap: true, align: "center", gap: 4, ...out.style };
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
  const box = (part: GeneratedContent) => part.text || inline ? jsx("span", { style: part.style, children: part.text }) : jsx("div", { style: part.style });
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
    settle(element);
    out.children = textOf(element);
    return jsx("button", out);
  }
  if (tag === "svg" || element.namespaceURI.endsWith("svg")) {
    out.children = element.childNodes.filter(node => node.nodeType === ELEMENT_NODE).map(node => build(node as TElement));
    return jsx(tag, out);
  }
  if (tag === "titlebar") return titleBar(element, out);
  if (TEXT_CONTAINERS.has(tag) && hasNonPhrasingChild(element)) return mixedFlow(element, tag, out);
  out.children = children(element, tag);
  const generated = generatedContent(element);
  if (generated) out.children = withGenerated(out.children, generated, TEXT_CONTAINERS.has(tag));
  const native = NATIVE[tag];
  if (native) return native(out);
  return jsx(KNOWN.has(tag) ? tag : "div", out);
}

const ElementView = memo(
  ({ element }: { element: TElement; version: number }) => build(element),
  (previous, next) => previous.element === next.element && previous.version === next.version,
);

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
