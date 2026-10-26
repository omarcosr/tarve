/**
 * fetch, Headers, Request and Response for a Tarve Android app: each request runs on a
 * native thread (ureq over rustls, native/src/android/qjs/fetch.rs) and the app loop
 * settles it through __tarveFetchDone. Bodies are read whole (no streams).
 */
import { host } from "./host";

export {};

const globals = globalThis as Record<string, any>;

function bytesOf(input: ArrayBuffer | ArrayBufferView): Uint8Array {
  if (input instanceof Uint8Array) return input;
  if (ArrayBuffer.isView(input)) return new Uint8Array(input.buffer, input.byteOffset, input.byteLength);
  return new Uint8Array(input);
}

type HeadersInit = Headers | Record<string, string> | [string, string][];
class Headers {
  private readonly map = new Map<string, string>();
  constructor(init?: HeadersInit) {
    if (!init) return;
    const entries = init instanceof Headers ? [...init] : Array.isArray(init) ? init : Object.entries(init);
    for (const [name, value] of entries) this.append(name, value);
  }
  append(name: string, value: string): void {
    const key = name.toLowerCase();
    const existing = this.map.get(key);
    this.map.set(key, existing === undefined ? String(value) : `${existing}, ${value}`);
  }
  set(name: string, value: string): void { this.map.set(name.toLowerCase(), String(value)); }
  get(name: string): string | null { return this.map.get(name.toLowerCase()) ?? null; }
  has(name: string): boolean { return this.map.has(name.toLowerCase()); }
  delete(name: string): void { this.map.delete(name.toLowerCase()); }
  forEach(callback: (value: string, name: string, headers: this) => void): void { for (const [name, value] of this.map) callback(value, name, this); }
  entries(): IterableIterator<[string, string]> { return this.map.entries(); }
  keys(): IterableIterator<string> { return this.map.keys(); }
  values(): IterableIterator<string> { return this.map.values(); }
  [Symbol.iterator](): IterableIterator<[string, string]> { return this.map.entries(); }
}
type BodyInit = string | ArrayBuffer | ArrayBufferView | URLSearchParams | null | undefined;
function bodyBytes(body: BodyInit): Uint8Array | undefined {
  if (body == null) return undefined;
  if (typeof body === "string" || body instanceof URLSearchParams) return host.encode(String(body));
  return bytesOf(body as ArrayBuffer | ArrayBufferView);
}
class Response {
  readonly headers: Headers;
  readonly status: number;
  readonly statusText: string;
  readonly url: string;
  readonly type = "basic";
  readonly redirected = false;
  private data: Uint8Array;
  bodyUsed = false;
  constructor(body?: BodyInit, init: { status?: number; statusText?: string; headers?: HeadersInit; url?: string } = {}) {
    this.data = bodyBytes(body) ?? new Uint8Array(0);
    this.status = init.status ?? 200;
    this.statusText = init.statusText ?? "";
    this.headers = new Headers(init.headers);
    this.url = init.url ?? "";
  }
  get ok(): boolean { return this.status >= 200 && this.status < 300; }
  private consume(): Uint8Array {
    if (this.bodyUsed) throw new TypeError("Body is unusable: Body has already been read");
    this.bodyUsed = true;
    return this.data;
  }
  async arrayBuffer(): Promise<ArrayBuffer> { const bytes = this.consume(); return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer; }
  async bytes(): Promise<Uint8Array> { return new Uint8Array(this.consume()); }
  async text(): Promise<string> { return host.decode(this.consume()); }
  async json(): Promise<unknown> { return JSON.parse(await this.text()); }
  clone(): Response { return new Response(this.data, { status: this.status, statusText: this.statusText, headers: this.headers, url: this.url }); }
  static json(data: unknown, init?: { status?: number; headers?: HeadersInit }): Response {
    const headers = new Headers(init?.headers);
    if (!headers.has("content-type")) headers.set("content-type", "application/json");
    return new Response(JSON.stringify(data), { ...init, headers });
  }
}
class Request {
  readonly method: string;
  readonly headers: Headers;
  readonly body: BodyInit;
  readonly signal?: AbortSignal;
  readonly url: string;
  constructor(input: string | URL | Request, init: { method?: string; headers?: HeadersInit; body?: BodyInit; signal?: AbortSignal } = {}) {
    const from = input instanceof Request ? input : undefined;
    this.url = from ? from.url : String(input);
    this.method = (init.method ?? from?.method ?? "GET").toUpperCase();
    this.headers = new Headers(init.headers ?? from?.headers);
    this.body = init.body ?? from?.body;
    this.signal = init.signal ?? from?.signal;
  }
}
const requests = new Map<number, { resolve(response: Response): void; reject(error: unknown): void; url: string }>();
let nextRequest = 1;
globals.fetch = (input: string | URL | Request, init?: ConstructorParameters<typeof Request>[1]): Promise<Response> => {
  const request = new Request(input, init);
  return new Promise((resolve, reject) => {
    if (request.signal?.aborted) {
      reject(request.signal.reason);
      return;
    }
    const url = new URL(request.url).href;
    const id = nextRequest++;
    requests.set(id, { resolve, reject, url });
    request.signal?.addEventListener("abort", () => {
      if (requests.delete(id)) reject(request.signal!.reason);
    });
    const headers = [...request.headers].flat();
    host.fetch(id, request.method, url, headers, bodyBytes(request.body));
  });
};
globals.__tarveFetchDone = (id: number, status: number, statusText: string, headers: string[], body: Uint8Array | undefined, error: string | undefined) => {
  const request = requests.get(id);
  if (!request) return;
  requests.delete(id);
  if (error !== undefined) {
    request.reject(new TypeError(`fetch failed: ${error}`));
    return;
  }
  const pairs: [string, string][] = [];
  for (let index = 0; index + 1 < headers.length; index += 2) pairs.push([headers[index]!, headers[index + 1]!]);
  request.resolve(new Response(body ?? null, { status, statusText, headers: pairs, url: request.url }));
};
globals.Headers ??= Headers;
globals.Response ??= Response;
globals.Request ??= Request;
