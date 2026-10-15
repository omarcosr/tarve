import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const here = dirname(fileURLToPath(import.meta.url));
let svelteRoot: string | undefined;
let svelteExports: Record<string, string | Record<string, string>> | undefined;

/** Bare `svelte` imports always resolve to Svelte's client build, from this package, so every component shares one runtime. */
export function resolveSvelte(specifier: string): string {
  if (!svelteRoot) {
    const manifest = require.resolve("svelte/package.json");
    svelteRoot = dirname(manifest);
    svelteExports = JSON.parse(readFileSync(manifest, "utf8")).exports;
  }
  const subpath = specifier === "svelte" ? "." : "./" + specifier.slice("svelte/".length);
  const entry = svelteExports![subpath];
  if (entry === undefined) throw new Error(`Svelte does not export "${specifier}"`);
  const file = typeof entry === "string" ? entry : entry.browser ?? entry.default;
  if (!file) throw new Error(`Svelte has no client entry for "${specifier}"`);
  return join(svelteRoot, file);
}

/** `@tarve/svelte` and its subpaths, from any importer (compiled components import them). */
export function resolveTarveSvelte(specifier: string): string {
  const subpath = specifier === "@tarve/svelte" ? "index" : specifier.slice("@tarve/svelte/".length);
  return join(here, subpath + ".ts");
}

export const SVELTE_SPECIFIER = /^svelte(\/.*)?$/;
export const TARVE_SVELTE_SPECIFIER = /^@tarve\/svelte(\/.*)?$/;

/** Absolute path of a `svelte` or `@tarve/svelte` specifier, with forward slashes (valid for Bun and esbuild). */
export function resolveImport(specifier: string): string {
  const path = SVELTE_SPECIFIER.test(specifier) ? resolveSvelte(specifier) : resolveTarveSvelte(specifier);
  return path.replace(/\\/g, "/");
}
