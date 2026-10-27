/**
 * `.tarve` app packs: the app's JavaScript and assets, updated without the runtime around them.
 * The layout follows Electron's app.asar (a header indexing concatenated files, read in place)
 * and adds what asar lacks: an Ed25519 signature over the header, per-file SHA-256, gzip and
 * AES-256-GCM.
 *
 *   "TARVEPAK" | u32 format | u32 header length | header JSON | Ed25519 signature (64) | files
 *
 * The signature covers everything before it; the header carries the SHA-256 of each stored
 * file, so one signature check plus a hash per file read authenticates the whole pack. Only
 * Web APIs (crypto.subtle, CompressionStream): the same code runs on Bun, Node.js and txiki.js.
 */

export const PACK_MAGIC = "TARVEPAK";
export const PACK_FORMAT = 1;
export const PACK_EXTENSION = ".tarve";
const PREFIX = 16;
const SIGNATURE = 64;
const MAX_HEADER = 4 << 20;
const PATH = /^(?!\/)(?!.*(?:^|\/)\.\.?(?:\/|$))[\w@+=,.\- /]+$/;
const encoder = new TextEncoder();
const decoder = new TextDecoder();

/** What a pack needs from the executable that runs it. */
export interface PackRequirements {
  /** Fingerprint of everything the pack's code binds to: Tarve's native ABI, the runtime, the target and plugin libraries. */
  compat: string;
  /** Native subsystems the pack uses; the executable must provide each. */
  features: string[];
}

export interface PackEntry {
  /** Offset of the stored bytes from the start of the file area. */
  offset: number;
  /** Stored (compressed, encrypted) length. */
  size: number;
  /** Original length. */
  length: number;
  /** SHA-256 (hex) of the stored bytes. */
  sha256: string;
  /** AES-GCM nonce (base64). */
  iv: string;
  gzip: boolean;
}

export interface PackHeader {
  name: string;
  version: string;
  runtime: string;
  /** `<os>-<arch>`, as in update manifests. */
  platform: string;
  requires: PackRequirements;
  /** The file holding the app's code. */
  entry: string;
  files: Record<string, PackEntry>;
}

export interface OpenedPack {
  header: PackHeader;
  /** Absolute offset of the file area. */
  base: number;
}

/** Reads `length` bytes at `offset`; throws when the source is shorter. */
export type PackReader = (offset: number, length: number) => Uint8Array;

export interface PackSource {
  path: string;
  data: Uint8Array;
}

function invalid(reason: string): never {
  throw new Error(`Invalid app pack: ${reason}`);
}

function base64(bytes: Uint8Array): string {
  let text = "";
  for (let i = 0; i < bytes.length; i += 0x8000) text += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(text);
}

function fromBase64(text: string): Uint8Array {
  const raw = atob(text);
  const bytes = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) bytes[i] = raw.charCodeAt(i);
  return bytes;
}

function hex(bytes: ArrayBuffer): string {
  return Array.from(new Uint8Array(bytes), byte => byte.toString(16).padStart(2, "0")).join("");
}

function buffer(bytes: Uint8Array): Uint8Array<ArrayBuffer> {
  return bytes as Uint8Array<ArrayBuffer>;
}

async function transform(bytes: Uint8Array, stream: CompressionStream | DecompressionStream): Promise<Uint8Array> {
  return new Uint8Array(await new Response(new Blob([buffer(bytes)]).stream().pipeThrough(stream)).arrayBuffer());
}

export async function sha256Hex(bytes: Uint8Array): Promise<string> {
  return hex(await crypto.subtle.digest("SHA-256", buffer(bytes)));
}

export function isPack(bytes: Uint8Array): boolean {
  return bytes.length >= PACK_MAGIC.length && decoder.decode(bytes.subarray(0, PACK_MAGIC.length)) === PACK_MAGIC;
}

/** The base64 raw Ed25519 public key `tarve keygen` prints, for verifying packs. */
export async function importPackPublicKey(publicKey: string): Promise<CryptoKey> {
  const raw = fromBase64(publicKey.trim());
  if (raw.length !== 32) throw new TypeError("Update public key must be 32 bytes of base64 (tarve keygen)");
  return crypto.subtle.importKey("raw", buffer(raw), { name: "Ed25519" }, false, ["verify"]);
}

/** The base64 AES-256 key a pack's files are encrypted with. */
export async function importPackContentKey(key: string): Promise<CryptoKey> {
  const raw = fromBase64(key);
  if (raw.length !== 32) throw new TypeError("App pack content key must be 32 bytes");
  return crypto.subtle.importKey("raw", buffer(raw), { name: "AES-GCM" }, false, ["encrypt", "decrypt"]);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

/** Checks the shape of a header and that every file lies inside `area` bytes. */
export function validatePackHeader(value: unknown, area: number): PackHeader {
  if (!isRecord(value)) invalid("header is not an object");
  for (const field of ["name", "version", "runtime", "platform", "entry"] as const) {
    if (typeof value[field] !== "string" || !value[field]) invalid(field);
  }
  const requires = value.requires;
  if (!isRecord(requires) || typeof requires.compat !== "string" || !/^[0-9a-f]{64}$/.test(requires.compat)
    || !Array.isArray(requires.features) || !requires.features.every(feature => typeof feature === "string")) invalid("requires");
  if (!isRecord(value.files)) invalid("files");
  const ranges: [number, number][] = [];
  for (const [path, entry] of Object.entries(value.files)) {
    if (!PATH.test(path)) invalid(`file name ${JSON.stringify(path)}`);
    if (!isRecord(entry)) invalid(`files.${path}`);
    const { offset, size, length, sha256, iv, gzip } = entry;
    const integer = (n: unknown) => typeof n === "number" && Number.isSafeInteger(n) && n >= 0;
    if (!integer(offset) || !integer(size) || !integer(length) || (offset as number) + (size as number) > area) invalid(`files.${path} range`);
    if (typeof sha256 !== "string" || !/^[0-9a-f]{64}$/.test(sha256)) invalid(`files.${path}.sha256`);
    if (typeof iv !== "string" || fromBase64(iv).length !== 12) invalid(`files.${path}.iv`);
    if (typeof gzip !== "boolean") invalid(`files.${path}.gzip`);
    ranges.push([offset as number, (offset as number) + (size as number)]);
  }
  ranges.sort((a, b) => a[0] - b[0]);
  for (let i = 1; i < ranges.length; i++) if (ranges[i]![0] < ranges[i - 1]![1]) invalid("overlapping files");
  if (!Object.hasOwn(value.files, value.entry as string)) invalid("entry is not in the pack");
  return value as unknown as PackHeader;
}

interface RawPack {
  signed: Uint8Array;
  signature: Uint8Array;
  header: PackHeader;
  base: number;
}

function parse(read: PackReader, size: number): RawPack {
  if (size < PREFIX + SIGNATURE) invalid("truncated");
  const prefix = read(0, PREFIX);
  if (!isPack(prefix)) invalid("not a .tarve pack");
  const view = new DataView(prefix.buffer, prefix.byteOffset, PREFIX);
  const format = view.getUint32(8, true);
  if (format !== PACK_FORMAT) invalid(`format ${format}; this Tarve reads format ${PACK_FORMAT}`);
  const length = view.getUint32(12, true);
  if (length === 0 || length > MAX_HEADER || PREFIX + length + SIGNATURE > size) invalid("header length");
  const signed = new Uint8Array(PREFIX + length);
  signed.set(prefix);
  signed.set(read(PREFIX, length), PREFIX);
  let json: unknown;
  try {
    json = JSON.parse(decoder.decode(signed.subarray(PREFIX)));
  } catch {
    invalid("header is not JSON");
  }
  const base = PREFIX + length + SIGNATURE;
  return { signed, signature: read(PREFIX + length, SIGNATURE), header: validatePackHeader(json, size - base), base };
}

/** The header without checking its signature: for tooling that verifies it another way. */
export function inspectPack(read: PackReader, size: number): OpenedPack & { signed: Uint8Array; signature: Uint8Array } {
  const { header, base, signed, signature } = parse(read, size);
  return { header, base, signed, signature };
}

/** Parses and authenticates a pack's header. */
export async function openPack(read: PackReader, size: number, publicKey: CryptoKey): Promise<OpenedPack> {
  const { signed, signature, header, base } = parse(read, size);
  if (!await crypto.subtle.verify({ name: "Ed25519" }, publicKey, buffer(signature), buffer(signed))) {
    invalid("signature does not match the app's update key");
  }
  return { header, base };
}

/** One file of an opened pack, checked against its signed hash, decrypted and decompressed. */
export async function readPackFile(pack: OpenedPack, read: PackReader, contentKey: CryptoKey, path: string): Promise<Uint8Array> {
  const entry = Object.hasOwn(pack.header.files, path) ? pack.header.files[path] : undefined;
  if (!entry) throw new Error(`App pack has no file ${path}`);
  const stored = read(pack.base + entry.offset, entry.size);
  if (await sha256Hex(stored) !== entry.sha256) invalid(`${path} does not match its signed hash`);
  const plain = new Uint8Array(await crypto.subtle.decrypt(
    { name: "AES-GCM", iv: buffer(fromBase64(entry.iv)), additionalData: buffer(encoder.encode(path)) },
    contentKey,
    buffer(stored),
  ));
  const bytes = entry.gzip ? await transform(plain, new DecompressionStream("gzip")) : plain;
  if (bytes.length !== entry.length) invalid(`${path} has the wrong length`);
  return bytes;
}

export interface EncodePackOptions extends Omit<PackHeader, "files"> {
  files: readonly PackSource[];
  contentKey: CryptoKey;
  /** Signs the header bytes; returns the 64-byte Ed25519 signature. */
  sign(bytes: Uint8Array): Uint8Array | Promise<Uint8Array>;
}

/** Writes a pack: each file gzipped when that saves space, then encrypted with its own nonce. */
export async function encodePack(options: EncodePackOptions): Promise<Uint8Array> {
  const files: Record<string, PackEntry> = {};
  const blobs: Uint8Array[] = [];
  let offset = 0;
  for (const { path, data } of options.files) {
    if (!PATH.test(path)) throw new Error(`Invalid app pack file name: ${path}`);
    if (Object.hasOwn(files, path)) throw new Error(`App pack file listed twice: ${path}`);
    const compressed = await transform(data, new CompressionStream("gzip"));
    const gzip = compressed.length < data.length * 0.9;
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const stored = new Uint8Array(await crypto.subtle.encrypt(
      { name: "AES-GCM", iv, additionalData: buffer(encoder.encode(path)) },
      options.contentKey,
      buffer(gzip ? compressed : data),
    ));
    files[path] = { offset, size: stored.length, length: data.length, sha256: await sha256Hex(stored), iv: base64(iv), gzip };
    blobs.push(stored);
    offset += stored.length;
  }
  const header: PackHeader = {
    name: options.name, version: options.version, runtime: options.runtime, platform: options.platform,
    requires: options.requires, entry: options.entry, files,
  };
  validatePackHeader(header, offset);
  const json = encoder.encode(JSON.stringify(header));
  const signed = new Uint8Array(PREFIX + json.length);
  signed.set(encoder.encode(PACK_MAGIC));
  const view = new DataView(signed.buffer);
  view.setUint32(8, PACK_FORMAT, true);
  view.setUint32(12, json.length, true);
  signed.set(json, PREFIX);
  const signature = await options.sign(signed);
  if (signature.length !== SIGNATURE) throw new Error("App pack signature must be 64 bytes (Ed25519)");
  const out = new Uint8Array(signed.length + SIGNATURE + offset);
  out.set(signed);
  out.set(signature, signed.length);
  let position = signed.length + SIGNATURE;
  for (const blob of blobs) {
    out.set(blob, position);
    position += blob.length;
  }
  return out;
}

/** Whether an executable providing `compat` and `features` can run a pack requiring `requires`. */
export function packCompatible(requires: PackRequirements, compat: string, features: readonly string[]): boolean {
  return requires.compat === compat && requires.features.every(feature => features.includes(feature));
}
