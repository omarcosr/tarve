/** node:crypto on Android: hashes, HMAC and random bytes from the host. */
import { Buffer } from "../../txiki/shims/buffer";
import { host } from "../host";

const encoder = new TextEncoder();
const BLOCK: Record<string, number> = { md5: 64, sha1: 64, sha224: 64, sha256: 64, sha384: 128, sha512: 128 };

function toBytes(data: string | ArrayBufferView, encoding?: BufferEncoding): Uint8Array {
  if (typeof data === "string") return encoding && encoding !== "utf8" && encoding !== "utf-8" ? Buffer.from(data, encoding as "hex") : encoder.encode(data);
  return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
}

function concat(chunks: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(chunks.reduce((size, chunk) => size + chunk.length, 0));
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.length;
  }
  return out;
}

function output(bytes: Uint8Array, encoding?: string): any {
  const buffer = Buffer.fromValue(bytes);
  return encoding ? buffer.toString(encoding as "hex") : buffer;
}

function algorithmOf(name: string): string {
  const algorithm = name.toLowerCase().replace(/-/g, "");
  if (!(algorithm in BLOCK)) throw new Error(`Digest method not supported: ${name}`);
  return algorithm;
}

class Hash {
  private readonly chunks: Uint8Array[] = [];
  constructor(private readonly algorithm: string) {}
  update(data: string | ArrayBufferView, encoding?: BufferEncoding): this {
    this.chunks.push(toBytes(data, encoding).slice());
    return this;
  }
  digest(encoding?: "hex" | "base64" | "base64url" | "latin1"): any {
    return output(host.hash(this.algorithm, concat(this.chunks)), encoding);
  }
  copy(): Hash {
    const copy = new Hash(this.algorithm);
    copy.chunks.push(...this.chunks);
    return copy;
  }
}

export function createHash(algorithm: string): Hash {
  return new Hash(algorithmOf(algorithm));
}

class Hmac {
  private readonly inner: Uint8Array[] = [];
  private readonly key: Uint8Array;
  constructor(private readonly algorithm: string, key: string | ArrayBufferView) {
    const block = BLOCK[algorithm]!;
    let bytes = toBytes(key);
    if (bytes.length > block) bytes = host.hash(algorithm, bytes);
    this.key = new Uint8Array(block);
    this.key.set(bytes);
    this.inner.push(this.key.map(byte => byte ^ 0x36));
  }
  update(data: string | ArrayBufferView, encoding?: BufferEncoding): this {
    this.inner.push(toBytes(data, encoding).slice());
    return this;
  }
  digest(encoding?: "hex" | "base64" | "base64url" | "latin1"): any {
    const inner = host.hash(this.algorithm, concat(this.inner));
    return output(host.hash(this.algorithm, concat([this.key.map(byte => byte ^ 0x5c), inner])), encoding);
  }
}

export function createHmac(algorithm: string, key: string | ArrayBufferView): Hmac {
  return new Hmac(algorithmOf(algorithm), key);
}

export function getHashes(): string[] {
  return Object.keys(BLOCK);
}

export function randomUUID(): string {
  return crypto.randomUUID();
}

export function randomBytes(size: number): Buffer {
  return Buffer.fromValue(host.random(size));
}

export function randomInt(min: number, max?: number): number {
  const [low, high] = max === undefined ? [0, min] : [min, max];
  const bytes = host.random(6);
  const value = bytes.reduce((total, byte) => total * 256 + byte, 0) / 2 ** 48;
  return low + Math.floor(value * (high - low));
}

export function getRandomValues<T extends ArrayBufferView>(array: T): T {
  return crypto.getRandomValues(array);
}

export function timingSafeEqual(a: ArrayBufferView, b: ArrayBufferView): boolean {
  const left = toBytes(a);
  const right = toBytes(b);
  if (left.length !== right.length) throw new RangeError("Input buffers must have the same byte length");
  let difference = 0;
  for (let index = 0; index < left.length; index++) difference |= left[index]! ^ right[index]!;
  return difference === 0;
}

export default { createHash, createHmac, getHashes, getRandomValues, randomBytes, randomInt, randomUUID, timingSafeEqual };
