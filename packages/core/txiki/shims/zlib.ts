/**
 * node:zlib's synchronous zlib and gzip streams on txiki.js (PNG reading and writing, archives).
 * txiki.js only has the async CompressionStream; the executable's native library (embedded in
 * every txiki.js build, extracted by the prelude) does it with miniz_oxide, as the Android host
 * does (native/src/zlib.rs, tarve_zlib_* in native/src/bridge/entry_points.rs).
 */
import { dlopen } from "tjs:ffi";
import { nativePath } from "../runtime";
import { Buffer } from "./buffer";

const SYMBOLS = {
  tarve_zlib_deflate: { args: ["u32", "buffer", "u32", "buffer", "u32"], returns: "i32" },
  tarve_zlib_inflate: { args: ["buffer", "u32", "buffer", "u32"], returns: "i32" },
  tarve_zlib_gzip: { args: ["u32", "buffer", "u32", "buffer", "u32"], returns: "i32" },
  tarve_zlib_gunzip: { args: ["buffer", "u32", "buffer", "u32"], returns: "i32" },
  tarve_last_error: { args: ["buffer", "u32"], returns: "i32" },
} as const;

let library: ReturnType<typeof dlopen<typeof SYMBOLS>> | undefined;
/** Opened on first use and kept for the process, like the bridge's. */
const symbols = () => (library ??= dlopen(nativePath(), SYMBOLS)).symbols;

/** The whole of a buffer: the FFI passes a typed array's buffer, so a view at an offset is copied. */
function bytes(data: Uint8Array | ArrayBuffer): Uint8Array {
  if (data instanceof ArrayBuffer) return new Uint8Array(data);
  return data.byteOffset === 0 && data.byteLength === data.buffer.byteLength ? data : data.slice();
}

/** Runs `call` into a buffer of `capacity` bytes, again with the capacity it asks for (a result below -1). */
function collect(op: string, capacity: number, call: (out: Uint8Array, capacity: number) => number): Uint8Array {
  for (let size = Math.max(64, capacity); ;) {
    const out = new Uint8Array(size);
    const length = call(out, size);
    if (length >= 0) return Buffer.from(out.buffer, 0, length);
    if (length === -1) {
      const message = new Uint8Array(1024);
      const written = symbols().tarve_last_error(message, message.length) as number;
      throw new Error(`zlib.${op}: ${new TextDecoder().decode(message.subarray(0, Math.max(0, written)))}`);
    }
    size = -length;
  }
}

const levelOf = (options?: { level?: number }) => options?.level === undefined || options.level < 0 ? 6 : options.level;
/** Stored blocks bound a deflate stream: 5 bytes per 64 KiB block, plus the wrapper. */
const bound = (length: number) => length + 5 * Math.ceil(length / 65535) + 32;

export function deflateSync(data: Uint8Array | ArrayBuffer, options?: { level?: number }): Uint8Array {
  const input = bytes(data);
  const level = levelOf(options);
  return collect("deflateSync", bound(input.length), (out, capacity) =>
    symbols().tarve_zlib_deflate(level, input, input.length, out, capacity) as number);
}

export function inflateSync(data: Uint8Array | ArrayBuffer): Uint8Array {
  const input = bytes(data);
  return collect("inflateSync", Math.max(64 * 1024, input.length * 4), (out, capacity) =>
    symbols().tarve_zlib_inflate(input, input.length, out, capacity) as number);
}

/** A gzip member with the header Node.js writes (no name or mtime, XFL from the level, the OS byte). */
export function gzipSync(data: Uint8Array | ArrayBuffer, options?: { level?: number }): Uint8Array {
  const input = bytes(data);
  const level = levelOf(options);
  return collect("gzipSync", bound(input.length), (out, capacity) =>
    symbols().tarve_zlib_gzip(level, input, input.length, out, capacity) as number);
}

/** The bytes of a gzip stream; members one after another are joined, as in Node.js. */
export function gunzipSync(data: Uint8Array | ArrayBuffer): Uint8Array {
  const input = bytes(data);
  return collect("gunzipSync", Math.max(64 * 1024, input.length * 4), (out, capacity) =>
    symbols().tarve_zlib_gunzip(input, input.length, out, capacity) as number);
}
export default { deflateSync, gunzipSync, gzipSync, inflateSync };
