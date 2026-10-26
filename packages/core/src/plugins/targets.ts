// Plugin native targets: the keys of package.json `tarve.native` and of `ctx.loadLibrary({...})`.
// They name an OS and CPU the way Node.js does (`process.platform-process.arch`), so a plugin
// author never learns Tarve's build-target names; `tarve build --target` maps onto them.

/** Targets a plugin can ship a native library for. */
export const PLUGIN_TARGETS = [
  "win32-x64", "win32-arm64",
  "linux-x64", "linux-arm64",
  "darwin-arm64", "darwin-x64",
  "android-arm64", "android-x64",
] as const;
export type PluginTarget = typeof PLUGIN_TARGETS[number];

export function isPluginTarget(value: string): value is PluginTarget {
  return (PLUGIN_TARGETS as readonly string[]).includes(value);
}

/** The target this process runs on, or `undefined` for an OS/CPU no plugin can target. */
export function hostPluginTarget(platform: string = process.platform, arch: string = process.arch): PluginTarget | undefined {
  const key = `${platform}-${arch}`;
  return isPluginTarget(key) ? key : undefined;
}

/**
 * The plugin target of a `tarve build --target` value: desktop build targets
 * (`windows-x64`, `linux-x64`, `darwin-arm64`, `darwin-x64`) and Android ABIs
 * (`android-arm64`, `arm64-v8a`, `x86_64`).
 */
export function pluginTargetForBuild(target: string): PluginTarget | undefined {
  switch (target) {
    case "windows-x64": return "win32-x64";
    case "windows-arm64": return "win32-arm64";
    case "arm64-v8a": return "android-arm64";
    case "x86_64": return "android-x64";
    default: return isPluginTarget(target) ? target : undefined;
  }
}

/** File name a cdylib built by Cargo gets on a target (`hello` → `hello.dll`, `libhello.so`, `libhello.dylib`). */
export function nativeLibraryFileName(crate: string, target: PluginTarget): string {
  if (target.startsWith("win32-")) return `${crate}.dll`;
  if (target.startsWith("darwin-")) return `lib${crate}.dylib`;
  return `lib${crate}.so`;
}
