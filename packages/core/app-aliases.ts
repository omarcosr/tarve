import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, isAbsolute, join, normalize, resolve } from "node:path";

/**
 * Import aliases an app declares in the `tarve.alias` field of its package.json, like a
 * bundler's `resolve.alias`: `{ "$app/navigation": "./shims/navigation.ts",
 * "~icons/mdi/*": "./icons/mdi/*.ts" }`. A key ending in `/*` matches every specifier under
 * it and the `*` of its target takes the rest. Targets are paths relative to that
 * package.json. Every build (Bun, Node.js, txiki.js, packs) and `tarve run|dev` apply them,
 * also to files outside the app's directory that it imports (a shared source tree). Point
 * aliases at script modules (`.ts`, `.js`…): Bun's runtime loads a target as is, so a
 * `.svelte` component is reached through a module that re-exports it.
 */
export interface AppAlias {
  /** The specifier, or its prefix (`~icons/mdi/`) for a wildcard key. */
  find: string;
  wildcard: boolean;
  /** Absolute target; a wildcard's `*` is replaced by the matched rest. */
  target: string;
}

/** The aliases of the package.json nearest `entrypoint` (empty without a `tarve.alias` field). */
export function appAliases(entrypoint: string): AppAlias[] {
  let directory = dirname(resolve(entrypoint));
  for (;;) {
    const manifestPath = join(directory, "package.json");
    if (existsSync(manifestPath)) {
      const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as { tarve?: { alias?: unknown } };
      return parseAliases(manifest.tarve?.alias, directory);
    }
    const parent = dirname(directory);
    if (parent === directory) return [];
    directory = parent;
  }
}

export function parseAliases(value: unknown, root: string): AppAlias[] {
  if (value === undefined) return [];
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new TypeError("tarve.alias must be an object of specifier: path");
  return Object.entries(value as Record<string, unknown>).map(([key, target]) => {
    if (typeof target !== "string" || !target.trim()) throw new TypeError(`tarve.alias["${key}"] must be a path`);
    const wildcard = key.endsWith("/*");
    if (wildcard !== target.includes("*")) throw new TypeError(`tarve.alias["${key}"]: a "/*" key needs a "*" in its target, and only then`);
    return { find: wildcard ? key.slice(0, -1) : key, wildcard, target: isAbsolute(target) ? target : join(root, target) };
  })
    // The longest key wins, as with tsconfig paths.
    .sort((a, b) => b.find.length - a.find.length);
}

/** The aliased path of `specifier`, or undefined when no alias names it. */
export function resolveAlias(specifier: string, aliases: readonly AppAlias[]): string | undefined {
  for (const alias of aliases) {
    if (alias.wildcard ? specifier.startsWith(alias.find) && specifier.length > alias.find.length : specifier === alias.find) {
      return alias.wildcard ? normalize(alias.target.replace("*", specifier.slice(alias.find.length))) : alias.target;
    }
  }
  return undefined;
}

/**
 * Every specifier the aliases name, with its file: a wildcard's are the files its target
 * pattern matches in that directory. Bun's runtime does not pass bare specifiers to plugin
 * resolvers, so `tarve run|dev` registers each of these as a module instead.
 */
export function aliasModules(aliases: readonly AppAlias[]): [specifier: string, path: string][] {
  const out: [string, string][] = [];
  for (const alias of aliases) {
    if (!alias.wildcard) { out.push([alias.find, alias.target]); continue; }
    const directory = dirname(alias.target);
    const [before, after] = alias.target.slice(directory.length + 1).split("*") as [string, string];
    if (!existsSync(directory)) continue;
    for (const name of readdirSync(directory)) {
      if (name.length > before.length + after.length && name.startsWith(before) && name.endsWith(after)) {
        out.push([alias.find + name.slice(before.length, name.length - after.length), join(directory, name)]);
      }
    }
  }
  return out;
}

function escape(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&");
}

/** One filter for every alias: plugins only see the specifiers they rewrite. */
export function aliasFilter(aliases: readonly AppAlias[]): RegExp {
  return new RegExp(`^(?:${aliases.map(alias => escape(alias.find) + (alias.wildcard ? ".+" : "")).join("|")})$`);
}

interface AliasBuild {
  onResolve(options: { filter: RegExp }, callback: (args: { path: string; kind?: string; importer?: string; resolveDir?: string }) => unknown): void;
  resolve?: (path: string, options: { kind?: string; resolveDir?: string; importer?: string }) => Promise<{ path: string; namespace?: string; external?: boolean; errors: { text: string }[] }>;
}

/**
 * The aliases as an esbuild / `Bun.plugin` plugin. Under esbuild the target is resolved
 * again, so other plugins (Svelte) still load it; Bun's runtime takes the path as is.
 */
export function aliasPlugin(aliases: readonly AppAlias[]) {
  return {
    name: "tarve-alias",
    setup(build: AliasBuild) {
      if (!aliases.length) return;
      build.onResolve({ filter: aliasFilter(aliases) }, async args => {
        const target = resolveAlias(args.path, aliases);
        if (!target) return undefined;
        if (!build.resolve) return { path: target };
        const resolved = await build.resolve(target, { kind: args.kind, resolveDir: dirname(target), importer: args.importer });
        if (resolved.errors.length) return { errors: resolved.errors.map(error => ({ text: `tarve.alias "${args.path}" → ${target}: ${error.text}` })) };
        return { path: resolved.path, namespace: resolved.namespace, external: resolved.external };
      });
    },
  };
}
