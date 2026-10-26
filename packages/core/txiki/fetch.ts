/**
 * fetch for txiki.js with Node and Bun semantics. txiki.js's own fetch is a browser
 * XMLHttpRequest over libwebsockets: it always adds its own Origin, Pragma and
 * Cache-Control headers (servers like Google's reject a request whose Origin the app
 * set too) and offers no streaming. This client speaks HTTP/1.1 over tjs.connect
 * ("tcp" / "tls"): exactly the headers the app sets, redirects, gzip/deflate, chunked
 * bodies streamed as they arrive, and AbortSignal. Other schemes use txiki's fetch.
 */
const encoder = new TextEncoder();
const decoder = new TextDecoder();
const MAX_REDIRECTS = 20;

interface Connection {
  readable: ReadableStream<Uint8Array>;
  writable: WritableStream<Uint8Array>;
  close(): void;
}

/** `track` gets the socket's closer as soon as it exists, before it connects (an abort must reach it then). */
async function open(url: URL, track: (close: () => void) => void): Promise<Connection> {
  const secure = url.protocol === "https:";
  const port = Number(url.port || (secure ? 443 : 80));
  const host = url.hostname.replace(/^\[|\]$/g, "");
  const socket = await (tjs as unknown as { connect(transport: string, host: string, port: number): Promise<{ opened: Promise<{ readable: ReadableStream<Uint8Array>; writable: WritableStream<Uint8Array> }>; close(): void }> })
    .connect(secure ? "tls" : "tcp", host, port);
  const close = () => { try { socket.close(); } catch { /* closed */ } };
  track(close);
  const { readable, writable } = await socket.opened;
  return { readable, writable, close };
}

async function bodyBytes(body: unknown): Promise<Uint8Array | undefined> {
  if (body == null) return undefined;
  if (typeof body === "string") return encoder.encode(body);
  if (body instanceof Uint8Array) return body;
  if (body instanceof ArrayBuffer) return new Uint8Array(body);
  if (ArrayBuffer.isView(body)) return new Uint8Array(body.buffer, body.byteOffset, body.byteLength);
  if (body instanceof URLSearchParams) return encoder.encode(body.toString());
  // Blob, FormData, ReadableStream: let Response serialize it (FormData gets its boundary type).
  return new Uint8Array(await new Response(body as BodyInit).arrayBuffer());
}

function defaultContentType(body: unknown): string | undefined {
  if (typeof body === "string") return "text/plain;charset=UTF-8";
  if (body instanceof URLSearchParams) return "application/x-www-form-urlencoded;charset=UTF-8";
  if (typeof FormData !== "undefined" && body instanceof FormData) return new Response(body).headers.get("content-type") ?? undefined;
  if (typeof Blob !== "undefined" && body instanceof Blob && body.type) return body.type;
  return undefined;
}

/** Buffered reads over the socket: the head line by line, the body by length. */
class Reader {
  private buffer = new Uint8Array(0);
  private done = false;
  constructor(private readonly reader: ReadableStreamDefaultReader<Uint8Array>) {}

  private async fill(): Promise<boolean> {
    if (this.done) return false;
    const { done, value } = await this.reader.read();
    if (done || !value) { this.done = true; return false; }
    const next = new Uint8Array(this.buffer.length + value.length);
    next.set(this.buffer);
    next.set(value, this.buffer.length);
    this.buffer = next;
    return true;
  }

  async line(): Promise<string | undefined> {
    for (;;) {
      const at = this.buffer.indexOf(10);
      if (at >= 0) {
        const line = decoder.decode(this.buffer.subarray(0, at)).replace(/\r$/, "");
        this.buffer = this.buffer.subarray(at + 1);
        return line;
      }
      if (!await this.fill()) return undefined;
    }
  }

  /** Up to `max` bytes; undefined at end of stream. */
  async chunk(max = Infinity): Promise<Uint8Array | undefined> {
    if (!this.buffer.length && !await this.fill()) return undefined;
    const size = Math.min(max, this.buffer.length);
    const out = this.buffer.subarray(0, size);
    this.buffer = this.buffer.subarray(size);
    return out;
  }

  cancel(): void {
    this.reader.cancel().catch(() => {});
  }
}

function abortError(signal: AbortSignal | null | undefined): unknown {
  return signal?.reason ?? new DOMException("The operation was aborted.", "AbortError");
}

async function request(url: URL, method: string, headers: Headers, body: Uint8Array | undefined, signal: AbortSignal | null | undefined): Promise<Response> {
  if (signal?.aborted) throw abortError(signal);
  // Closing the socket does not settle a pending read: race every wait against the abort.
  let closeSocket: (() => void) | undefined;
  const onAbort = () => closeSocket?.();
  let rejectAbort = () => {};
  const abortion = signal ? new Promise<never>((_, reject) => { rejectAbort = () => reject(abortError(signal)); signal.addEventListener("abort", rejectAbort, { once: true }); }) : undefined;
  abortion?.catch(() => {});
  const race = <T>(promise: Promise<T>): Promise<T> => abortion ? Promise.race([promise, abortion]) : promise;
  signal?.addEventListener("abort", onAbort, { once: true });
  try {
    // A socket that only appears after an abort (still connecting) is closed then.
    const socket = await race(open(url, close => { closeSocket = close; if (signal?.aborted) close(); }));
    const lines = [`${method} ${url.pathname || "/"}${url.search} HTTP/1.1`];
    if (!headers.has("host")) lines.push(`host: ${url.host}`);
    if (!headers.has("accept")) lines.push("accept: */*");
    if (!headers.has("accept-encoding")) lines.push("accept-encoding: gzip, deflate");
    if (!headers.has("user-agent")) lines.push(`user-agent: tarve (txiki.js ${tjs.version})`);
    lines.push("connection: close");
    headers.forEach((value, name) => { if (name !== "connection" && name !== "content-length") lines.push(`${name}: ${value}`); });
    if (body || method === "POST" || method === "PUT" || method === "PATCH") lines.push(`content-length: ${body?.length ?? 0}`);
    const writer = socket.writable.getWriter();
    await race(writer.write(encoder.encode(lines.join("\r\n") + "\r\n\r\n")));
    if (body?.length) await race(writer.write(body));
    writer.releaseLock();

    const reader = new Reader(socket.readable.getReader());
    let status = 0, statusText = "";
    const responseHeaders = new Headers();
    // Skip interim 1xx responses (100 Continue).
    do {
      const statusLine = await race(reader.line());
      if (statusLine === undefined) throw new TypeError(`fetch failed: ${url.host} closed the connection`);
      const match = /^HTTP\/\d(?:\.\d)? (\d{3}) ?(.*)$/.exec(statusLine);
      if (!match) throw new TypeError(`fetch failed: malformed response from ${url.host}`);
      status = Number(match[1]);
      statusText = match[2]!;
      for (;;) {
        const line = await race(reader.line());
        if (line === undefined || line === "") break;
        const colon = line.indexOf(":");
        if (colon > 0 && status >= 200) responseHeaders.append(line.slice(0, colon).trim(), line.slice(colon + 1).trim());
      }
    } while (status < 200);

    const empty = method === "HEAD" || status === 204 || status === 304;
    const chunked = /\bchunked\b/i.test(responseHeaders.get("transfer-encoding") ?? "");
    // A missing or malformed Content-Length reads to the end of the connection.
    const declared = Number(responseHeaders.get("content-length") ?? NaN);
    let remaining = empty ? 0 : !chunked && Number.isSafeInteger(declared) && declared >= 0 ? declared : Infinity;
    let chunkLeft = 0, finished = empty;
    const finish = () => { finished = true; signal?.removeEventListener("abort", onAbort); signal?.removeEventListener("abort", rejectAbort); reader.cancel(); socket.close(); };
    let stream: ReadableStream<Uint8Array> = new ReadableStream<Uint8Array>({
      async pull(controller) {
        try {
          if (finished) { controller.close(); return; }
          if (chunked) {
            if (chunkLeft === 0) {
              const size = parseInt((await race(reader.line())) ?? "0", 16);
              if (!size) { finish(); controller.close(); return; }
              chunkLeft = size;
            }
            const data = await race(reader.chunk(chunkLeft));
            if (!data) throw new TypeError("fetch failed: connection closed inside a chunk");
            chunkLeft -= data.length;
            if (chunkLeft === 0) await race(reader.line());
            controller.enqueue(data.slice());
            return;
          }
          if (remaining <= 0) { finish(); controller.close(); return; }
          const data = await race(reader.chunk(remaining));
          if (!data) {
            if (remaining !== Infinity) throw new TypeError("fetch failed: connection closed before the body ended");
            finish(); controller.close(); return;
          }
          remaining -= data.length;
          controller.enqueue(data.slice());
        } catch (error) {
          finish();
          controller.error(signal?.aborted ? abortError(signal) : error);
        }
      },
      cancel() { finish(); },
    });
    if (empty) finish();
    const encoding = (responseHeaders.get("content-encoding") ?? "").toLowerCase();
    if (!empty && (encoding === "gzip" || encoding === "deflate" || encoding === "x-gzip")) {
      stream = stream.pipeThrough(new DecompressionStream(encoding === "deflate" ? "deflate" : "gzip") as unknown as ReadableWritablePair<Uint8Array, Uint8Array>);
    }
    const response = new Response(empty || status === 101 ? null : stream, { status: status === 101 ? 200 : status, statusText, headers: responseHeaders });
    Object.defineProperty(response, "url", { value: url.href });
    return response;
  } catch (error) {
    signal?.removeEventListener("abort", onAbort);
    signal?.removeEventListener("abort", rejectAbort);
    closeSocket?.();
    throw signal?.aborted ? abortError(signal) : error;
  }
}

export function createFetch(fallback: typeof fetch): typeof fetch {
  return (async (input: RequestInfo | URL, init: RequestInit = {}) => {
    const source = typeof input === "object" && !(input instanceof URL) ? input as Request : undefined;
    let url = new URL(source ? source.url : String(input));
    if (url.protocol !== "http:" && url.protocol !== "https:") return fallback(input, init);
    let method = (init.method ?? source?.method ?? "GET").toUpperCase();
    const headers = new Headers(init.headers ?? source?.headers);
    const rawBody = init.body !== undefined ? init.body : source && method !== "GET" && method !== "HEAD" ? await source.arrayBuffer() : undefined;
    const type = defaultContentType(rawBody);
    if (type && !headers.has("content-type")) headers.set("content-type", type);
    let body = await bodyBytes(rawBody);
    const signal = init.signal ?? source?.signal;
    const redirect = init.redirect ?? source?.redirect ?? "follow";
    for (let redirects = 0; ; redirects++) {
      const response = await request(url, method, headers, body, signal);
      const location = response.headers.get("location");
      if (redirect === "manual" || response.status < 300 || response.status > 399 || response.status === 304 || !location) {
        if (redirects) Object.defineProperty(response, "redirected", { value: true });
        return response;
      }
      if (redirect === "error") throw new TypeError(`fetch failed: redirect to ${location}`);
      if (redirects >= MAX_REDIRECTS) throw new TypeError("fetch failed: too many redirects");
      await response.body?.cancel();
      const next = new URL(location, url);
      if (response.status === 303 || ((response.status === 301 || response.status === 302) && method === "POST")) {
        method = "GET";
        body = undefined;
        headers.delete("content-type");
      }
      // Credentials stay with their origin, as in browsers and Node.
      if (next.origin !== url.origin) { headers.delete("authorization"); headers.delete("cookie"); }
      url = next;
    }
  }) as typeof fetch;
}
