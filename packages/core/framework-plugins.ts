import { existsSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

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

/** esbuild / Bun.build plugins for the frameworks the app can import. */
export async function frameworkPlugins<Plugin = import("esbuild").Plugin>(entrypoint: string): Promise<Plugin[]> {
  const path = frameworkModule(entrypoint, "plugin", "plugin.ts");
  if (!path) return [];
  const { sveltePlugin } = await loadTypeScript(path) as { sveltePlugin(): Plugin };
  return [sveltePlugin()];
}

/** `bun --preload` modules that let `tarve run|dev` import those frameworks' files. */
export function frameworkPreloads(entrypoint: string): string[] {
  const path = frameworkModule(entrypoint, "bun-preload", "bun-preload.ts");
  return path ? ["--preload", path] : [];
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
