/** #tarve/runtime in a txiki.js executable: the prelude extracted the native library. */
export function nativePath(): string {
  const path = (globalThis as { __tarveNativePath?: string }).__tarveNativePath;
  if (!path) throw new Error("Tarve native library is not available: this txiki.js executable carries no runtime and TARVE_NATIVE is unset.");
  return path;
}
