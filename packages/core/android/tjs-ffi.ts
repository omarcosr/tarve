/** tjs:ffi for txiki.js modules the Android bundle shares: dlopen over the host's FFI (native/src/android/qjs/ffi.rs). */
import { host } from "./host";

export function dlopen(name: string, definitions: Parameters<typeof host.dlopen>[1]): ReturnType<typeof host.dlopen> {
  return host.dlopen(name, definitions);
}
