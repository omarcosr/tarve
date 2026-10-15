/**
 * A minimal DOM that Svelte 5's client runtime runs against. Every element is a
 * retained node; a change marks it and its ancestors dirty (`touch`) so the Tarve
 * view rebuilds only the dirty path and reuses every other compiled subtree.
 */

import { matchesList, parseSelectorList, selectorMatches } from "./selectors";

export const ELEMENT_NODE = 1;
export const TEXT_NODE = 3;
export const COMMENT_NODE = 8;
export const DOCUMENT_NODE = 9;
export const DOCUMENT_FRAGMENT_NODE = 11;

type Listener = { fn: EventListenerOrEventListenerObject; capture: boolean; once: boolean };
type EventListenerOrEventListenerObject = ((event: any) => void) | { handleEvent(event: any): void };

let scheduler: (() => void) | undefined;
/** Called once per dirty batch; the mount sets it to the app's update. */
export function setScheduler(next: (() => void) | undefined): void { scheduler = next; }

let nextKey = 0;

/** What component CSS reads beyond an element itself (set when rules register). */
export const styleDependencies = { descendants: false, siblings: false, ancestors: false };

/** `:has()` reads descendants and following siblings: a change restyles the ancestors and earlier siblings. */
function restyleAncestors(node: TNode | null): void {
  for (let current = node; current; current = current.parentNode) {
    if (current.nodeType !== ELEMENT_NODE) continue;
    restyle(current as TElement);
    for (let sibling = (current as TElement).previousElementSibling; sibling; sibling = sibling.previousElementSibling) restyle(sibling);
  }
}

/** Restyles `element`: its cached props are recomputed on the next render. */
export function restyle(element: TElement): void {
  element._attrVersion++;
  touch(element);
}

function restyleTree(node: TNode): void {
  for (let child = node._first; child; child = child._next) {
    if (child.nodeType !== ELEMENT_NODE) continue;
    restyle(child as TElement);
    restyleTree(child);
  }
}

/**
 * An element's attributes changed: rules with ancestor selectors may now match
 * its descendants differently, sibling selectors its following siblings.
 */
function restyleAround(element: TElement): void {
  if (styleDependencies.ancestors) restyleAncestors(element.parentNode);
  if (styleDependencies.descendants) restyleTree(element);
  if (styleDependencies.siblings) {
    for (let sibling = element.nextElementSibling; sibling; sibling = sibling.nextElementSibling) {
      restyle(sibling);
      if (styleDependencies.descendants) restyleTree(sibling);
    }
  }
}

/** Restyles every element under `root` (a media query or viewport unit changed). */
export function restyleAll(root: TNode): void {
  restyleTree(root);
}

type MutationRecordInit = { type: "childList" | "attributes" | "characterData"; target: TNode; addedNodes?: TNode[]; removedNodes?: TNode[]; attributeName?: string; oldValue?: string | null; previousSibling?: TNode | null; nextSibling?: TNode | null };
type Registration = { observer: TMutationObserver; options: { childList?: boolean; attributes?: boolean; characterData?: boolean; subtree?: boolean; attributeFilter?: string[]; attributeOldValue?: boolean; characterDataOldValue?: boolean } };
let observed = 0;
const pendingObservers = new Set<TMutationObserver>();

/** Queues a record for every observer of `target` (or of an ancestor, with `subtree`). */
function notify(record: MutationRecordInit): void {
  if (observed === 0) return;
  for (let node: TNode | null = record.target; node; node = node.parentNode) {
    const registrations = node._observers;
    if (!registrations) continue;
    for (const { observer, options } of registrations) {
      if (node !== record.target && !options.subtree) continue;
      if (record.type === "childList" && !options.childList) continue;
      if (record.type === "attributes" && !(options.attributes || options.attributeFilter) ) continue;
      if (record.type === "attributes" && options.attributeFilter && !options.attributeFilter.includes(record.attributeName!)) continue;
      if (record.type === "characterData" && !options.characterData) continue;
      observer._records.push({ addedNodes: [], removedNodes: [], attributeName: null, oldValue: null, previousSibling: null, nextSibling: null, attributeNamespace: null, ...record });
      if (!pendingObservers.size) queueMicrotask(deliverMutations);
      pendingObservers.add(observer);
    }
  }
}

function deliverMutations(): void {
  const observers = [...pendingObservers];
  pendingObservers.clear();
  for (const observer of observers) {
    const records = observer.takeRecords();
    if (records.length) {
      try { observer._callback(records, observer); } catch (error) { queueMicrotask(() => { throw error; }); }
    }
  }
}

export class TMutationObserver {
  _records: Record<string, unknown>[] = [];
  _targets = new Set<TNode>();
  constructor(readonly _callback: (records: Record<string, unknown>[], observer: TMutationObserver) => void) {}
  observe(target: TNode, options: Registration["options"] = {}): void {
    const registrations = target._observers ??= [];
    const existing = registrations.find(registration => registration.observer === this);
    if (existing) existing.options = options;
    else { registrations.push({ observer: this, options }); observed++; this._targets.add(target); }
  }
  disconnect(): void {
    for (const target of this._targets) {
      const registrations = target._observers!;
      const index = registrations.findIndex(registration => registration.observer === this);
      if (index >= 0) { registrations.splice(index, 1); observed--; }
    }
    this._targets.clear();
    this._records = [];
  }
  takeRecords(): Record<string, unknown>[] {
    const records = this._records;
    this._records = [];
    return records;
  }
}

/** Marks `node` and its ancestors as changed: their next render rebuilds instead of reusing. */
export function touch(node: TNode | null): void {
  let marked = false;
  for (let current = node; current; current = current.parentNode) {
    if (current.nodeType !== ELEMENT_NODE && current.nodeType !== DOCUMENT_FRAGMENT_NODE) continue;
    if (current._pending) break;
    current._pending = true;
    current._version++;
    marked = true;
  }
  if (marked) { layout.epoch++; scheduler?.(); }
}

/**
 * Layout freshness. `epoch` counts changes that can move boxes; `rendered` is the
 * epoch the last render sent to native. A box read at an older epoch is stale:
 * reading it lays the window out synchronously, as a browser forces layout.
 */
export const layout = { epoch: 0, rendered: 0, rendering: false };
let layoutReader: ((elements: TElement[]) => boolean) | undefined;
const measuredElements = new Set<TElement>();
/** The mount sets how a layout read reaches native (`app.layout`); without it reads stay asynchronous. */
export function setLayoutReader(next: ((elements: TElement[]) => boolean) | undefined): void { layoutReader = next; }
/** The view renders the DOM as it is at this epoch. */
export function beginRender(): void { layout.rendering = true; layout.rendered = layout.epoch; }
export function endRender(): void { layout.rendering = false; }

function readLayout(element: TElement, withParent: boolean): void {
  if (!layoutReader || layout.rendering || !element.isConnected) return;
  const stale = (item: TElement) => item._boxEpoch !== layout.epoch;
  const parent = withParent ? element.parentElement : null;
  if (!stale(element) && !(parent && stale(parent))) return;
  // One round trip answers every element something reads: a loop of reads costs one layout.
  const wanted = new Set<TElement>([element]);
  if (parent) wanted.add(parent);
  for (const item of measuredElements) {
    if (!item.isConnected) measuredElements.delete(item);
    else if (wanted.size < 512 && stale(item)) wanted.add(item);
  }
  const elements = [...wanted];
  const answered = layoutReader(elements);
  for (const item of elements) item._boxEpoch = answered ? layout.rendered : layout.epoch;
}

export class TEvent {
  readonly type: string;
  readonly bubbles: boolean;
  readonly cancelable: boolean;
  readonly composed: boolean;
  readonly timeStamp = performance.now();
  target: TEventTarget | null = null;
  currentTarget: TEventTarget | null = null;
  eventPhase = 0;
  defaultPrevented = false;
  cancelBubble = false;
  isTrusted = true;
  _stopImmediate = false;
  _path: TEventTarget[] = [];
  constructor(type: string, init: { bubbles?: boolean; cancelable?: boolean; composed?: boolean } & Record<string, unknown> = {}) {
    this.type = type;
    this.bubbles = init.bubbles ?? false;
    this.cancelable = init.cancelable ?? false;
    this.composed = init.composed ?? false;
    for (const key of Object.keys(init)) if (!(key in this)) (this as Record<string, unknown>)[key] = init[key];
  }
  composedPath(): TEventTarget[] { return this._path; }
  stopPropagation(): void { this.cancelBubble = true; }
  stopImmediatePropagation(): void { this.cancelBubble = true; this._stopImmediate = true; }
  preventDefault(): void { if (this.cancelable) this.defaultPrevented = true; }
}

export class TEventTarget {
  _listeners?: Map<string, Listener[]>;
  addEventListener(type: string, fn: EventListenerOrEventListenerObject | null, options?: boolean | { capture?: boolean; once?: boolean }): void {
    if (!fn) return;
    const capture = typeof options === "boolean" ? options : options?.capture ?? false;
    const once = typeof options === "object" && options?.once === true;
    const map = this._listeners ??= new Map();
    const existing = map.get(type);
    const list: Listener[] = existing ?? [];
    if (!existing) map.set(type, list);
    const fresh = !existing;
    if (list.some(listener => listener.fn === fn && listener.capture === capture)) return;
    list.push({ fn, capture, once });
    if (fresh) this._interestChanged();
  }
  removeEventListener(type: string, fn: EventListenerOrEventListenerObject | null, options?: boolean | { capture?: boolean }): void {
    const list = this._listeners?.get(type);
    if (!list || !fn) return;
    const capture = typeof options === "boolean" ? options : options?.capture ?? false;
    const index = list.findIndex(listener => listener.fn === fn && listener.capture === capture);
    if (index >= 0) list.splice(index, 1);
    if (list.length === 0) { this._listeners!.delete(type); this._interestChanged(); }
  }
  _interestChanged(): void {}
  _parentTarget(): TEventTarget | null { return null; }
  dispatchEvent(event: any): boolean {
    const path: TEventTarget[] = [];
    for (let current: TEventTarget | null = this; current; current = current._parentTarget()) path.push(current);
    const define = (key: string, value: unknown) => Object.defineProperty(event, key, { value, configurable: true, writable: true });
    define("target", this);
    define("_path", path);
    if (!(event instanceof TEvent)) {
      define("composedPath", () => path);
      define("cancelBubble", false);
      const stop = () => { event.cancelBubble = true; };
      define("stopPropagation", stop);
      define("stopImmediatePropagation", () => { stop(); event._stopImmediate = true; });
    }
    const invoke = (target: TEventTarget, capturePhase: boolean | undefined) => {
      const list = target._listeners?.get(event.type);
      if (!list) return;
      define("currentTarget", target);
      for (const listener of [...list]) {
        if (capturePhase !== undefined && listener.capture !== capturePhase) continue;
        if (listener.once) target.removeEventListener(event.type, listener.fn, listener.capture);
        try {
          if (typeof listener.fn === "function") listener.fn.call(target, event);
          else listener.fn.handleEvent(event);
        } catch (error) {
          queueMicrotask(() => { throw error; });
        }
        if (event._stopImmediate) return;
      }
    };
    for (let index = path.length - 1; index > 0 && !event.cancelBubble; index--) invoke(path[index]!, true);
    if (!event.cancelBubble) invoke(this, undefined);
    if (event.bubbles) for (let index = 1; index < path.length && !event.cancelBubble; index++) invoke(path[index]!, false);
    define("currentTarget", null);
    return !event.defaultPrevented;
  }
}

// `instanceof EventTarget` holds (Svelte checks it) without constructing a native EventTarget per node.
if (globalThis.EventTarget) Object.setPrototypeOf(TEventTarget.prototype, globalThis.EventTarget.prototype);

export class TNode extends TEventTarget {
  static readonly ELEMENT_NODE = ELEMENT_NODE;
  static readonly TEXT_NODE = TEXT_NODE;
  static readonly COMMENT_NODE = COMMENT_NODE;
  static readonly DOCUMENT_NODE = DOCUMENT_NODE;
  static readonly DOCUMENT_FRAGMENT_NODE = DOCUMENT_FRAGMENT_NODE;
  nodeType = 0;
  nodeName = "";
  parentNode: TNode | null = null;
  _first: TNode | null = null;
  _last: TNode | null = null;
  _next: TNode | null = null;
  _prev: TNode | null = null;
  /** Bumped by `touch`; the memoized view of an element is reused while it is unchanged. */
  _version = 0;
  _pending = true;
  _observers?: Registration[];
  _keyValue?: string;
  /** Stable list key: the compiled node keeps its id when siblings move. Assigned on first render. */
  get _key(): string { return this._keyValue ??= (nextKey++).toString(36); }

  get firstChild(): TNode | null { return this._first; }
  get lastChild(): TNode | null { return this._last; }
  get nextSibling(): TNode | null { return this._next; }
  get previousSibling(): TNode | null { return this._prev; }
  get parentElement(): TElement | null { return this.parentNode?.nodeType === ELEMENT_NODE ? this.parentNode as TElement : null; }
  get previousElementSibling(): TElement | null {
    let node = this._prev;
    while (node && node.nodeType !== ELEMENT_NODE) node = node._prev;
    return node as TElement | null;
  }
  get nextElementSibling(): TElement | null {
    let node = this._next;
    while (node && node.nodeType !== ELEMENT_NODE) node = node._next;
    return node as TElement | null;
  }
  get childNodes(): TNode[] {
    const out: TNode[] = [];
    for (let child = this._first; child; child = child._next) out.push(child);
    return out;
  }
  get ownerDocument(): TDocument { return documentInstance; }
  get isConnected(): boolean {
    let current: TNode | null = this;
    while (current.parentNode) current = current.parentNode;
    return current.nodeType === DOCUMENT_NODE;
  }
  get textContent(): string | null {
    let out = "";
    for (let child = this._first; child; child = child._next) if (child.nodeType !== COMMENT_NODE) out += child.textContent ?? "";
    return out;
  }
  set textContent(value: string | null) {
    while (this._first) this._unlink(this._first);
    if (value) this._link(documentInstance.createTextNode(String(value)), null);
    touch(this);
  }
  get nodeValue(): string | null { return null; }
  set nodeValue(_value: string | null) {}

  override _parentTarget(): TEventTarget | null {
    if (this.parentNode) return this.parentNode;
    return this.nodeType === DOCUMENT_NODE ? windowInstance : null;
  }

  hasChildNodes(): boolean { return this._first !== null; }
  /** Node.compareDocumentPosition: 2 preceding, 4 following, 8 contains, 16 contained by, 1 disconnected. */
  compareDocumentPosition(other: TNode): number {
    if (other === this) return 0;
    const chain = (node: TNode) => { const out: TNode[] = []; for (let current: TNode | null = node; current; current = current.parentNode) out.unshift(current); return out; };
    const mine = chain(this), theirs = chain(other);
    if (mine[0] !== theirs[0]) return 1 | 32;
    let depth = 0;
    while (depth < mine.length && depth < theirs.length && mine[depth] === theirs[depth]) depth++;
    if (depth === mine.length) return 4 | 16;
    if (depth === theirs.length) return 2 | 8;
    for (let sibling = mine[depth]!._next; sibling; sibling = sibling._next) if (sibling === theirs[depth]) return 4;
    return 2;
  }
  isSameNode(other: TNode | null): boolean { return other === this; }
  contains(other: TNode | null): boolean {
    for (let current = other; current; current = current.parentNode) if (current === this) return true;
    return false;
  }
  getRootNode(): TNode {
    let current: TNode = this;
    while (current.parentNode) current = current.parentNode;
    return current;
  }

  /** :nth-child(), :first-child, `+` and `~` read sibling positions: restyle every child. */
  _restyleChildren(): void {
    for (let child = this._first; child; child = child._next) {
      if (child.nodeType !== ELEMENT_NODE) continue;
      restyle(child as TElement);
      if (styleDependencies.descendants) restyleTree(child);
    }
  }
  _unlink(child: TNode): void {
    if (child._prev) child._prev._next = child._next; else this._first = child._next;
    if (child._next) child._next._prev = child._prev; else this._last = child._prev;
    child.parentNode = child._next = child._prev = null;
  }
  _link(child: TNode, before: TNode | null): void {
    child.parentNode = this;
    child._next = before;
    child._prev = before ? before._prev : this._last;
    if (child._prev) child._prev._next = child; else this._first = child;
    if (before) before._prev = child; else this._last = child;
  }

  insertBefore<T extends TNode>(node: T, before: TNode | null): T {
    if (before && before.parentNode !== this) throw new Error("NotFoundError: reference node is not a child");
    if (node.nodeType === DOCUMENT_FRAGMENT_NODE) {
      while (node._first) this.insertBefore(node._first, before);
      touch(node);
      return node;
    }
    if (node === before) return node;
    const previous = node.parentNode;
    if (previous) {
      const [previousSibling, nextSibling] = [node._prev, node._next];
      previous._unlink(node);
      touch(previous);
      if (observed) notify({ type: "childList", target: previous, removedNodes: [node], previousSibling, nextSibling });
    }
    this._link(node, before);
    touch(this);
    if (observed) notify({ type: "childList", target: this, addedNodes: [node], previousSibling: node._prev, nextSibling: before });
    if (styleDependencies.ancestors) restyleAncestors(this);
    if (node.nodeType === ELEMENT_NODE && (styleDependencies.descendants || styleDependencies.siblings)) {
      // Its ancestors (or siblings) changed: what component CSS matched may differ.
      restyle(node as unknown as TElement);
      if (styleDependencies.descendants) restyleTree(node);
      if (styleDependencies.siblings) this._restyleChildren();
    }
    return node;
  }
  appendChild<T extends TNode>(node: T): T { return this.insertBefore(node, null); }
  removeChild<T extends TNode>(node: T): T {
    if (node.parentNode !== this) throw new Error("NotFoundError: node is not a child");
    const [previousSibling, nextSibling] = [node._prev, node._next];
    this._unlink(node);
    touch(this);
    if (observed) notify({ type: "childList", target: this, removedNodes: [node], previousSibling, nextSibling });
    if (styleDependencies.siblings && node.nodeType === ELEMENT_NODE) this._restyleChildren();
    if (styleDependencies.ancestors) restyleAncestors(this);
    return node;
  }
  replaceChild<T extends TNode>(node: TNode, old: T): T {
    this.insertBefore(node, old);
    return this.removeChild(old);
  }
  remove(): void { this.parentNode?.removeChild(this); }
  before(...nodes: (TNode | string)[]): void {
    const parent = this.parentNode;
    if (!parent) return;
    for (const node of nodes) parent.insertBefore(asNode(node), this);
  }
  after(...nodes: (TNode | string)[]): void {
    const parent = this.parentNode;
    if (!parent) return;
    const next = this._next;
    for (const node of nodes) parent.insertBefore(asNode(node), next);
  }
  append(...nodes: (TNode | string)[]): void { for (const node of nodes) this.appendChild(asNode(node)); }
  prepend(...nodes: (TNode | string)[]): void {
    const first = this._first;
    for (const node of nodes) this.insertBefore(asNode(node), first);
  }
  replaceWith(...nodes: (TNode | string)[]): void {
    const parent = this.parentNode;
    if (!parent) return;
    const next = this._next;
    parent.removeChild(this);
    for (const node of nodes) parent.insertBefore(asNode(node), next);
  }
  replaceChildren(...nodes: (TNode | string)[]): void {
    while (this._first) this._unlink(this._first);
    touch(this);
    this.append(...nodes);
  }
  cloneNode(deep = false): TNode {
    const copy = this._cloneSelf();
    if (deep) for (let child = this._first; child; child = child._next) copy._link(child.cloneNode(true), null);
    return copy;
  }
  _cloneSelf(): TNode { throw new Error("cloneNode is not supported on this node"); }
}

function asNode(node: TNode | string): TNode {
  return typeof node === "string" ? documentInstance.createTextNode(node) : node;
}

export class TCharacterData extends TNode {
  _data: string;
  constructor(data: string) { super(); this._data = data; this._pending = false; }
  get data(): string { return this._data; }
  set data(value: string) {
    const next = String(value);
    if (next === this._data) return;
    const oldValue = this._data;
    this._data = next;
    touch(this.parentNode);
    if (observed) notify({ type: "characterData", target: this, oldValue });
  }
  override get nodeValue(): string { return this._data; }
  override set nodeValue(value: string | null) { this.data = value ?? ""; }
  override get textContent(): string { return this._data; }
  override set textContent(value: string | null) { this.data = value ?? ""; }
  get length(): number { return this._data.length; }
}

export class TText extends TCharacterData {
  override nodeType = TEXT_NODE;
  override nodeName = "#text";
  get wholeText(): string { return this._data; }
  override _cloneSelf(): TNode { return new TText(this._data); }
}

export class TComment extends TCharacterData {
  override nodeType = COMMENT_NODE;
  override nodeName = "#comment";
  override _cloneSelf(): TNode { return new TComment(this._data); }
}

export class TDocumentFragment extends TNode {
  override nodeType = DOCUMENT_FRAGMENT_NODE;
  override nodeName = "#document-fragment";
  override _cloneSelf(): TNode { return new TDocumentFragment(); }
  querySelector(selector: string): TElement | null { return query(this, selector, true)[0] ?? null; }
  querySelectorAll(selector: string): TElement[] { return query(this, selector, false); }
}

/** Descendants of `root` matching `selector`, in document order. */
function query(root: TNode, selector: string, first: boolean): TElement[] {
  const selectors = parseSelectorList(selector);
  const out: TElement[] = [];
  const visit = (node: TNode): boolean => {
    for (let child = node._first; child; child = child._next) {
      if (child.nodeType !== ELEMENT_NODE) continue;
      if (selectors.some(item => selectorMatches(child as TElement, item))) {
        out.push(child as TElement);
        if (first) return true;
      }
      if (visit(child)) return true;
    }
    return false;
  };
  visit(root);
  return out;
}

const kebab = (name: string) => name.replace(/[A-Z]/g, letter => "-" + letter.toLowerCase());
const camel = (name: string) => name.replace(/-([a-z])/g, (_, letter: string) => letter.toUpperCase());

/** `element.style`: CSS declarations by property name. */
export class TStyle {
  _values = new Map<string, string>();
  constructor(private readonly owner: TElement) {
    return new Proxy(this, {
      get(target, key, receiver) {
        if (typeof key === "string" && !(key in target)) return target.getPropertyValue(kebab(key));
        return Reflect.get(target, key, receiver);
      },
      set(target, key, value, receiver) {
        if (typeof key === "string" && !(key in target)) { target.setProperty(kebab(key), value == null ? "" : String(value)); return true; }
        return Reflect.set(target, key, value, receiver);
      },
    });
  }
  get cssText(): string {
    let out = "";
    for (const [name, value] of this._values) out += `${out ? " " : ""}${name}: ${value};`;
    return out;
  }
  set cssText(text: string) {
    this._values = parseDeclarations(text ?? "");
    this.owner._styleChanged();
  }
  get length(): number { return this._values.size; }
  getPropertyValue(name: string): string { return this._values.get(name) ?? ""; }
  setProperty(name: string, value: string | null, _priority?: string): void {
    if (value === null || value === "") { this.removeProperty(name); return; }
    if (this._values.get(name) === value) return;
    this._values.set(name, String(value));
    this.owner._styleChanged();
  }
  removeProperty(name: string): string {
    const old = this._values.get(name) ?? "";
    if (this._values.delete(name)) this.owner._styleChanged();
    return old;
  }
}

export function parseDeclarations(text: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const part of text.split(";")) {
    const colon = part.indexOf(":");
    if (colon < 0) continue;
    const name = part.slice(0, colon).trim().toLowerCase();
    const value = part.slice(colon + 1).replace(/!important/i, "").trim();
    if (name && value) out.set(name, value);
  }
  return out;
}

class TClassList {
  constructor(private readonly owner: TElement) {}
  private get list(): string[] { return (this.owner.getAttribute("class") ?? "").split(/\s+/).filter(Boolean); }
  private write(list: string[]): void { this.owner.setAttribute("class", list.join(" ")); }
  get length(): number { return this.list.length; }
  get value(): string { return this.owner.getAttribute("class") ?? ""; }
  contains(name: string): boolean { return this.list.includes(name); }
  add(...names: string[]): void {
    const list = this.list;
    const missing = names.filter(name => !list.includes(name));
    if (missing.length) this.write([...list, ...missing]);
  }
  remove(...names: string[]): void {
    const list = this.list;
    if (names.some(name => list.includes(name))) this.write(list.filter(name => !names.includes(name)));
  }
  toggle(name: string, force?: boolean): boolean {
    const has = this.contains(name);
    const next = force ?? !has;
    if (next && !has) this.add(name);
    if (!next && has) this.remove(name);
    return next;
  }
}

const HTML_NAMESPACE = "http://www.w3.org/1999/xhtml";

type Keyframe = { offset: number; values: Record<string, string> };

/** Keyframes with offsets (missing ones spread evenly, as Web Animations does). */
function keyframesOf(input: Record<string, string | number | null | undefined>[]): Keyframe[] {
  const frames = input.map(frame => {
    const values: Record<string, string> = {};
    for (const [key, value] of Object.entries(frame)) if (key !== "offset" && key !== "easing" && key !== "composite" && value != null) values[key] = String(value);
    return { offset: typeof frame.offset === "number" ? frame.offset : NaN, values };
  });
  if (frames.length === 1) frames.unshift({ offset: 0, values: { ...frames[0]!.values } });
  frames.forEach((frame, index) => { if (Number.isNaN(frame.offset)) frame.offset = frames.length > 1 ? index / (frames.length - 1) : 0; });
  return frames.sort((a, b) => a.offset - b.offset);
}

const COLOR = /#([0-9a-f]{3,8})\b|rgba?\(([^)]*)\)/gi;
/** Colours as `rgba(r, g, b, a)`, so they interpolate as numbers. */
function normalizeColors(value: string): string {
  return value.replace(COLOR, (_match, hex: string | undefined, rgb: string | undefined) => {
    if (rgb !== undefined) {
      const parts = rgb.split(/[\s,/]+/).filter(Boolean).map(Number);
      return `rgba(${parts[0] ?? 0}, ${parts[1] ?? 0}, ${parts[2] ?? 0}, ${parts[3] ?? 1})`;
    }
    let digits = hex!;
    if (digits.length <= 4) digits = [...digits].map(char => char + char).join("");
    const value = (index: number) => parseInt(digits.slice(index, index + 2), 16);
    return `rgba(${value(0)}, ${value(2)}, ${value(4)}, ${digits.length === 8 ? value(6) / 255 : 1})`;
  });
}

const NUMBER = /-?\d*\.?\d+(?:e-?\d+)?/gi;
/** Interpolates two CSS values number by number when they share a shape; else switches halfway. */
function mix(from: string, to: string, t: number): string {
  const a = normalizeColors(from), b = normalizeColors(to);
  const shapeA = a.replace(NUMBER, "#"), shapeB = b.replace(NUMBER, "#");
  if (shapeA !== shapeB) return t < 0.5 ? from : to;
  const numbersB = b.match(NUMBER) ?? [];
  let index = 0;
  return a.replace(NUMBER, number => {
    const start = Number(number), end = Number(numbersB[index++]);
    const value = start + (end - start) * t;
    return String(Math.round(value * 1000) / 1000);
  });
}

function interpolateFrames(frames: Keyframe[], progress: number): Record<string, string> | undefined {
  if (!frames.length) return undefined;
  if (progress <= frames[0]!.offset) return frames[0]!.values;
  for (let index = 1; index < frames.length; index++) {
    const previous = frames[index - 1]!, next = frames[index]!;
    if (progress > next.offset) continue;
    const span = next.offset - previous.offset;
    const t = span ? (progress - previous.offset) / span : 1;
    const out: Record<string, string> = {};
    for (const key of new Set([...Object.keys(previous.values), ...Object.keys(next.values)])) {
      const from = previous.values[key], to = next.values[key];
      out[key] = from === undefined ? to! : to === undefined ? from : mix(from, to, t);
    }
    return out;
  }
  return frames[frames.length - 1]!.values;
}

/** A CSS timing function as a function of progress. */
function easing(name: string): (t: number) => number {
  const bezier = (x1: number, y1: number, x2: number, y2: number) => (t: number) => {
    // Solve x(u) = t by Newton's method, then return y(u).
    let u = t;
    for (let index = 0; index < 8; index++) {
      const x = 3 * x1 * u * (1 - u) ** 2 + 3 * x2 * u ** 2 * (1 - u) + u ** 3 - t;
      const slope = 3 * x1 * (1 - u) ** 2 + 6 * (x2 - x1) * u * (1 - u) + 3 * (1 - x2) * u ** 2;
      if (Math.abs(x) < 1e-5 || !slope) break;
      u = Math.min(1, Math.max(0, u - x / slope));
    }
    return 3 * y1 * u * (1 - u) ** 2 + 3 * y2 * u ** 2 * (1 - u) + u ** 3;
  };
  const value = name.trim();
  if (value === "ease") return bezier(0.25, 0.1, 0.25, 1);
  if (value === "ease-in") return bezier(0.42, 0, 1, 1);
  if (value === "ease-out") return bezier(0, 0, 0.58, 1);
  if (value === "ease-in-out") return bezier(0.42, 0, 0.58, 1);
  const cubic = /^cubic-bezier\(([^)]*)\)$/.exec(value);
  if (cubic) { const [a = 0, b = 0, c = 1, e = 1] = cubic[1]!.split(",").map(Number); return bezier(a, b, c, e); }
  const steps = /^steps\(\s*(\d+)\s*(?:,\s*(start|end|jump-start|jump-end))?\s*\)$/.exec(value);
  if (steps) { const count = Number(steps[1]); const start = steps[2]?.includes("start"); return t => Math.min(1, (start ? Math.ceil(t * count) : Math.floor(t * count)) / count); }
  if (value === "step-start") return t => (t > 0 ? 1 : 0);
  if (value === "step-end") return t => (t >= 1 ? 1 : 0);
  return t => t;
}
const TAG_NAMES = new Map<string, [string, string]>();

const BOOLEAN_PROPS = ["disabled", "checked", "selected", "required", "readOnly", "multiple", "hidden", "open", "autofocus"] as const;

export class TElement extends TNode {
  override nodeType = ELEMENT_NODE;
  readonly localName: string;
  readonly namespaceURI: string;
  _attributes = new Map<string, string>();
  _style?: TStyle;
  _classList?: TClassList;
  /** The live value of a form control, apart from its `value` attribute (as in the DOM). */
  _value?: string;
  _checked?: boolean;
  /** Bumped when attributes, style or listened events change: the view reuses its props until then. */
  _attrVersion = 0;
  _renderCache?: { version: number; props: Record<string, any> };
  _cssVariables?: { version: number; map: Map<string, string> | undefined };
  /** The CSS `animation` running on this element, keyed by its parsed shorthand. */
  _cssAnimation?: { key: string; animation: unknown };
  scrollTop = 0;
  scrollLeft = 0;
  constructor(tag: string, namespace = HTML_NAMESPACE) {
    super();
    this.namespaceURI = namespace;
    if (namespace === HTML_NAMESPACE) {
      let names = TAG_NAMES.get(tag);
      if (!names) TAG_NAMES.set(tag, names = [tag.toLowerCase(), tag.toUpperCase()]);
      this.localName = names[0];
      this.nodeName = names[1];
    } else {
      this.localName = this.nodeName = tag;
    }
  }
  get tagName(): string { return this.nodeName; }
  override _cloneSelf(): TNode {
    const copy = createElementFor(this.localName, this.namespaceURI);
    for (const [name, value] of this._attributes) copy._attributes.set(name, value);
    if (this._style) copy.style.cssText = this._style.cssText;
    return copy;
  }
  override _interestChanged(): void { this._attrVersion++; touch(this); }
  _styleChanged(): void { this._attrVersion++; touch(this); }

  get attributes(): { name: string; value: string }[] {
    return [...this._attributes].map(([name, value]) => ({ name, value }));
  }
  getAttributeNames(): string[] { return [...this._attributes.keys()]; }
  getAttribute(name: string): string | null {
    if (name === "style" && this._style) return this._style.cssText || null;
    return this._attributes.get(name) ?? null;
  }
  hasAttribute(name: string): boolean { return this._attributes.has(name) || (name === "style" && !!this._style?.length); }
  setAttribute(name: string, value: unknown): void {
    const text = String(value);
    if (name === "style") { this.style.cssText = text; return; }
    const oldValue = this._attributes.get(name);
    if (oldValue === text) return;
    this._attributes.set(name, text);
    this._attrVersion++;
    touch(this);
    if (styleDependencies.descendants || styleDependencies.siblings || styleDependencies.ancestors) restyleAround(this);
    if (observed) notify({ type: "attributes", target: this, attributeName: name, oldValue: oldValue ?? null });
  }
  setAttributeNS(_namespace: string | null, name: string, value: unknown): void { this.setAttribute(name, value); }
  removeAttribute(name: string): void {
    if (name === "style") { if (this._style?.length) this.style.cssText = ""; return; }
    const oldValue = this._attributes.get(name);
    if (this._attributes.delete(name)) {
      this._attrVersion++;
      touch(this);
      if (styleDependencies.descendants || styleDependencies.siblings || styleDependencies.ancestors) restyleAround(this);
      if (observed) notify({ type: "attributes", target: this, attributeName: name, oldValue: oldValue ?? null });
    }
  }
  removeAttributeNS(_namespace: string | null, name: string): void { this.removeAttribute(name); }
  toggleAttribute(name: string, force?: boolean): boolean {
    const next = force ?? !this.hasAttribute(name);
    if (next) this.setAttribute(name, ""); else this.removeAttribute(name);
    return next;
  }

  get id(): string { return this.getAttribute("id") ?? ""; }
  set id(value: string) { this.setAttribute("id", value); }
  get className(): string { return this.getAttribute("class") ?? ""; }
  set className(value: string) { this.setAttribute("class", value ?? ""); }
  get classList(): TClassList { return this._classList ??= new TClassList(this); }
  get style(): TStyle { return this._style ??= new TStyle(this); }
  set style(value: string) { this.style.cssText = value; }
  get children(): TElement[] { return this.childNodes.filter((node): node is TElement => node.nodeType === ELEMENT_NODE); }
  get firstElementChild(): TElement | null { return this.children[0] ?? null; }
  get innerHTML(): string { return this.childNodes.map(serialize).join(""); }
  set innerHTML(html: string) {
    while (this._first) this._unlink(this._first);
    const target = this.localName === "template" ? (this as unknown as TTemplateElement).content : this;
    parseHtml(String(html ?? ""), target, this.namespaceURI);
    touch(this);
  }
  get outerHTML(): string { return serialize(this); }

  get value(): string {
    if (this.localName === "select") return this.selectedOptions[0]?.value ?? "";
    if (this.localName === "option") return this.getAttribute("value") ?? (this.textContent ?? "").trim().replace(/\s+/g, " ");
    return this._value ?? this.getAttribute("value") ?? (this.localName === "textarea" ? this.textContent ?? "" : "");
  }
  set value(next: string) {
    const text = next == null ? "" : String(next);
    if (this.localName === "select") {
      for (const option of this.options) option.selected = option.value === text;
      return;
    }
    if (this.localName === "option") { this.setAttribute("value", text); return; }
    if (this._value === text) return;
    this._value = text;
    touch(this);
  }

  /** The select an option belongs to (through an optgroup). */
  get _ownerSelect(): TElement | null {
    let parent = this.parentElement;
    if (parent?.localName === "optgroup") parent = parent.parentElement;
    return parent?.localName === "select" ? parent : null;
  }
  get options(): TElement[] {
    const out: TElement[] = [];
    for (const child of this.children) {
      if (child.localName === "option") out.push(child);
      else if (child.localName === "optgroup") for (const option of child.children) if (option.localName === "option") out.push(option);
    }
    return out;
  }
  get selectedOptions(): TElement[] {
    const options = this.options;
    const selected = options.filter(option => option.selected);
    if (selected.length || this.hasAttribute("multiple") || this.hasAttribute("size")) return selected;
    // A single select always shows one option: the first enabled one by default.
    const fallback = options.find(option => !option.hasAttribute("disabled"));
    return fallback ? [fallback] : [];
  }
  get selectedIndex(): number {
    const first = this.selectedOptions[0];
    return first ? this.options.indexOf(first) : -1;
  }
  set selectedIndex(index: number) {
    this.options.forEach((option, at) => { option.selected = at === index; });
  }
  get selected(): boolean { return this._checked ?? this.hasAttribute("selected"); }
  set selected(next: boolean) {
    const value = !!next;
    const select = this._ownerSelect;
    if (value && select && !select.hasAttribute("multiple")) {
      for (const option of select.options) if (option !== this && option.selected) { option._checked = false; option._attrVersion++; touch(option); }
    }
    if (this._checked === value) return;
    this._checked = value;
    this._attrVersion++;
    touch(this);
  }
  get defaultSelected(): boolean { return this.hasAttribute("selected"); }
  set defaultSelected(value: boolean) { this.toggleAttribute("selected", !!value); }
  get index(): number { return this._ownerSelect?.options.indexOf(this) ?? 0; }
  get text(): string { return (this.textContent ?? "").trim().replace(/\s+/g, " "); }
  get label(): string { return this.getAttribute("label") ?? this.text; }
  get _isChecked(): boolean { return this.localName === "option" ? this.selected : (this.localName === "input" && this.checked); }
  get _isDisabled(): boolean {
    if (this.hasAttribute("disabled")) return true;
    return this.localName === "option" && this.parentElement?.localName === "optgroup" && this.parentElement.hasAttribute("disabled");
  }
  get checked(): boolean { return this._checked ?? this.hasAttribute("checked"); }
  set checked(next: boolean) {
    if (this._checked === !!next) return;
    this._checked = !!next;
    // :checked rules read it.
    this._attrVersion++;
    touch(this);
  }
  get type(): string { return this.getAttribute("type") ?? (this.localName === "input" ? "text" : this.localName === "button" ? "submit" : ""); }
  set type(value: string) { this.setAttribute("type", value); }

  focus(): void { if (isFocusable(this)) moveFocus(this); }
  blur(): void { if (documentInstance.activeElement === this) moveFocus(null); }
  /** The size native laid this element out at (ResizeObserver, `bind:clientWidth`, `getBoundingClientRect`). */
  _size?: { width: number; height: number };
  /** Where native placed the border box in the window, and its size. */
  _box?: { x: number; y: number; width: number; height: number };
  _resizeObservers?: Set<TResizeObserver>;
  /** An IntersectionObserver target sits inside: native reports this element's scroll offset. */
  _scrollTracked = false;
  /** Something read this element's layout: it now asks native for size reports. */
  _measured = false;
  /** The layout epoch the box was measured at (see `layout`). */
  _boxEpoch = -1;
  _measure(): void {
    if (this._measured) return;
    this._measured = true;
    measuredElements.add(this);
    this._attrVersion++;
    touch(this);
  }
  /** A native size report: the content box, and the border box's position and size. */
  /** A layout read: native boxes are current, synchronously when they are stale. */
  _layout(withParent = false): void {
    this._measure();
    readLayout(this, withParent);
  }
  _sized(size: { width: number; height: number; x?: number; y?: number; borderWidth?: number; borderHeight?: number }): void {
    this._boxEpoch = layout.rendered;
    const previous = this._size;
    this._size = { width: size.width, height: size.height };
    if (size.x !== undefined && size.y !== undefined) this._box = { x: size.x, y: size.y, width: size.borderWidth ?? size.width, height: size.borderHeight ?? size.height };
    scheduleIntersections();
    if (previous && previous.width === size.width && previous.height === size.height) return;
    for (const observer of this._resizeObservers ?? []) observer._notify(this);
  }
  /** HTMLElement.click(), with a checkbox's and radio's activation (toggle, then input and change). */
  click(): void {
    if (this._isDisabled) return;
    const toggles = this.localName === "input" && (this.type === "checkbox" || this.type === "radio");
    const before = this.checked;
    if (toggles) this.checked = this.type === "radio" ? true : !before;
    const proceed = this.dispatchEvent(new TEvent("click", { bubbles: true, cancelable: true }));
    if (!toggles) return;
    if (!proceed) { this.checked = before; return; }
    if (this.checked !== before) {
      this.dispatchEvent(new TEvent("input", { bubbles: true }));
      this.dispatchEvent(new TEvent("change", { bubbles: true }));
    }
  }
  /** The border box in the window, after ancestor scroll offsets. The first read starts size reports; until native answers it is empty. */
  getBoundingClientRect() {
    this._layout();
    return domRect(clientBox(this) ?? { x: 0, y: 0, ...(this._size ?? { width: 0, height: 0 }) });
  }
  getClientRects() { return [this.getBoundingClientRect()]; }
  get clientWidth(): number { this._layout(); return this._size?.width ?? 0; }
  get clientHeight(): number { this._layout(); return this._size?.height ?? 0; }
  get offsetWidth(): number { this._layout(); return this._box?.width ?? this._size?.width ?? 0; }
  get offsetHeight(): number { this._layout(); return this._box?.height ?? this._size?.height ?? 0; }
  get offsetLeft(): number { this._layout(true); return (this._box?.x ?? 0) - (this.parentElement?._box?.x ?? 0); }
  get offsetTop(): number { this._layout(true); return (this._box?.y ?? 0) - (this.parentElement?._box?.y ?? 0); }
  get offsetParent(): TElement | null { return this.parentElement; }
  get scrollWidth(): number { return this.clientWidth; }
  get scrollHeight(): number { return this.clientHeight; }
  /** input/textarea selection, read from native while the field has focus. */
  get selectionStart(): number | null { return this._textSelection()?.start ?? this._valueLength(); }
  get selectionEnd(): number | null { return this._textSelection()?.end ?? this._valueLength(); }
  get selectionDirection(): string { return this._textSelection()?.backward ? "backward" : "forward"; }
  _textSelection() { return (this.localName === "input" || this.localName === "textarea") && documentInstance.activeElement === this ? editing?.selectionOf(this) : undefined; }
  _valueLength(): number | null { return this.localName === "input" || this.localName === "textarea" ? String(this.value ?? "").length : null; }
  /** `contenteditable`: rich text in a native text area (see editable.ts). */
  get isContentEditable(): boolean {
    const value = this.getAttribute("contenteditable");
    return value === "" || value === "true" || value === "plaintext-only";
  }
  get innerText(): string { return this.textContent ?? ""; }
  set innerText(value: string) { this.textContent = value; }
  scrollTo(): void {}
  scrollIntoView(): void {}
  querySelector(selector: string): TElement | null { return query(this, selector, true)[0] ?? null; }
  querySelectorAll(selector: string): TElement[] { return query(this, selector, false); }
  closest(selector: string): TElement | null {
    for (let current: TElement | null = this; current; current = current.parentElement) if (matchesList(current, selector)) return current;
    return null;
  }
  matches(selector: string): boolean { return matchesList(this, selector); }
  get dataset(): Record<string, string> {
    const element = this;
    return new Proxy({} as Record<string, string>, {
      get: (_, key) => typeof key === "string" ? element.getAttribute("data-" + kebab(key)) ?? undefined : undefined,
      set: (_, key, value) => { element.setAttribute("data-" + kebab(String(key)), value); return true; },
      deleteProperty: (_, key) => { element.removeAttribute("data-" + kebab(String(key))); return true; },
    });
  }
  /** Running Web Animations, oldest first: the latest one's frame wins. */
  _animations?: Map<object, Record<string, string>>;
  /** The CSS of the animation frames applied now (`animate()`), over the element's own style. */
  get _animationStyle(): Record<string, string> | undefined {
    if (!this._animations?.size) return undefined;
    let style: Record<string, string> | undefined;
    for (const frame of this._animations.values()) style = { ...style, ...frame };
    return style;
  }
  _setAnimationFrame(animation: object, frame: Record<string, string> | undefined): void {
    if (frame) (this._animations ??= new Map()).set(animation, frame);
    else if (!this._animations?.delete(animation)) return;
    this._attrVersion++;
    touch(this);
  }
  /**
   * Web Animations, driven at 60 fps: each frame restyles this element with the
   * keyframes interpolated at that time (Svelte's transitions sample their CSS into
   * keyframes; CSS `animation` passes its @keyframes). Stops when the element leaves the document.
   */
  animate(keyframes: Record<string, string | number | null | undefined>[] | null, options: number | { duration?: number; delay?: number; fill?: string; iterations?: number; direction?: string; easing?: string } = {}) {
    const timing = typeof options === "number" ? { duration: options } : options;
    const duration = Math.max(0, Number(timing.duration ?? 0));
    const delay = Math.max(0, Number(timing.delay ?? 0));
    const iterations = timing.iterations === undefined ? 1 : Math.max(0, Number(timing.iterations));
    const direction = timing.direction ?? "normal";
    const ease = easing(timing.easing ?? "linear");
    const frames = keyframesOf(keyframes ?? []);
    const element = this;
    let resolveFinished!: () => void;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const started = performance.now();
    const total = delay + duration * iterations;
    const animation = {
      onfinish: null as null | (() => void),
      oncancel: null as null | (() => void),
      currentTime: 0 as number | null,
      playState: "running",
      finished: new Promise<void>(resolve => { resolveFinished = resolve; }),
      effect: { getComputedTiming: () => ({ progress: duration ? Math.min(1, Number(animation.currentTime) / duration) : 1 }), getKeyframes: () => frames, target: element },
      cancel() {
        if (timer) clearTimeout(timer);
        if (animation.playState === "idle") return;
        animation.playState = "idle";
        animation.currentTime = null;
        element._setAnimationFrame(animation, undefined);
        animation.oncancel?.();
      },
      finish() { if (timer) clearTimeout(timer); step(true); },
      play() {}, pause() {}, reverse() {}, commitStyles() {}, persist() {},
      addEventListener(type: string, listener: () => void) { if (type === "finish") void animation.finished.then(listener); },
      removeEventListener() {},
    };
    /** Frame at an iteration's progress (0–1), after direction and easing. */
    const sample = (progress: number, iteration: number) => {
      const reversed = direction === "reverse" || (direction === "alternate" && iteration % 2 === 1) || (direction === "alternate-reverse" && iteration % 2 === 0);
      return interpolateFrames(frames, ease(reversed ? 1 - progress : progress));
    };
    const step = (end = false) => {
      if (animation.playState !== "running") return;
      if (!end && !element.isConnected && performance.now() - started > 100) { animation.cancel(); return; }
      const elapsed = end ? total : performance.now() - started;
      const active = Math.max(0, elapsed - delay);
      animation.currentTime = Math.min(active, duration * iterations);
      if (elapsed >= total) {
        animation.playState = "finished";
        const last = iterations === 0 ? 0 : Math.ceil(iterations) - 1;
        const endProgress = iterations % 1 || 1;
        element._setAnimationFrame(animation, timing.fill === "forwards" || timing.fill === "both" ? sample(endProgress, last) : undefined);
        animation.onfinish?.();
        resolveFinished();
        return;
      }
      if (elapsed >= delay) {
        const iteration = duration ? Math.floor(active / duration) : 0;
        const progress = duration ? (active % duration) / duration : 1;
        element._setAnimationFrame(animation, sample(progress, iteration));
      } else if (timing.fill === "backwards" || timing.fill === "both") element._setAnimationFrame(animation, sample(0, 0));
      timer = setTimeout(step, 16);
    };
    // The first frame shows now; time advances (and `onfinish` fires) only after the caller set its handlers.
    if (!delay || timing.fill === "backwards" || timing.fill === "both") element._setAnimationFrame(animation, sample(0, 0));
    timer = setTimeout(step, 0);
    return animation;
  }
  getAnimations(): unknown[] { return []; }
}
for (const name of BOOLEAN_PROPS) {
  if (name === "checked" || name === "selected") continue;
  const attribute = name.toLowerCase();
  Object.defineProperty(TElement.prototype, name, {
    configurable: true,
    get(this: TElement) { return this.hasAttribute(attribute); },
    set(this: TElement, value: boolean) { this.toggleAttribute(attribute, !!value); },
  });
}
for (const name of ["placeholder", "name", "src", "href", "alt", "title", "min", "max", "step", "htmlFor", "tabIndex", "lang", "dir", "role"]) {
  const attribute = name === "htmlFor" ? "for" : name.toLowerCase();
  Object.defineProperty(TElement.prototype, name, {
    configurable: true,
    get(this: TElement) { return this.getAttribute(attribute) ?? ""; },
    set(this: TElement, value: unknown) { if (value == null) this.removeAttribute(attribute); else this.setAttribute(attribute, value); },
  });
}

export class THTMLElement extends TElement {}
export class TSVGElement extends TElement {}
let mediaHook: ((element: THTMLMediaElement, action: "play" | "pause" | "seek", value?: number) => void) | undefined;
/** Native playback for `<audio>`: the mount sets this to the app's media controller. */
export function setMediaHook(hook: typeof mediaHook): void { mediaHook = hook; }

const emptyRanges = { length: 0, start: () => 0, end: () => 0 };

/** HTMLMediaElement over Tarve's native audio: state comes back as media events. */
export class THTMLMediaElement extends THTMLElement {
  _paused = true;
  _time = 0;
  _duration = NaN;
  _ended = false;
  _volume = 1;
  _mutedValue?: boolean;
  _seeking = false;
  readyState = 0;
  playbackRate = 1;
  defaultPlaybackRate = 1;
  get paused(): boolean { return this._paused; }
  set paused(value: boolean) { if (value) this.pause(); else void this.play(); }
  get ended(): boolean { return this._ended; }
  get duration(): number { return this._duration; }
  get seeking(): boolean { return this._seeking; }
  get currentTime(): number { return this._time; }
  set currentTime(seconds: number) {
    this._time = Number(seconds);
    this._seeking = true;
    mediaHook?.(this, "seek", this._time);
  }
  get volume(): number { return this._volume; }
  set volume(value: number) {
    if (this._volume === value) return;
    this._volume = Math.min(1, Math.max(0, Number(value)));
    this._attrVersion++;
    touch(this);
    this.dispatchEvent(new TEvent("volumechange"));
  }
  get muted(): boolean { return this._mutedValue ?? this.hasAttribute("muted"); }
  set muted(value: boolean) {
    if (this.muted === !!value) return;
    this._mutedValue = !!value;
    this._attrVersion++;
    touch(this);
    this.dispatchEvent(new TEvent("volumechange"));
  }
  get buffered() { return emptyRanges; }
  get played() { return emptyRanges; }
  get seekable() { return this._duration > 0 ? { length: 1, start: () => 0, end: () => this._duration } : emptyRanges; }
  play(): Promise<void> { mediaHook?.(this, "play"); return Promise.resolve(); }
  pause(): void { mediaHook?.(this, "pause"); }
  load(): void {}
  canPlayType(type: string): string { return /audio\/(mpeg|mp3|wav|ogg|flac|aac|mp4)/.test(type) ? "maybe" : ""; }
  /** A native media event: update the state and fire the DOM events a browser would. */
  _media(event: "loadedmetadata" | "play" | "pause" | "timeupdate" | "seeked" | "ended" | "error", info: { currentTime?: number; duration?: number | null; paused?: boolean; message?: string }): void {
    if (info.currentTime !== undefined) this._time = info.currentTime;
    if (info.duration !== undefined && info.duration !== null) this._duration = info.duration;
    if (info.paused !== undefined) this._paused = info.paused;
    const fire = (type: string) => this.dispatchEvent(new TEvent(type));
    switch (event) {
      case "loadedmetadata": this.readyState = 4; this._ended = false; fire("durationchange"); fire("loadedmetadata"); fire("loadeddata"); fire("canplay"); fire("canplaythrough"); break;
      case "play": this._paused = false; this._ended = false; fire("play"); fire("playing"); break;
      case "pause": this._paused = true; fire("pause"); break;
      case "timeupdate": fire("timeupdate"); break;
      case "seeked": this._seeking = false; fire("seeked"); fire("timeupdate"); break;
      case "ended": this._ended = true; this._paused = true; fire("pause"); fire("ended"); break;
      case "error": fire("error"); break;
    }
  }
}

/** DataTransfer for HTML drag and drop between elements of the app. */
export class TDataTransfer {
  _data = new Map<string, string>();
  dropEffect = "none";
  effectAllowed = "all";
  readonly files: unknown[] = [];
  readonly items: unknown[] = [];
  get types(): string[] { return [...this._data.keys()]; }
  setData(format: string, data: string): void { this._data.set(format.toLowerCase() === "text" ? "text/plain" : format.toLowerCase(), String(data)); }
  getData(format: string): string { return this._data.get(format.toLowerCase() === "text" ? "text/plain" : format.toLowerCase()) ?? ""; }
  clearData(format?: string): void { if (format) this._data.delete(format.toLowerCase()); else this._data.clear(); }
  setDragImage(): void {}
}
export class TTemplateElement extends THTMLElement {
  readonly content = new TDocumentFragment();
  override cloneNode(deep = false): TNode {
    const copy = super.cloneNode(false) as TTemplateElement;
    if (deep) for (let child = this.content._first; child; child = child._next) copy.content._link(child.cloneNode(true), null);
    return copy;
  }
}

function createElementFor(tag: string, namespace?: string): TElement {
  if (namespace === "http://www.w3.org/2000/svg") return new TSVGElement(tag, namespace);
  const name = tag.toLowerCase();
  if (name === "template") return new TTemplateElement(name);
  if (name === "audio" || name === "video") return new THTMLMediaElement(name);
  return new THTMLElement(name, namespace ?? undefined);
}

export class TDocument extends TNode {
  override nodeType = DOCUMENT_NODE;
  override nodeName = "#document";
  readonly documentElement: TElement;
  readonly head: TElement;
  readonly body: TElement;
  activeElement: TElement | null = null;
  readonly readyState = "complete";
  _title = "";
  onTitle?: (title: string) => void;
  constructor() {
    super();
    this.documentElement = new THTMLElement("html");
    this.head = new THTMLElement("head");
    this.body = new THTMLElement("body");
    this._link(this.documentElement, null);
    this.documentElement._link(this.head, null);
    this.documentElement._link(this.body, null);
  }
  get title(): string { return this._title; }
  set title(value: string) {
    if (this._title === value) return;
    this._title = String(value);
    this.onTitle?.(this._title);
  }
  createElement(tag: string): TElement { return createElementFor(tag); }
  createElementNS(namespace: string | null, tag: string): TElement { return createElementFor(tag, namespace ?? undefined); }
  createTextNode(data: string): TText { return new TText(String(data)); }
  getSelection(): unknown { return editing?.getSelection() ?? null; }
  execCommand(command: string, ui?: boolean, value?: string): boolean { return editing?.execCommand(command, ui, value) ?? false; }
  queryCommandState(command: string): boolean { return editing?.queryCommandState(command) ?? false; }
  queryCommandSupported(command: string): boolean { return editing?.queryCommandSupported(command) ?? false; }
  queryCommandEnabled(command: string): boolean { return this.queryCommandSupported(command); }
  createComment(data: string): TComment { return new TComment(String(data)); }
  createDocumentFragment(): TDocumentFragment { return new TDocumentFragment(); }
  importNode<T extends TNode>(node: T, deep = false): T { return node.cloneNode(deep) as T; }
  createEvent(): TEvent { return new TEvent(""); }
  querySelector(selector: string): TElement | null { return query(this, selector, true)[0] ?? null; }
  querySelectorAll(selector: string): TElement[] { return query(this, selector, false); }
  getElementById(id: string): TElement | null {
    const visit = (node: TNode): TElement | null => {
      if (node.nodeType === ELEMENT_NODE && (node as TElement).getAttribute("id") === id) return node as TElement;
      for (let child = node._first; child; child = child._next) { const found = visit(child); if (found) return found; }
      return null;
    };
    return visit(this);
  }
  hasFocus(): boolean { return true; }
}

export class TWindow extends TEventTarget {
  getSelection(): unknown { return documentInstance.getSelection(); }
  innerWidth = 1120;
  innerHeight = 820;
  /** `prefers-color-scheme: dark`. */
  _dark = false;
  devicePixelRatio = 1;
  get document(): TDocument { return documentInstance; }
  /**
   * Computed CSS as Svelte's transitions read it (`fade` reads opacity, `slide`
   * height and padding): the inline value, else the laid-out size, else the CSS initial value.
   */
  getComputedStyle(element: TElement) {
    const initial: Record<string, string> = {
      opacity: "1", transform: "none", display: element.localName === "span" ? "inline" : "block", visibility: "visible",
      "padding-top": "0px", "padding-bottom": "0px", "padding-left": "0px", "padding-right": "0px",
      "margin-top": "0px", "margin-bottom": "0px", "margin-left": "0px", "margin-right": "0px",
      "border-top-width": "0px", "border-bottom-width": "0px", "border-left-width": "0px", "border-right-width": "0px",
      "flex-direction": "row", position: "static", overflow: "visible", "font-size": "16px", color: "rgb(0, 0, 0)",
    };
    const read = (name: string) => {
      const own = element.style.getPropertyValue(name);
      if (own) return own;
      if (name === "width" || name === "height") return `${element._size?.[name] ?? 0}px`;
      return initial[name] ?? "";
    };
    return new Proxy({ getPropertyValue: read } as Record<string | symbol, unknown>, {
      get: (target, key) => typeof key === "string" && !(key in target) ? read(kebab(key)) : target[key],
    });
  }
  matchMedia(query: string) {
    const test = () => {
      const window = this;
      return query.split(/\s+and\s+/i).every(part => {
        const feature = /\(\s*([\w-]+)\s*:\s*([^)]+?)\s*\)/.exec(part);
        if (!feature) return /^\s*(only\s+)?(screen|all)\s*$/i.test(part);
        const value = parseFloat(feature[2]!);
        switch (feature[1]) {
          case "min-width": return window.innerWidth >= value;
          case "max-width": return window.innerWidth <= value;
          case "min-height": return window.innerHeight >= value;
          case "max-height": return window.innerHeight <= value;
          case "prefers-color-scheme": return (feature[2] === "dark") === window._dark;
          case "prefers-reduced-motion": return feature[2] === "no-preference";
          case "orientation": return (feature[2] === "portrait") === (window.innerHeight >= window.innerWidth);
          default: return false;
        }
      });
    };
    const list = new TEventTarget() as TEventTarget & { matches: boolean; media: string; onchange: unknown; addListener(fn: (event: unknown) => void): void; removeListener(fn: (event: unknown) => void): void };
    list.matches = test();
    list.media = query;
    list.onchange = null;
    list.addListener = fn => list.addEventListener("change", fn);
    list.removeListener = fn => list.removeEventListener("change", fn);
    // A resize may flip the query: tell its listeners, as a MediaQueryList does.
    this.addEventListener("resize", () => {
      const matches = test();
      if (matches === list.matches) return;
      list.matches = matches;
      list.dispatchEvent(new TEvent("change", { matches, media: query }));
    });
    return list;
  }
  scrollTo(): void {}
}

export const documentInstance = new TDocument();
export const windowInstance = new TWindow();

const VOID = new Set(["area", "base", "br", "col", "embed", "hr", "img", "input", "link", "meta", "source", "track", "wbr"]);
const ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: "\"", apos: "'", nbsp: "\u00a0" };
const decode = (text: string) => text.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (match, entity: string) => {
  if (entity[0] === "#") return String.fromCodePoint(entity[1]?.toLowerCase() === "x" ? parseInt(entity.slice(2), 16) : parseInt(entity.slice(1), 10));
  return ENTITIES[entity.toLowerCase()] ?? match;
});
const escape = (text: string) => text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

/** Parses the HTML Svelte's templates and `{@html}` produce into `target`. */
export function parseHtml(html: string, target: TNode, namespace?: string): void {
  const stack: TNode[] = [target];
  const svg = "http://www.w3.org/2000/svg";
  const namespaceOf = (node: TNode) => node.nodeType === ELEMENT_NODE ? (node as TElement).namespaceURI : namespace;
  const tagPattern = /<!--([\s\S]*?)-->|<\/([a-zA-Z][\w:-]*)\s*>|<([a-zA-Z][\w:-]*)((?:\s+[^\s"'>/=]+(?:\s*=\s*(?:"[^"]*"|'[^']*'|[^\s"'=<>`]+))?)*)\s*(\/?)>/g;
  const attributePattern = /([^\s"'>/=]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/g;
  let last = 0;
  for (let match = tagPattern.exec(html); match; match = tagPattern.exec(html)) {
    const parent = stack[stack.length - 1]!;
    if (match.index > last) parent.appendChild(new TText(decode(html.slice(last, match.index))));
    last = tagPattern.lastIndex;
    if (match[1] !== undefined) { parent.appendChild(new TComment(match[1])); continue; }
    if (match[2] !== undefined) {
      const name = match[2].toLowerCase();
      for (let index = stack.length - 1; index > 0; index--) {
        if ((stack[index] as TElement).localName.toLowerCase() === name) { stack.length = index; break; }
      }
      continue;
    }
    const tag = match[3]!;
    const parentNamespace = namespaceOf(parent);
    const elementNamespace = tag.toLowerCase() === "svg" ? svg : parentNamespace === svg ? svg : undefined;
    const element = createElementFor(elementNamespace === svg ? tag : tag.toLowerCase(), elementNamespace);
    for (let attribute = attributePattern.exec(match[4] ?? ""); attribute; attribute = attributePattern.exec(match[4] ?? "")) {
      element.setAttribute(attribute[1]!, decode(attribute[2] ?? attribute[3] ?? attribute[4] ?? ""));
    }
    attributePattern.lastIndex = 0;
    const host = parent.nodeType === ELEMENT_NODE && (parent as TElement).localName === "template" ? (parent as TTemplateElement).content : parent;
    host.appendChild(element);
    if (!match[5] && !VOID.has(tag.toLowerCase())) stack.push(element);
  }
  if (last < html.length) stack[stack.length - 1]!.appendChild(new TText(decode(html.slice(last))));
}

function serialize(node: TNode): string {
  if (node.nodeType === TEXT_NODE) return escape((node as TText).data);
  if (node.nodeType === COMMENT_NODE) return `<!--${(node as TComment).data}-->`;
  if (node.nodeType !== ELEMENT_NODE) return node.childNodes.map(serialize).join("");
  const element = node as TElement;
  let attributes = "";
  for (const name of element.getAttributeNames()) attributes += ` ${name}="${escape(element.getAttribute(name) ?? "").replace(/"/g, "&quot;")}"`;
  if (element._style?.length && !element._attributes.has("style")) attributes += ` style="${element._style.cssText}"`;
  if (VOID.has(element.localName)) return `<${element.localName}${attributes}>`;
  return `<${element.localName}${attributes}>${element.childNodes.map(serialize).join("")}</${element.localName}>`;
}

const FOCUSABLE = new Set(["input", "textarea", "select", "button"]);
export function isFocusable(element: TElement): boolean {
  if (element._isDisabled) return false;
  if (FOCUSABLE.has(element.localName)) return true;
  if (element.localName === "a" && element.hasAttribute("href")) return true;
  if (element.isContentEditable) return true;
  const tabindex = element.getAttribute("tabindex");
  return tabindex !== null && Number.isFinite(Number(tabindex));
}

let focusHook: ((element: TElement | null) => void) | undefined;
/** Native focus follows script focus (`element.focus()`); the mount sets this. */
export function setFocusHook(hook: ((element: TElement | null) => void) | undefined): void { focusHook = hook; }

/**
 * Moves `document.activeElement` and fires blur/focusout then focus/focusin, as
 * the DOM does. `fromNative`: native already moved its focus (a click, a key).
 */
export function moveFocus(next: TElement | null, fromNative = false): void {
  const previous = documentInstance.activeElement;
  if (previous === next) return;
  documentInstance.activeElement = next;
  if (previous) {
    previous.dispatchEvent(new TEvent("blur", { relatedTarget: next }));
    previous.dispatchEvent(new TEvent("focusout", { bubbles: true, relatedTarget: next }));
  }
  if (next) {
    next.dispatchEvent(new TEvent("focus", { relatedTarget: previous }));
    next.dispatchEvent(new TEvent("focusin", { bubbles: true, relatedTarget: previous }));
  }
  if (!fromNative) focusHook?.(next);
}

type ResizeEntry = { target: TElement; contentRect: ReturnType<TElement["getBoundingClientRect"]>; borderBoxSize: { inlineSize: number; blockSize: number }[]; contentBoxSize: { inlineSize: number; blockSize: number }[]; devicePixelContentBoxSize: { inlineSize: number; blockSize: number }[] };

/** ResizeObserver over native layout: an observed element reports its size (`onSize`). */
export class TResizeObserver {
  _targets = new Set<TElement>();
  _pending = new Set<TElement>();
  constructor(readonly _callback: (entries: ResizeEntry[], observer: TResizeObserver) => void) {}
  observe(target: TElement): void {
    if (this._targets.has(target)) return;
    this._targets.add(target);
    (target._resizeObservers ??= new Set()).add(this);
    // The element now asks native for its size; an observation starts with its current size.
    target._attrVersion++;
    touch(target);
    if (target._size) this._notify(target);
  }
  unobserve(target: TElement): void {
    this._targets.delete(target);
    target._resizeObservers?.delete(this);
  }
  disconnect(): void {
    for (const target of this._targets) target._resizeObservers?.delete(this);
    this._targets.clear();
  }
  _notify(target: TElement): void {
    if (!this._pending.size) queueMicrotask(() => {
      const entries = [...this._pending].map(element => {
        const rect = domRect(clientBox(element) ?? { x: 0, y: 0, ...(element._size ?? { width: 0, height: 0 }) });
        const box = [{ inlineSize: rect.width, blockSize: rect.height }];
        return { target: element, contentRect: rect, borderBoxSize: box, contentBoxSize: box, devicePixelContentBoxSize: box };
      });
      this._pending.clear();
      if (entries.length) this._callback(entries, this);
    });
    this._pending.add(target);
  }
}

type IntersectionOptions = { root?: TElement | null; rootMargin?: string; threshold?: number | number[] };
type Rect = { x: number; y: number; width: number; height: number };
const liveIntersectionObservers = new Set<TIntersectionObserver>();
let intersectionsQueued = false;

/** Layout or a scroll offset moved: observers recompute once, after the current task. */
export function scheduleIntersections(): void {
  if (intersectionsQueued || !liveIntersectionObservers.size) return;
  intersectionsQueued = true;
  queueMicrotask(() => {
    intersectionsQueued = false;
    for (const observer of liveIntersectionObservers) observer._check();
  });
}

/** The border box in the window, after the scroll offsets of its ancestors. */
function clientBox(element: TElement): Rect | undefined {
  const box = element._box;
  if (!box) return undefined;
  let { x, y } = box;
  for (let parent = element.parentElement; parent; parent = parent.parentElement) { x -= parent.scrollLeft; y -= parent.scrollTop; }
  return { x, y, width: box.width, height: box.height };
}

function clips(element: TElement): boolean {
  if (element.localName === "scroll") return true;
  const style = element._renderCache?.props.style as Record<string, unknown> | undefined;
  const overflow = style?.overflow ?? style?.overflowX ?? style?.overflowY;
  return overflow !== undefined && overflow !== "visible";
}

function intersect(a: Rect, b: Rect): Rect | undefined {
  const x = Math.max(a.x, b.x), y = Math.max(a.y, b.y);
  const right = Math.min(a.x + a.width, b.x + b.width), bottom = Math.min(a.y + a.height, b.y + b.height);
  return right >= x && bottom >= y ? { x, y, width: right - x, height: bottom - y } : undefined;
}

function domRect(rect: Rect) {
  const { x, y, width, height } = rect;
  return { x, y, width, height, top: y, left: x, right: x + width, bottom: y + height, toJSON() { return this; } };
}

/** CSS-like margins in px or % (of the root's size): top, right, bottom, left. */
function margins(value: string, root: Rect): [number, number, number, number] {
  const parts = value.trim().split(/\s+/).filter(Boolean);
  const [top = "0px", right = top, bottom = top, left = right] = parts;
  const px = (part: string, size: number) => part.endsWith("%") ? size * parseFloat(part) / 100 : parseFloat(part) || 0;
  return [px(top, root.height), px(right, root.width), px(bottom, root.height), px(left, root.width)];
}

/** IntersectionObserver over native layout: element boxes, ancestor scroll offsets and clipping, the window. */
class TIntersectionObserver {
  readonly root: TElement | null;
  readonly rootMargin: string;
  readonly thresholds: readonly number[];
  private readonly targets = new Map<TElement, number | undefined>();
  private records: unknown[] = [];
  constructor(private readonly callback: (entries: unknown[], observer: TIntersectionObserver) => void, options: IntersectionOptions = {}) {
    this.root = options.root ?? null;
    this.rootMargin = options.rootMargin ?? "0px";
    const threshold = options.threshold ?? 0;
    this.thresholds = (Array.isArray(threshold) ? [...threshold] : [threshold]).sort((a, b) => a - b);
    if (this.thresholds.some(value => value < 0 || value > 1)) throw new RangeError("Threshold values must be between 0 and 1");
  }
  observe(target: TElement): void {
    if (this.targets.has(target)) return;
    this.targets.set(target, undefined);
    liveIntersectionObservers.add(this);
    // The target and every ancestor report their boxes; ancestors also report scroll offsets.
    target._measure();
    for (let parent = target.parentElement; parent; parent = parent.parentElement) {
      if (!parent._scrollTracked) { parent._scrollTracked = true; parent._measured = false; }
      parent._measure();
    }
    scheduleIntersections();
  }
  unobserve(target: TElement): void {
    this.targets.delete(target);
    if (!this.targets.size) liveIntersectionObservers.delete(this);
  }
  disconnect(): void {
    this.targets.clear();
    liveIntersectionObservers.delete(this);
  }
  takeRecords(): unknown[] { const records = this.records; this.records = []; return records; }
  _check(): void {
    const viewport = { x: 0, y: 0, width: windowInstance.innerWidth, height: windowInstance.innerHeight };
    for (const [target, previous] of this.targets) {
      const rect = clientBox(target);
      if (!rect || !target.isConnected) continue;
      const rootBox = this.root ? clientBox(this.root) : viewport;
      if (!rootBox) continue;
      const [top, right, bottom, left] = margins(this.rootMargin, rootBox);
      const bounds = { x: rootBox.x - left, y: rootBox.y - top, width: rootBox.width + left + right, height: rootBox.height + top + bottom };
      let visible: Rect | undefined = rect;
      for (let parent = target.parentElement; visible && parent && parent !== this.root; parent = parent.parentElement) {
        const box = clips(parent) ? clientBox(parent) : undefined;
        if (box) visible = intersect(visible, box);
      }
      if (visible) visible = intersect(visible, bounds);
      const isIntersecting = visible !== undefined;
      const area = rect.width * rect.height;
      const ratio = !visible ? 0 : area > 0 ? Math.min(1, (visible.width * visible.height) / area) : 1;
      const index = isIntersecting ? this.thresholds.filter(value => ratio >= value).length : -1;
      if (index === previous) continue;
      this.targets.set(target, index);
      this.records.push({
        target, isIntersecting, intersectionRatio: ratio, time: performance.now(),
        boundingClientRect: domRect(rect), intersectionRect: domRect(visible ?? { x: 0, y: 0, width: 0, height: 0 }), rootBounds: domRect(bounds),
      });
    }
    if (this.records.length) this.callback(this.takeRecords(), this);
  }
}

/** Selection and editing commands, provided by the contenteditable module. */
interface Editing {
  getSelection(): unknown;
  execCommand(command: string, ui?: boolean, value?: string): boolean;
  queryCommandState(command: string): boolean;
  queryCommandSupported(command: string): boolean;
  selectionOf(element: TElement): { start: number; end: number; backward: boolean } | undefined;
}
let editing: Editing | undefined;
export function setEditing(next: Editing): void { editing = next; }

/** Installs the DOM globals Svelte's client runtime reads. Existing globals are kept. */
export function installDom(): void {
  const scope = globalThis as Record<string, unknown>;
  if (scope.document === documentInstance) return;
  const globals: Record<string, unknown> = {
    window: windowInstance, document: documentInstance,
    Node: TNode, Element: TElement, HTMLElement: THTMLElement, SVGElement: TSVGElement, HTMLMediaElement: THTMLMediaElement,
    HTMLTemplateElement: TTemplateElement, Text: TText, Comment: TComment, CharacterData: TCharacterData,
    DocumentFragment: TDocumentFragment, Document: TDocument, Window: TWindow,
    customElements: { get: () => undefined, define() {}, whenDefined: () => Promise.resolve() },
    DataTransfer: TDataTransfer, MutationObserver: TMutationObserver, ResizeObserver: TResizeObserver, IntersectionObserver: TIntersectionObserver,
    getComputedStyle: (element: TElement) => windowInstance.getComputedStyle(element),
    requestAnimationFrame: (callback: (time: number) => void) => setTimeout(() => callback(performance.now()), 16),
    cancelAnimationFrame: (id: ReturnType<typeof setTimeout>) => clearTimeout(id),
  };
  for (const [name, value] of Object.entries(globals)) {
    if (name === "window" || name === "document" || scope[name] === undefined || name in { Node: 1, Element: 1, HTMLElement: 1, Text: 1, Comment: 1, DocumentFragment: 1, MutationObserver: 1, ResizeObserver: 1, IntersectionObserver: 1, HTMLMediaElement: 1 }) {
      Object.defineProperty(globalThis, name, { value, configurable: true, writable: true });
    }
  }
  if (scope.navigator === undefined) Object.defineProperty(globalThis, "navigator", { value: { userAgent: "Tarve" }, configurable: true, writable: true });
}

export const camelCase = camel;
