/**
 * The JS side of an Android APK: the app bundled for the QuickJS-ng engine the runtime embeds
 * (android/prelude.ts, native/src/android/qjs.rs), node:* builtins through the Android shims.
 * `tarve build --target android` packs it as assets/tarve/app.js; `tarve dev --target android`
 * rebundles it on every save and pushes it to the device.
 */
import { join } from "node:path";
import type { BuildOptions } from "./build";
import { bundleQuickJs, type EmbeddedFile } from "./txiki-build";

export interface AndroidBundle {
  /** Path of the bundled app.js. */
  bundle: string;
  /** Files the app imports, packed as assets/tarve/files/<name>. */
  assets: EmbeddedFile[];
}

export async function bundleAndroidJs(options: BuildOptions, define: Record<string, string>, temporary: string): Promise<AndroidBundle> {
  const root = import.meta.dirname;
  const shims: Record<string, string> = {
    fs: join(root, "android/shims/fs.ts"),
    "fs/promises": join(root, "android/shims/fs-promises.ts"),
    path: join(root, "android/shims/path.ts"),
    os: join(root, "android/shims/os.ts"),
    crypto: join(root, "android/shims/crypto.ts"),
    net: join(root, "android/shims/net.ts"),
    module: join(root, "txiki/shims/module.ts"),
    zlib: join(root, "android/shims/zlib.ts"),
    events: join(root, "txiki/shims/events.ts"),
    child_process: join(root, "android/shims/child-process.ts"),
    "timers/promises": join(root, "txiki/shims/timers-promises.ts"),
  };
  return bundleQuickJs(options, {
    label: "Android",
    prelude: join(root, "android/prelude.ts"),
    runtimeModule: join(root, "android/runtime.ts"),
    shims,
    tjs: { "tjs:ffi": join(root, "android/tjs-ffi.ts") },
    // intl.ts reads LANG on "linux"; the host sets it from the device locale.
    define: { ...define, TARVE_TXIKI_PLATFORM: JSON.stringify("linux"), TARVE_TXIKI_NATIVE_NAME: JSON.stringify("libtarve_native.so") },
  }, temporary);
}
