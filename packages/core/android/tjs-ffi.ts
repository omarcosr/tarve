/** tjs:ffi for txiki.js modules the Android bundle shares (intl.ts): no foreign libraries there. */
export function dlopen(name: string): never {
  throw new Error(`dlopen(${JSON.stringify(name)}) is not available in the Tarve Android runtime`);
}
