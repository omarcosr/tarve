/**
 * Web and Node globals for a Tarve Android app, evaluated before any other module of the
 * bundle (prelude.ts imports it first): console, timers, TextEncoder, crypto, URL, fetch,
 * process. Backed by `__tarveHost` (native/src/android/qjs.rs).
 */
import { host } from "./host";

export {};

const globals = globalThis as Record<string, any>;

// console → logcat (tag "tarve").
function show(value: unknown, depth = 0): string {
  if (typeof value === "string") return value;
  if (value instanceof Error) return `${value.name}: ${value.message}${value.stack ? `\n${value.stack}` : ""}`;
  if (typeof value === "function") return `[Function ${value.name || "anonymous"}]`;
  if (typeof value === "symbol" || typeof value === "bigint") return value.toString();
  if (value === null || typeof value !== "object") return String(value);
  if (depth > 2) return Array.isArray(value) ? "[Array]" : "[Object]";
  try {
    return JSON.stringify(value, (_key, item) => typeof item === "bigint" ? item.toString() : item) ?? String(value);
  } catch {
    return Object.prototype.toString.call(value);
  }
}
function format(args: unknown[]): string {
  const [first, ...rest] = args;
  if (typeof first === "string" && /%[sdifoOjc%]/.test(first)) {
    let index = 0;
    const text = first.replace(/%([sdifoOjc%])/g, (match, kind: string) => {
      if (kind === "%") return "%";
      if (index >= rest.length) return match;
      const value = rest[index++];
      if (kind === "c") return "";
      if (kind === "d" || kind === "i") return String(Math.trunc(Number(value)));
      if (kind === "f") return String(Number(value));
      return show(value);
    });
    return [text, ...rest.slice(index).map(value => show(value))].join(" ");
  }
  return args.map(value => show(value)).join(" ");
}
const counts = new Map<string, number>();
const timings = new Map<string, number>();
const logAt = (level: 0 | 1 | 2) => (...args: unknown[]) => host.log(level, format(args));
globals.console = {
  log: logAt(0), info: logAt(0), debug: logAt(0), trace: logAt(0), dir: logAt(0), table: logAt(0),
  warn: logAt(1), error: logAt(2),
  assert(condition: unknown, ...args: unknown[]) { if (!condition) host.log(2, `Assertion failed${args.length ? `: ${format(args)}` : ""}`); },
  count(label = "default") { const count = (counts.get(label) ?? 0) + 1; counts.set(label, count); host.log(0, `${label}: ${count}`); },
  countReset(label = "default") { counts.delete(label); },
  time(label = "default") { timings.set(label, host.now()); },
  timeLog(label = "default") { const start = timings.get(label); if (start !== undefined) host.log(0, `${label}: ${(host.now() - start).toFixed(3)}ms`); },
  timeEnd(label = "default") { globals.console.timeLog(label); timings.delete(label); },
  group() {}, groupCollapsed() {}, groupEnd() {},
};

function reportError(error: unknown): void {
  host.log(2, `Uncaught ${show(error)}`);
}
globals.reportError ??= reportError;

// Timers: the host loop calls __tarveTick and sleeps until the delay it returns.
interface Timer { id: number; at: number; callback: (...args: unknown[]) => void; args: unknown[]; interval?: number }
const timers = new Map<number, Timer>();
let nextTimer = 1;
/** Node and Bun return an object; `ref`/`unref`/`hasRef` are no-ops, the number coerces to the id. */
class Timeout {
  constructor(readonly id: number) {}
  ref(): this { return this; }
  unref(): this { return this; }
  hasRef(): boolean { return true; }
  refresh(): this { const timer = timers.get(this.id); if (timer) timer.at = host.now() + (timer.interval ?? 0); return this; }
  close(): void { timers.delete(this.id); }
  [Symbol.toPrimitive](): number { return this.id; }
}
function schedule(callback: unknown, delay: unknown, args: unknown[], repeat: boolean): Timeout {
  if (typeof callback !== "function") throw new TypeError("The callback must be a function");
  const ms = Math.max(0, Number(delay) || 0);
  const id = nextTimer++;
  timers.set(id, { id, at: host.now() + ms, callback: callback as Timer["callback"], args, interval: repeat ? Math.max(1, ms) : undefined });
  return new Timeout(id);
}
function cancel(timer: unknown): void {
  if (timer == null) return;
  timers.delete(typeof timer === "object" ? (timer as Timeout).id : Number(timer));
}
globals.setTimeout = (callback: unknown, delay?: unknown, ...args: unknown[]) => schedule(callback, delay, args, false);
globals.setInterval = (callback: unknown, delay?: unknown, ...args: unknown[]) => schedule(callback, delay, args, true);
globals.setImmediate = (callback: unknown, ...args: unknown[]) => schedule(callback, 0, args, false);
globals.clearTimeout = globals.clearInterval = globals.clearImmediate = cancel;
globals.queueMicrotask ??= (callback: () => void) => { void Promise.resolve().then(callback); };
globals.__tarveTick = (): number => {
  const now = host.now();
  const due = [...timers.values()].filter(timer => timer.at <= now).sort((a, b) => a.at - b.at || a.id - b.id);
  for (const timer of due) {
    if (!timers.has(timer.id)) continue;
    if (timer.interval === undefined) timers.delete(timer.id);
    else timer.at = Math.max(timer.at + timer.interval, now);
    try {
      timer.callback(...timer.args);
    } catch (error) {
      reportError(error);
    }
  }
  let next = Infinity;
  for (const timer of timers.values()) next = Math.min(next, timer.at);
  return next === Infinity ? -1 : Math.max(0, next - host.now());
};

const timeOrigin = Date.now() - host.now();
// QuickJS-ng has performance.now (read-only); fill in what it lacks.
if (typeof globals.performance?.now !== "function") globals.performance = { now: () => host.now(), timeOrigin };
for (const [name, value] of Object.entries({ timeOrigin, mark: (): undefined => undefined, measure: (): undefined => undefined })) {
  if (!(name in globals.performance)) {
    try { globals.performance[name] = value; } catch { /* read-only */ }
  }
}

// Encoding.
class TextEncoder {
  readonly encoding = "utf-8";
  encode(input = ""): Uint8Array { return host.encode(String(input)); }
  encodeInto(input: string, destination: Uint8Array): { read: number; written: number } {
    const bytes = this.encode(input);
    if (bytes.length <= destination.length) {
      destination.set(bytes);
      return { read: input.length, written: bytes.length };
    }
    // Whole characters only.
    let read = 0;
    let written = 0;
    for (const character of input) {
      const encoded = this.encode(character);
      if (written + encoded.length > destination.length) break;
      destination.set(encoded, written);
      written += encoded.length;
      read += character.length;
    }
    return { read, written };
  }
}
function bytesOf(input: ArrayBuffer | ArrayBufferView): Uint8Array {
  if (input instanceof Uint8Array) return input;
  if (ArrayBuffer.isView(input)) return new Uint8Array(input.buffer, input.byteOffset, input.byteLength);
  return new Uint8Array(input);
}
class TextDecoder {
  readonly encoding: string;
  readonly fatal: boolean;
  readonly ignoreBOM: boolean;
  constructor(label = "utf-8", options: { fatal?: boolean; ignoreBOM?: boolean } = {}) {
    const name = String(label).trim().toLowerCase();
    if (name !== "utf-8" && name !== "utf8" && name !== "unicode-1-1-utf-8") throw new RangeError(`The "${label}" encoding is not supported`);
    this.encoding = "utf-8";
    this.fatal = !!options.fatal;
    this.ignoreBOM = !!options.ignoreBOM;
  }
  decode(input?: ArrayBuffer | ArrayBufferView | null): string {
    if (!input) return "";
    const text = host.decode(bytesOf(input));
    if (this.fatal && text.includes("\uFFFD") && !host.decode(host.encode(text)).includes("\uFFFD")) throw new TypeError("The encoded data was not valid utf-8");
    return !this.ignoreBOM && text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  }
}
globals.TextEncoder ??= TextEncoder;
globals.TextDecoder ??= TextDecoder;

const BASE64 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
globals.btoa ??= (input: string) => {
  const text = String(input);
  let out = "";
  for (let index = 0; index < text.length; index += 3) {
    const codes = [text.charCodeAt(index), text.charCodeAt(index + 1), text.charCodeAt(index + 2)];
    if (codes.some(code => code > 255)) throw new Error("Invalid character");
    const [a, b = NaN, c = NaN] = codes as [number, number, number];
    const bits = (a << 16) | ((b || 0) << 8) | (c || 0);
    out += BASE64[bits >> 18 & 63]! + BASE64[bits >> 12 & 63]! + (Number.isNaN(b) ? "=" : BASE64[bits >> 6 & 63]!) + (Number.isNaN(c) ? "=" : BASE64[bits & 63]!);
  }
  return out;
};
globals.atob ??= (input: string) => {
  const text = String(input).replace(/[\t\n\f\r ]+/g, "").replace(/=+$/, "");
  let out = "";
  let bits = 0;
  let count = 0;
  for (const character of text) {
    const value = BASE64.indexOf(character);
    if (value < 0) throw new Error("Invalid character");
    bits = (bits << 6) | value;
    count += 6;
    if (count >= 8) {
      count -= 8;
      out += String.fromCharCode((bits >> count) & 255);
    }
  }
  return out;
};

// Uint8Array base64/hex (ES2026), which the Buffer shim encodes with: newer QuickJS-ng has them.
const uint8 = Uint8Array as unknown as Record<string, unknown> & { prototype: Record<string, unknown> };
const BASE64URL = BASE64.slice(0, 62) + "-_";
uint8.prototype.toHex ??= function (this: Uint8Array): string {
  let out = "";
  for (const byte of this) out += byte.toString(16).padStart(2, "0");
  return out;
};
uint8.prototype.toBase64 ??= function (this: Uint8Array, options: { alphabet?: string; omitPadding?: boolean } = {}): string {
  const alphabet = options.alphabet === "base64url" ? BASE64URL : BASE64;
  let out = "";
  for (let index = 0; index < this.length; index += 3) {
    const [a, b, c] = [this[index]!, this[index + 1], this[index + 2]];
    const bits = (a << 16) | ((b ?? 0) << 8) | (c ?? 0);
    out += alphabet[bits >> 18 & 63]! + alphabet[bits >> 12 & 63]!;
    out += b === undefined ? (options.omitPadding ? "" : "=") : alphabet[bits >> 6 & 63]!;
    out += c === undefined ? (options.omitPadding ? "" : "=") : alphabet[bits & 63]!;
  }
  return out;
};
uint8.fromHex ??= (text: string): Uint8Array => {
  if (text.length % 2 || /[^0-9a-f]/i.test(text)) throw new SyntaxError("Invalid hex string");
  const out = new Uint8Array(text.length / 2);
  for (let index = 0; index < out.length; index++) out[index] = Number.parseInt(text.slice(index * 2, index * 2 + 2), 16);
  return out;
};
uint8.fromBase64 ??= (text: string, options: { alphabet?: string } = {}): Uint8Array => {
  const alphabet = options.alphabet === "base64url" ? BASE64URL : BASE64;
  const clean = text.replace(/[\t\n\f\r ]+/g, "").replace(/=+$/, "");
  const out = new Uint8Array(Math.floor(clean.length * 3 / 4));
  let bits = 0;
  let count = 0;
  let written = 0;
  for (const character of clean) {
    const value = alphabet.indexOf(character);
    if (value < 0) throw new SyntaxError("Invalid base64 string");
    bits = (bits << 6) | value;
    count += 6;
    if (count >= 8) {
      count -= 8;
      out[written++] = (bits >> count) & 255;
    }
  }
  return out.subarray(0, written);
};

// Web Crypto: random values (crypto.subtle is not provided).
globals.crypto ??= {};
globals.crypto.getRandomValues = <T extends ArrayBufferView>(array: T): T => {
  bytesOf(array).set(host.random(array.byteLength));
  return array;
};
globals.crypto.randomUUID = (): string => {
  const bytes = host.random(16);
  bytes[6] = (bytes[6]! & 0x0f) | 0x40;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = [...bytes].map(byte => byte.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
};

globals.structuredClone ??= (value: unknown) => value === undefined ? undefined : JSON.parse(JSON.stringify(value));

// URL: WHATWG parsing for the absolute and relative URLs apps use (http(s), file, data).
class URLSearchParams {
  private readonly list: [string, string][] = [];
  constructor(init: string | Record<string, string> | [string, string][] = "") {
    if (typeof init === "string") {
      for (const part of init.replace(/^\?/, "").split("&")) {
        if (!part) continue;
        const [name, ...value] = part.split("=");
        const decode = (text: string) => decodeURIComponent(text.replace(/\+/g, " "));
        this.list.push([decode(name!), decode(value.join("="))]);
      }
    } else if (Array.isArray(init)) {
      for (const [name, value] of init) this.list.push([String(name), String(value)]);
    } else {
      for (const [name, value] of Object.entries(init)) this.list.push([name, String(value)]);
    }
  }
  get size(): number { return this.list.length; }
  append(name: string, value: string): void { this.list.push([String(name), String(value)]); }
  delete(name: string): void { for (let index = this.list.length - 1; index >= 0; index--) if (this.list[index]![0] === name) this.list.splice(index, 1); }
  get(name: string): string | null { return this.list.find(([key]) => key === name)?.[1] ?? null; }
  getAll(name: string): string[] { return this.list.filter(([key]) => key === name).map(([, value]) => value); }
  has(name: string): boolean { return this.list.some(([key]) => key === name); }
  set(name: string, value: string): void {
    const index = this.list.findIndex(([key]) => key === name);
    this.delete(name);
    this.list.splice(index < 0 ? this.list.length : index, 0, [String(name), String(value)]);
  }
  sort(): void { this.list.sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0); }
  forEach(callback: (value: string, name: string, params: this) => void): void { for (const [name, value] of this.list) callback(value, name, this); }
  entries(): IterableIterator<[string, string]> { return this.list.map(entry => [...entry] as [string, string])[Symbol.iterator](); }
  keys(): IterableIterator<string> { return this.list.map(([name]) => name)[Symbol.iterator](); }
  values(): IterableIterator<string> { return this.list.map(([, value]) => value)[Symbol.iterator](); }
  [Symbol.iterator](): IterableIterator<[string, string]> { return this.entries(); }
  toString(): string {
    const encode = (text: string) => encodeURIComponent(text).replace(/%20/g, "+");
    return this.list.map(([name, value]) => `${encode(name)}=${encode(value)}`).join("&");
  }
}
const DEFAULT_PORTS: Record<string, string> = { "http:": "80", "https:": "443", "ws:": "80", "wss:": "443", "ftp:": "21" };
function normalizePath(path: string): string {
  const out: string[] = [];
  const parts = path.split("/");
  for (let index = 0; index < parts.length; index++) {
    const part = parts[index]!;
    if (part === "..") {
      if (out.length > 1) out.pop();
      if (index === parts.length - 1) out.push("");
    } else if (part === ".") {
      if (index === parts.length - 1) out.push("");
    } else {
      out.push(part);
    }
  }
  return out.join("/") || "/";
}
class URL {
  protocol = "";
  username = "";
  password = "";
  hostname = "";
  port = "";
  pathname = "";
  private query = "";
  hash = "";
  private params?: URLSearchParams;

  constructor(input: string | URL, base?: string | URL) {
    const text = String(input).trim();
    const absolute = /^([a-zA-Z][a-zA-Z0-9+.-]*):(.*)$/s.exec(text);
    if (absolute) {
      this.parse(absolute[1]!.toLowerCase() + ":", absolute[2]!);
      return;
    }
    if (base === undefined) throw new TypeError(`Invalid URL: ${text}`);
    const parent = new URL(base);
    this.protocol = parent.protocol;
    if (text.startsWith("//")) {
      this.parse(parent.protocol, text);
      return;
    }
    this.username = parent.username;
    this.password = parent.password;
    this.hostname = parent.hostname;
    this.port = parent.port;
    const [rest, hash = ""] = splitOnce(text, "#");
    const [path, query] = splitOnce(rest, "?");
    this.hash = hash ? `#${hash}` : "";
    if (!path) {
      this.pathname = parent.pathname;
      this.query = query !== undefined ? `?${query}` : parent.search;
    } else {
      this.pathname = normalizePath(path.startsWith("/") ? path : parent.pathname.replace(/[^/]*$/, "") + path);
      this.query = query !== undefined ? `?${query}` : "";
    }
  }

  private parse(protocol: string, rest: string): void {
    this.protocol = protocol;
    const [beforeHash, hash] = splitOnce(rest, "#");
    this.hash = hash ? `#${hash}` : "";
    const [beforeQuery, query] = splitOnce(beforeHash, "?");
    this.query = query ? `?${query}` : "";
    const special = protocol in DEFAULT_PORTS || protocol === "file:";
    const authority = special ? /^[/\\]*([^/\\]*)(.*)$/s.exec(beforeQuery) : /^\/\/([^/]*)(.*)$/s.exec(beforeQuery);
    if (!authority) {
      this.pathname = beforeQuery;
      return;
    }
    let host = authority[1]!;
    const at = host.lastIndexOf("@");
    if (at >= 0) {
      const [user, password = ""] = splitOnce(host.slice(0, at), ":");
      this.username = user;
      this.password = password;
      host = host.slice(at + 1);
    }
    const port = /^(.*?)(?::(\d*))?$/.exec(host)!;
    this.hostname = port[1]!.toLowerCase();
    this.port = port[2] && port[2] !== DEFAULT_PORTS[protocol] ? port[2] : "";
    if (special && !this.hostname && protocol !== "file:") throw new TypeError(`Invalid URL: ${protocol}${rest}`);
    this.pathname = special ? normalizePath(authority[2]!.replace(/\\/g, "/") || "/") : authority[2]!;
  }

  get host(): string { return this.port ? `${this.hostname}:${this.port}` : this.hostname; }
  set host(value: string) { const [name, port = ""] = splitOnce(value, ":"); this.hostname = name; this.port = port; }
  get origin(): string { return this.protocol in DEFAULT_PORTS ? `${this.protocol}//${this.host}` : "null"; }
  get search(): string { return this.params ? (this.params.size ? `?${this.params}` : "") : this.query === "?" ? "" : this.query; }
  set search(value: string) { this.query = value ? (value.startsWith("?") ? value : `?${value}`) : ""; this.params = undefined; }
  get searchParams(): URLSearchParams { return this.params ??= new URLSearchParams(this.query); }
  get href(): string {
    const credentials = this.username ? `${this.username}${this.password ? `:${this.password}` : ""}@` : "";
    const authority = this.hostname || this.protocol === "file:" || this.protocol in DEFAULT_PORTS ? `//${credentials}${this.host}` : "";
    return `${this.protocol}${authority}${this.pathname}${this.search}${this.hash}`;
  }
  toString(): string { return this.href; }
  toJSON(): string { return this.href; }
  static canParse(input: string, base?: string): boolean { try { new URL(input, base); return true; } catch { return false; } }
}
function splitOnce(text: string, separator: string): [string, string | undefined] {
  const index = text.indexOf(separator);
  return index < 0 ? [text, undefined] as [string, undefined] : [text.slice(0, index), text.slice(index + 1)];
}
globals.URL ??= URL;
globals.URLSearchParams ??= URLSearchParams;

// AbortController, Event and EventTarget: the parts fetch and timers use.
class TarveEvent {
  defaultPrevented = false;
  constructor(readonly type: string, readonly init: { cancelable?: boolean } = {}) {}
  preventDefault(): void { if (this.init.cancelable) this.defaultPrevented = true; }
  stopPropagation(): void {}
  stopImmediatePropagation(): void {}
}
class TarveEventTarget {
  private readonly listeners = new Map<string, Set<(event: TarveEvent) => void>>();
  addEventListener(type: string, listener: (event: TarveEvent) => void): void {
    if (!this.listeners.has(type)) this.listeners.set(type, new Set());
    this.listeners.get(type)!.add(listener);
  }
  removeEventListener(type: string, listener: (event: TarveEvent) => void): void { this.listeners.get(type)?.delete(listener); }
  dispatchEvent(event: TarveEvent): boolean {
    const handler = (this as Record<string, unknown>)[`on${event.type}`];
    if (typeof handler === "function") handler.call(this, event);
    for (const listener of [...this.listeners.get(event.type) ?? []]) listener.call(this, event);
    return !event.defaultPrevented;
  }
}
class AbortSignal extends TarveEventTarget {
  aborted = false;
  reason: unknown = undefined;
  throwIfAborted(): void { if (this.aborted) throw this.reason; }
  static abort(reason?: unknown): AbortSignal { const controller = new AbortController(); controller.abort(reason); return controller.signal; }
  static timeout(ms: number): AbortSignal {
    const controller = new AbortController();
    globals.setTimeout(() => controller.abort(Object.assign(new Error("The operation timed out."), { name: "TimeoutError" })), ms);
    return controller.signal;
  }
}
class AbortController {
  readonly signal = new AbortSignal();
  abort(reason: unknown = Object.assign(new Error("This operation was aborted"), { name: "AbortError" })): void {
    if (this.signal.aborted) return;
    this.signal.aborted = true;
    this.signal.reason = reason;
    this.signal.dispatchEvent(new TarveEvent("abort"));
  }
}
globals.Event ??= TarveEvent;
globals.EventTarget ??= TarveEventTarget;
globals.AbortSignal ??= AbortSignal;
globals.AbortController ??= AbortController;


// Node's process and Buffer.
const env = host.env();
const arch = host.arch === "aarch64" ? "arm64" : host.arch === "x86_64" ? "x64" : host.arch;
const stdout = { isTTY: false, write: (chunk: unknown) => { host.log(0, String(chunk).replace(/\n$/, "")); return true; } };
const stderr = { isTTY: false, write: (chunk: unknown) => { host.log(2, String(chunk).replace(/\n$/, "")); return true; } };
globals.process = {
  platform: "android",
  arch,
  env,
  argv: [`${host.filesDir}/app`, `${host.filesDir}/app.js`],
  argv0: "app",
  execArgv: [],
  execPath: `${host.filesDir}/app`,
  pid: 0,
  ppid: 0,
  title: "tarve",
  version: "v0.0.0",
  versions: { tarve_android: "1", quickjs: "ng" },
  release: { name: "tarve-android" },
  exitCode: undefined as number | undefined,
  stdout,
  stderr,
  exit(code?: number): never { return host.exit(code ?? this.exitCode ?? 0); },
  cwd: () => host.filesDir,
  chdir: () => undefined,
  uptime: () => host.now() / 1000,
  hrtime: Object.assign((previous?: [number, number]) => {
    const now = host.now();
    const seconds = Math.floor(now / 1000);
    const nanoseconds = Math.floor((now % 1000) * 1e6);
    if (!previous) return [seconds, nanoseconds];
    let [s, n] = [seconds - previous[0], nanoseconds - previous[1]];
    if (n < 0) { s -= 1; n += 1e9; }
    return [s, n];
  }, { bigint: () => BigInt(Math.floor(host.now() * 1e6)) }),
  memoryUsage: Object.assign(() => ({ rss: 0, heapTotal: 0, heapUsed: 0, external: 0, arrayBuffers: 0 }), { rss: () => 0 }),
  nextTick: (callback: (...args: unknown[]) => void, ...args: unknown[]) => globals.queueMicrotask(() => callback(...args)),
  emitWarning: (warning: unknown) => host.log(1, show(warning)),
  on() { return this; },
  once() { return this; },
  off() { return this; },
  addListener() { return this; },
  removeListener() { return this; },
  removeAllListeners() { return this; },
  emit() { return false; },
  listenerCount() { return 0; },
};
