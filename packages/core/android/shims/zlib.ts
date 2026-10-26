/** node:zlib's synchronous zlib and gzip streams on Android (miniz_oxide in the runtime, native/src/zlib.rs). */
import { Buffer } from "../../txiki/shims/buffer";
import { host } from "../host";

const bytes = (data: Uint8Array | ArrayBuffer): Uint8Array => data instanceof Uint8Array ? data : new Uint8Array(data);
const out = (data: Uint8Array): Uint8Array => Buffer.fromValue(data);
const level = (options?: { level?: number }) => options?.level === undefined || options.level < 0 ? undefined : options.level;

export const deflateSync = (data: Uint8Array, options?: { level?: number }): Uint8Array => out(host.zlib("deflate", bytes(data), level(options)));
export const inflateSync = (data: Uint8Array): Uint8Array => out(host.zlib("inflate", bytes(data)));
export const gzipSync = (data: Uint8Array, options?: { level?: number }): Uint8Array => out(host.zlib("gzip", bytes(data), level(options)));
export const gunzipSync = (data: Uint8Array): Uint8Array => out(host.zlib("gunzip", bytes(data)));
export default { deflateSync, gunzipSync, gzipSync, inflateSync };
