/**
 * First module of a Tarve txiki.js executable. It gives the core the Node globals it
 * expects, then extracts the native library and assets embedded in the executable into
 * the shared asset cache, before any app module runs (the bundle keeps this order, and
 * the top-level await holds the modules after it).
 */
import * as ffi from "tjs:ffi";
import { createHash } from "tjs:hashing";
import path from "tjs:path";
import { createFetch } from "./fetch";
import { installIntl } from "./intl";
import { Buffer } from "./shims/buffer";

declare const TARVE_TXIKI_PLATFORM: "win32" | "linux";
declare const TARVE_TXIKI_NATIVE_NAME: string;

/** One file of the blob txiki-build.ts places before the txiki.js payload. */
interface EmbeddedFile {
  name: string;
  offset: number;
  length: number;
  size: number;
  sha256: string;
  gzip: boolean;
}

const TXIKI_MAGIC = "tx1k1.js";
const BLOB_MAGIC = "TARVEBLB";
const decoder = new TextDecoder();
const globals = globalThis as Record<string, unknown>;

installIntl();
globals.fetch = createFetch(globalThis.fetch.bind(globalThis));
globals.Buffer = Buffer;
globals.__tarveTxikiFfi = ffi;
globals.__tarveDirname = path.dirname(tjs.exePath);
globals.setImmediate ??= (callback: (...args: unknown[]) => void, ...args: unknown[]) => setTimeout(callback, 0, ...args);
const process = {
  platform: TARVE_TXIKI_PLATFORM,
  arch: "x64",
  env: tjs.env,
  // A compiled app: [exe, ...args]. `tjs run app.js ...args` (debugging a bundle): [tjs, "run", app.js, ...args].
  argv: tjs.args[1] === "run" ? [tjs.exePath, ...tjs.args.slice(2)] : [tjs.exePath, tjs.exePath, ...tjs.args.slice(1)],
  execArgv: [],
  execPath: tjs.exePath,
  versions: { tjs: tjs.version, quickjs: String(tjs.engine.versions.quickjs) },
  exitCode: undefined as number | undefined,
  exit(code?: number): never {
    return tjs.exit(code ?? this.exitCode ?? 0);
  },
  cwd: () => tjs.cwd,
  chdir: (directory: string) => tjs.chdir(directory),
  memoryUsage: () => ({ rss: 0, heapTotal: 0, heapUsed: 0, external: 0, arrayBuffers: 0 }),
  nextTick: (callback: (...args: unknown[]) => void, ...args: unknown[]) => queueMicrotask(() => callback(...args)),
  on() { return this; },
  once() { return this; },
  off() { return this; },
};
globals.process = process;

async function readAt(file: TjsFileHandle, position: number, length: number): Promise<Uint8Array> {
  const bytes = new Uint8Array(length);
  let read = 0;
  while (read < length) {
    const count = await file.read(bytes.subarray(read), position + read);
    if (!count) throw new Error("The executable is truncated: rebuild it.");
    read += count;
  }
  return bytes;
}

function uint32(bytes: Uint8Array, offset: number): number {
  return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(offset, true);
}

async function embeddedFiles(): Promise<{ files: EmbeddedFile[]; read(file: EmbeddedFile): Promise<Uint8Array>; close(): Promise<void> }> {
  const exe = await tjs.open(tjs.exePath, "r");
  const blob = { read: (file: EmbeddedFile) => readAt(exe, file.offset, file.length), close: () => exe.close() };
  const { size } = await exe.stat();
  const trailer = await readAt(exe, size - 12, 12);
  if (decoder.decode(trailer.subarray(0, 8)) !== TXIKI_MAGIC) return { files: [], ...blob };
  const payload = uint32(trailer, 8);
  const header = await readAt(exe, payload - 16, 16);
  if (decoder.decode(header.subarray(8)) !== BLOB_MAGIC) return { files: [], ...blob };
  const indexLength = uint32(header, 0);
  const index = await readAt(exe, payload - 16 - indexLength, indexLength);
  return { files: JSON.parse(decoder.decode(index)) as EmbeddedFile[], ...blob };
}

async function gunzip(bytes: Uint8Array): Promise<Uint8Array> {
  const stream = new Blob([bytes as Uint8Array<ArrayBuffer>]).stream().pipeThrough(new DecompressionStream("gzip"));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

async function sizeOf(file: string): Promise<number | undefined> {
  try { return (await tjs.stat(file)).size; } catch { return undefined; }
}

/** Same cache layout as materializeAsset: <tmp>/tarve-assets/<sha256>/<name>, written once. */
async function materialize(file: EmbeddedFile, read: (file: EmbeddedFile) => Promise<Uint8Array>): Promise<string> {
  const directory = path.join(tjs.tmpDir, "tarve-assets", file.sha256);
  const target = path.join(directory, file.name);
  if (await sizeOf(target) === file.size) return target;
  const stored = await read(file);
  const bytes = file.gzip ? await gunzip(stored) : stored;
  const hash = createHash("sha256");
  hash.update(bytes);
  if (bytes.length !== file.size || hash.digest("hex") !== file.sha256) {
    throw new Error(`Embedded file ${file.name} does not match its build-time digest; rebuild the executable.`);
  }
  await tjs.makeDir(directory, { recursive: true });
  const temporary = `${target}.${crypto.randomUUID()}.tmp`;
  await tjs.writeFile(temporary, bytes);
  try {
    await tjs.rename(temporary, target);
  } catch (error) {
    // A simultaneous launch published it first (Windows refuses to replace a loaded DLL).
    await tjs.remove(temporary).catch(() => {});
    if (await sizeOf(target) !== file.size) throw error;
  }
  return target;
}

const blob = await embeddedFiles();
try {
  const paths: Record<string, string> = {};
  for (const file of blob.files) paths[file.name] = await materialize(file, blob.read);
  globals.__tarveAssets = paths;
  globals.__tarveNativePath = paths[TARVE_TXIKI_NATIVE_NAME] ?? tjs.env.TARVE_NATIVE;
} finally {
  await blob.close();
}
