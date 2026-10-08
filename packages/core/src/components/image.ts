import { createHash } from "node:crypto";
import type { NativeImageSource } from "../../../protocol/src/index";
import { jsx, type BaseProps, type VNode } from "../jsx-runtime";
import { theme } from "../theme";

const MAX_ENCODED_IMAGE_BYTES = 64 * 1024 * 1024;
const HTTP_IMAGE_CACHE_BYTES = 64 * 1024 * 1024;
const MAX_IMAGE_DIMENSION = 16_384;

export interface ImageBytesSource {
  /** Encoded PNG, JPEG, WebP or SVG bytes. */
  bytes: Uint8Array;
  mediaType?: string;
  /** Stable key can reduce GPU cache churn when pixels are updated in place. */
  cacheKey?: string;
}

export interface ImageRgbaSource {
  /** Raw RGBA8 pixels in row-major order. */
  rgba: Uint8Array;
  width: number;
  height: number;
  premultiplied?: boolean;
  cacheKey?: string;
}

export type ImageSource = string | Uint8Array | ImageBytesSource | ImageRgbaSource;

export interface ImageProps extends BaseProps {
  /** Local path, data URL, encoded bytes, or raw RGBA8 pixels. */
  src: ImageSource;
  width?: number;
  height?: number;
  /** CSS `object-fit`. */
  fit?: "cover" | "contain" | "fill";
}

export type ImageHttpCacheMode = "default" | "reload" | "no-store";

export interface LoadImageSourceOptions {
  signal?: AbortSignal;
  cache?: ImageHttpCacheMode;
  /** Maximum encoded response size. Defaults to 64 MiB. */
  maxBytes?: number;
}

interface HttpCacheEntry {
  source: ImageBytesSource;
  size: number;
}

const httpImageCache = new Map<string, HttpCacheEntry>();
let httpImageCacheBytes = 0;

function validateEncodedBytes(bytes: Uint8Array): void {
  if (!(bytes instanceof Uint8Array)) throw new TypeError("Image bytes must be a Uint8Array");
  if (bytes.byteLength === 0) throw new RangeError("Image bytes must not be empty");
  if (bytes.byteLength > MAX_ENCODED_IMAGE_BYTES) {
    throw new RangeError(`Image bytes exceed the ${MAX_ENCODED_IMAGE_BYTES} byte limit`);
  }
}

function validateRgba(source: ImageRgbaSource): void {
  const { width, height, rgba } = source;
  if (!Number.isInteger(width) || !Number.isInteger(height) || width <= 0 || height <= 0
    || width > MAX_IMAGE_DIMENSION || height > MAX_IMAGE_DIMENSION) {
    throw new RangeError(`RGBA image dimensions must be positive integers up to ${MAX_IMAGE_DIMENSION}`);
  }
  const expected = width * height * 4;
  if (!Number.isSafeInteger(expected) || expected > MAX_ENCODED_IMAGE_BYTES) {
    throw new RangeError(`RGBA image exceeds the ${MAX_ENCODED_IMAGE_BYTES} byte limit`);
  }
  if (!(rgba instanceof Uint8Array) || rgba.byteLength !== expected) {
    throw new RangeError(`RGBA image requires exactly ${expected} bytes for ${width}x${height}`);
  }
}

function contentKey(prefix: string, bytes: Uint8Array, suffix = ""): string {
  const digest = createHash("sha256").update(bytes).digest("hex").slice(0, 32);
  return `${prefix}:${digest}${suffix}`;
}

function base64(bytes: Uint8Array): string {
  return Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).toString("base64");
}

function percentDecodedBytes(value: string): Uint8Array {
  const bytes: number[] = [];
  const encoder = new TextEncoder();
  for (let index = 0; index < value.length;) {
    if (value[index] === "%" && /^[0-9a-f]{2}$/i.test(value.slice(index + 1, index + 3))) {
      bytes.push(Number.parseInt(value.slice(index + 1, index + 3), 16));
      index += 3;
      continue;
    }
    const point = value.codePointAt(index)!;
    const character = String.fromCodePoint(point);
    bytes.push(...encoder.encode(character));
    index += character.length;
  }
  return Uint8Array.from(bytes);
}

function dataUrlSource(value: string): ImageBytesSource {
  const comma = value.indexOf(",");
  if (comma < 5) throw new TypeError("Invalid image data URL");
  const metadata = value.slice(5, comma);
  const payload = value.slice(comma + 1);
  const parts = metadata.split(";");
  const mediaType = parts[0] || undefined;
  const isBase64 = parts.some(part => part.toLowerCase() === "base64");
  let bytes: Uint8Array;
  try {
    bytes = isBase64
      ? new Uint8Array(Buffer.from(payload.replace(/\s/g, ""), "base64"))
      : percentDecodedBytes(payload);
  } catch (error) {
    throw new TypeError(`Invalid image data URL: ${error instanceof Error ? error.message : String(error)}`);
  }
  validateEncodedBytes(bytes);
  return { bytes, ...(mediaType ? { mediaType } : {}) };
}

export type SerializedImageSource = { path: string } | { image: NativeImageSource };

/** Protocol normalization shared by Image and intrinsic img reconciliation. */
/** Serialized byte sources, so re-mounting the same image does not base64 it again. */
const serializedSources = new WeakMap<object, SerializedImageSource>();

export function serializeImageSource(source: ImageSource): SerializedImageSource {
  if (typeof source === "object" && !(source instanceof Uint8Array)) {
    const cached = serializedSources.get(source);
    if (cached) return cached;
    const serialized = serializeImageSourceNow(source);
    serializedSources.set(source, serialized);
    return serialized;
  }
  return serializeImageSourceNow(source);
}

function serializeImageSourceNow(source: ImageSource): SerializedImageSource {
  if (typeof source === "string") {
    if (source.startsWith("data:")) return serializeImageSourceNow(dataUrlSource(source));
    if (/^https?:\/\//i.test(source)) {
      throw new TypeError("HTTP(S) Image sources must be loaded with await loadImageSource(url) before rendering");
    }
    if (!source) throw new TypeError("Image src must not be empty");
    return { path: source };
  }
  if (source instanceof Uint8Array) source = { bytes: source };
  if ("rgba" in source) {
    validateRgba(source);
    const key = source.cacheKey ?? contentKey("rgba", source.rgba, `:${source.width}x${source.height}:${source.premultiplied ? "p" : "s"}`);
    return {
      image: {
        kind: "rgba",
        key,
        data: base64(source.rgba),
        width: source.width,
        height: source.height,
        ...(source.premultiplied ? { premultiplied: true } : {}),
      },
    };
  }
  validateEncodedBytes(source.bytes);
  const key = source.cacheKey ?? contentKey("encoded", source.bytes, source.mediaType ? `:${source.mediaType}` : "");
  return {
    image: {
      kind: "encoded",
      key,
      data: base64(source.bytes),
      ...(source.mediaType ? { mediaType: source.mediaType } : {}),
    },
  };
}

function cachedHttpSource(url: string): ImageBytesSource | undefined {
  const entry = httpImageCache.get(url);
  if (!entry) return undefined;
  httpImageCache.delete(url);
  httpImageCache.set(url, entry);
  return { ...entry.source, bytes: entry.source.bytes.slice() };
}

function rememberHttpSource(url: string, source: ImageBytesSource): void {
  const old = httpImageCache.get(url);
  if (old) httpImageCacheBytes -= old.size;
  const stored = { ...source, bytes: source.bytes.slice() };
  httpImageCache.delete(url);
  httpImageCache.set(url, { source: stored, size: stored.bytes.byteLength });
  httpImageCacheBytes += stored.bytes.byteLength;
  while (httpImageCacheBytes > HTTP_IMAGE_CACHE_BYTES && httpImageCache.size > 0) {
    const oldest = httpImageCache.keys().next().value as string | undefined;
    if (oldest === undefined) break;
    const removed = httpImageCache.get(oldest)!;
    httpImageCache.delete(oldest);
    httpImageCacheBytes -= removed.size;
  }
}

async function responseBytes(response: Response, maxBytes: number): Promise<Uint8Array> {
  const declared = Number(response.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > maxBytes) {
    throw new RangeError(`Remote image exceeds the ${maxBytes} byte response limit`);
  }
  if (!response.body) {
    const bytes = new Uint8Array(await response.arrayBuffer());
    if (bytes.byteLength > maxBytes) throw new RangeError(`Remote image exceeds the ${maxBytes} byte response limit`);
    return bytes;
  }
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel("image response limit exceeded");
        throw new RangeError(`Remote image exceeds the ${maxBytes} byte response limit`);
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

/** Fetch an HTTP(S) image with AbortSignal support and a bounded 64 MiB in-process LRU. */
export async function loadImageSource(url: string | URL, options: LoadImageSourceOptions = {}): Promise<ImageBytesSource> {
  const href = String(url);
  const parsed = new URL(href);
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new TypeError("loadImageSource supports only HTTP(S) URLs");
  }
  const cache = options.cache ?? "default";
  if (cache !== "default" && cache !== "reload" && cache !== "no-store") throw new TypeError(`Unsupported image cache mode: ${cache}`);
  const maxBytes = options.maxBytes ?? MAX_ENCODED_IMAGE_BYTES;
  if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0 || maxBytes > MAX_ENCODED_IMAGE_BYTES) {
    throw new RangeError(`maxBytes must be an integer from 1 to ${MAX_ENCODED_IMAGE_BYTES}`);
  }
  if (cache === "default") {
    const cached = cachedHttpSource(href);
    if (cached) {
      if (cached.bytes.byteLength > maxBytes) {
        throw new RangeError(`Remote image exceeds the ${maxBytes} byte response limit`);
      }
      return cached;
    }
  }
  const response = await fetch(href, { signal: options.signal });
  if (!response.ok) throw new Error(`Image request failed with HTTP ${response.status} ${response.statusText}`.trim());
  const bytes = await responseBytes(response, maxBytes);
  validateEncodedBytes(bytes);
  const mediaType = response.headers.get("content-type")?.split(";", 1)[0]?.trim() || undefined;
  const source: ImageBytesSource = {
    bytes,
    cacheKey: `http:${href}`,
    ...(mediaType ? { mediaType } : {}),
  };
  if (cache !== "no-store") rememberHttpSource(href, source);
  return { ...source, bytes: source.bytes.slice() };
}

export function clearImageSourceCache(): void {
  httpImageCache.clear();
  httpImageCacheBytes = 0;
}

export function Image({ width, height, style, ...props }: ImageProps): VNode {
  return jsx("image", {
    ...props,
    style: {
      width,
      height,
      radius: theme.radius.md,
      placeholderBackground: theme.colors.imagePlaceholder,
      ...style,
    },
  });
}
