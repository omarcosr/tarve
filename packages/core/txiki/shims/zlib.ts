function unavailable(name: string): never {
  throw new Error(`zlib.${name} is not available in the Tarve txiki.js runtime`);
}

export const deflateSync = (_data: Uint8Array): Uint8Array => unavailable("deflateSync");
export const inflateSync = (_data: Uint8Array): Uint8Array => unavailable("inflateSync");
export const gzipSync = (_data: Uint8Array): Uint8Array => unavailable("gzipSync");
export const gunzipSync = (_data: Uint8Array): Uint8Array => unavailable("gunzipSync");
export default { deflateSync, gunzipSync, gzipSync, inflateSync };
