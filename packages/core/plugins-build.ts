// `tarve build` side of plugins: finds the native libraries the app's plugins ship for the
// build target and generates the code that registers them inside the executable, where
// `ctx.loadLibrary()` finds them before any package.json path.
//
// Bun executables, Node.js single executables and txiki.js executables: each library is embedded
// as a file asset (`import x from "<lib>" with { type: "file" }`, which every runtime's bundler
// turns into a path) and extracted once, on first use, into the same digest-checked cache as
// Tarve's own runtime (embedded-assets.ts). macOS .app bundles: libraries are copied into
// Contents/Frameworks next to the runtime and signed with the bundle.
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { basename, dirname, resolve } from "node:path";
import { discoverPlugins } from "./src/plugins/discovery";
import { pluginTargetForBuild, type PluginTarget } from "./src/plugins/targets";

export interface PluginNativeEmbed {
  /** Plugin package name (the registry key `ctx.loadLibrary` looks up). */
  plugin: string;
  target: PluginTarget;
  /** Library on disk. */
  path: string;
  /** Name it gets once extracted (or in Contents/Frameworks). */
  fileName: string;
  sha256: string;
  size: number;
}

export interface PluginNativePlan {
  target: PluginTarget | undefined;
  embeds: PluginNativeEmbed[];
  /** Plugins with native libraries, none of them for this target: they must cope without one. */
  withoutTarget: string[];
}

/** The plugin libraries to embed for an app entry and a build target (`windows-x64`, `darwin-arm64`, `arm64-v8a`…). */
export function planPluginNatives(entrypoint: string, buildTarget: string): PluginNativePlan {
  const target = pluginTargetForBuild(buildTarget);
  const plan: PluginNativePlan = { target, embeds: [], withoutTarget: [] };
  const { plugins, problems } = discoverPlugins({ root: dirname(resolve(entrypoint)) });
  if (problems.length) {
    throw new Error(`Tarve plugins: ${problems.map(problem => `${problem.package}: ${problem.message}`).join("; ")}`);
  }
  for (const manifest of plugins) {
    const declared = Object.keys(manifest.native);
    if (!declared.length) continue;
    const path = target ? manifest.native[target] : undefined;
    if (!path) {
      plan.withoutTarget.push(manifest.name);
      continue;
    }
    if (!existsSync(path)) {
      throw new Error(`Plugin ${manifest.name}: native library for ${target} is missing: ${path}. Build it (cargo build --release --target …) or remove it from tarve.native.`);
    }
    const bytes = readFileSync(path);
    plan.embeds.push({
      plugin: manifest.name,
      target: target!,
      path,
      fileName: basename(path),
      sha256: createHash("sha256").update(bytes).digest("hex"),
      size: bytes.byteLength,
    });
  }
  const names = new Map<string, string>();
  for (const embed of plan.embeds) {
    const other = names.get(embed.fileName.toLowerCase());
    if (other) throw new Error(`Plugins ${other} and ${embed.plugin} both ship a library named ${embed.fileName}; rename one.`);
    names.set(embed.fileName.toLowerCase(), embed.plugin);
  }
  return plan;
}

/** `planPluginNatives` for a `tarve build` of any runtime, warning about plugins that ship nothing for the target. */
export function pluginNativesForBuild(entrypoint: string, buildTarget: string): PluginNativePlan {
  const plan = planPluginNatives(entrypoint, buildTarget);
  if (plan.withoutTarget.length) {
    console.warn(`Tarve: plugin${plan.withoutTarget.length > 1 ? "s" : ""} ${plan.withoutTarget.join(", ")} ship no native library for ${plan.target ?? (buildTarget || "this target")}.`);
  }
  return plan;
}

/**
 * The source of a module that registers the embedded libraries on its own (Node.js SEA and
 * txiki.js builds add it to their `#tarve/runtime`): the "embedded" lines and their import
 * of `materializeAsset` from `assetsModule` (embedded-assets.ts).
 */
export function pluginNativeModule(embeds: readonly PluginNativeEmbed[], assetsModule: string): string {
  if (!embeds.length) return "";
  return [`import { materializeAsset } from ${JSON.stringify(assetsModule)};`, ...pluginNativeRuntimeLines(embeds, "embedded")].join("\n");
}

/**
 * Lines for the generated `#tarve/runtime` module of an executable that register the
 * embedded libraries. `frameworks`: macOS bundles, whose libraries sit in Contents/Frameworks
 * (the module must import `dirname`/`join` from node:path); otherwise the module must import
 * `materializeAsset`.
 */
export function pluginNativeRuntimeLines(embeds: readonly PluginNativeEmbed[], layout: "embedded" | "frameworks"): string[] {
  if (!embeds.length) return [];
  const lines = [`const __tarvePlugins = (globalThis[Symbol.for("tarve.pluginNatives")] ??= {});`];
  embeds.forEach((embed, index) => {
    const name = JSON.stringify(embed.plugin);
    const target = JSON.stringify(embed.target);
    const fileName = JSON.stringify(embed.fileName);
    if (layout === "frameworks") {
      lines.push(`__tarvePlugins[${name}] = { ...__tarvePlugins[${name}], [${target}]: () => join(dirname(process.execPath), "..", "Frameworks", ${fileName}) };`);
    } else {
      const digest = JSON.stringify({ sha256: embed.sha256, size: embed.size });
      lines.unshift(`import __tarvePluginLibrary${index} from ${JSON.stringify(embed.path)} with { type: "file" };`);
      lines.push(`__tarvePlugins[${name}] = { ...__tarvePlugins[${name}], [${target}]: () => materializeAsset(__tarvePluginLibrary${index}, ${fileName}, ${digest}) };`);
    }
  });
  return lines;
}
