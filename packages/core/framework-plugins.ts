import { existsSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { aliasPlugin, appAliases } from "./app-aliases";

/**
 * Optional framework compilers for apps that import them (`.svelte` through
 * @tarve/svelte): from the app's own dependencies, else this repository's package.
 * Apps without them build exactly as before.
 */
function frameworkModule(entrypoint: string, subpath: string, repositoryFile: string): string | undefined {
  try {
    return createRequire(resolve(entrypoint)).resolve(`@tarve/svelte/${subpath}`);
  } catch {
    const local = resolve(dirname(fileURLToPath(import.meta.url)), "../svelte/src", repositoryFile);
    return existsSync(local) ? local : undefined;
  }
}

/**
 * esbuild / Bun.build plugins every build of the app runs: its `tarve.alias` imports, then
 * the frameworks it can import.
 */
export async function frameworkPlugins<Plugin = import("esbuild").Plugin>(entrypoint: string): Promise<Plugin[]> {
  const aliases = appAliases(entrypoint);
  const plugins = aliases.length ? [aliasPlugin(aliases) as Plugin] : [];
  const path = frameworkModule(entrypoint, "plugin", "plugin.ts");
  if (!path) return plugins;
  const { sveltePlugin } = await loadTypeScript(path) as { sveltePlugin(): Plugin };
  return [...plugins, sveltePlugin()];
}

/** `bun --preload` modules that let `tarve run|dev` resolve the app's aliases and import those frameworks' files. */
export function frameworkPreloads(entrypoint: string): string[] {
  const here = dirname(fileURLToPath(import.meta.url));
  // Source checkout: the .ts; the npm package ships it bundled next to cli.js.
  const aliasPreload = [join(here, "alias-preload.ts"), join(here, "alias-preload.js")].find(existsSync);
  const preloads = aliasPreload && appAliases(entrypoint).length ? ["--preload", aliasPreload] : [];
  const path = frameworkModule(entrypoint, "bun-preload", "bun-preload.ts");
  return path ? [...preloads, "--preload", path] : preloads;
}

/**
 * Node.js does not strip types under node_modules: there the plugin is bundled
 * (with the Svelte compiler) into a temporary module first. Bun imports it directly.
 */
async function loadTypeScript(path: string): Promise<unknown> {
  if ((globalThis as { Bun?: unknown }).Bun) return import(pathToFileURL(path).href);
  const { build } = await import("esbuild");
  const result = await build({ entryPoints: [path], bundle: true, platform: "node", format: "esm", target: "node26", write: false, logLevel: "silent", external: ["esbuild"] });
  const file = join(mkdtempSync(join(tmpdir(), "tarve-framework-")), "plugin.mjs");
  writeFileSync(file, result.outputFiles[0]!.contents);
  return import(pathToFileURL(file).href);
}
