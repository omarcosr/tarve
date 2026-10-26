// Plugin discovery: the packages an app depends on that declare a package.json `tarve` field
// with `plugin` (the JS entry) and optionally `native` (a library per target):
//
//   "tarve": {
//     "tarvePluginApi": 1,
//     "plugin": "./dist/plugin.js",
//     "native": { "win32-x64": "./native/hello.dll", "linux-x64": "./native/libhello.so" }
//   }
//
// Used by `tarve build` (to embed the target's libraries), by `ctx.loadLibrary()` without
// paths in development, and by `loadPlugins()`. Node.js APIs only: it runs under Bun,
// Node.js and the build CLI alike.
import { existsSync, readFileSync, statSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { isPluginTarget, type PluginTarget } from "./targets";

/** Major version of the plugin API this Tarve implements (`tarve.tarvePluginApi` of a plugin). */
export const PLUGIN_API_VERSION = 1;

export interface PluginManifest {
  /** package.json `name`. */
  name: string;
  version: string;
  /** Package directory. */
  directory: string;
  /** Plugin API major version the plugin was written against. */
  apiVersion: number;
  /** Absolute path of the JS entry (`tarve.plugin`). */
  entry: string;
  /** Absolute library path per target (`tarve.native`). */
  native: Partial<Record<PluginTarget, string>>;
}

export interface DiscoveryProblem {
  package: string;
  message: string;
}

export interface PluginDiscovery {
  plugins: PluginManifest[];
  /** Packages that declare a plugin Tarve cannot use (bad manifest, newer plugin API). */
  problems: DiscoveryProblem[];
}

export interface DiscoverPluginsOptions {
  /** The app's package directory, or any directory inside it (default: process.cwd()). */
  root?: string;
  /** Also look at devDependencies (default false: plugins ship with the app, so they are dependencies). */
  includeDev?: boolean;
}

type PackageJson = Record<string, unknown> & { name?: unknown; version?: unknown; tarve?: unknown };

function readJson(path: string): PackageJson | undefined {
  try { return JSON.parse(readFileSync(path, "utf8")) as PackageJson; } catch { return undefined; }
}

function isDirectory(path: string): boolean {
  try { return statSync(path).isDirectory(); } catch { return false; }
}

/** The nearest directory at or above `start` holding a package.json. */
export function findPackageRoot(start: string): string | undefined {
  let directory = resolve(start);
  if (!isDirectory(directory)) directory = dirname(directory);
  for (;;) {
    if (existsSync(join(directory, "package.json"))) return directory;
    const parent = dirname(directory);
    if (parent === directory) return undefined;
    directory = parent;
  }
}

/** Node.js resolution of a dependency's directory: `node_modules/<name>` here or in any parent. */
export function resolvePackageDirectory(name: string, from: string): string | undefined {
  let directory = resolve(from);
  for (;;) {
    const candidate = join(directory, "node_modules", ...name.split("/"));
    if (existsSync(join(candidate, "package.json"))) return candidate;
    const parent = dirname(directory);
    if (parent === directory) return undefined;
    directory = parent;
  }
}

/**
 * Reads a package's plugin manifest. `undefined`: not a plugin (no `tarve.plugin`).
 * Throws on a plugin manifest Tarve cannot use.
 */
export function readPluginManifest(directory: string, pkg: PackageJson | undefined = readJson(join(directory, "package.json"))): PluginManifest | undefined {
  if (!pkg) return undefined;
  const tarve = pkg.tarve as Record<string, unknown> | undefined;
  if (!tarve || typeof tarve !== "object" || tarve.plugin === undefined) return undefined;
  const name = typeof pkg.name === "string" && pkg.name ? pkg.name : undefined;
  if (!name) throw new TypeError(`${directory}: a plugin package needs a name`);
  if (typeof tarve.plugin !== "string" || !tarve.plugin.trim()) throw new TypeError(`${name}: tarve.plugin must be a path to the plugin's JS entry`);
  const apiVersion = tarve.tarvePluginApi ?? 1;
  if (typeof apiVersion !== "number" || !Number.isInteger(apiVersion) || apiVersion < 1) {
    throw new TypeError(`${name}: tarve.tarvePluginApi must be a positive integer`);
  }
  if (apiVersion > PLUGIN_API_VERSION) {
    throw new Error(`${name} needs Tarve plugin API ${apiVersion}; this Tarve implements ${PLUGIN_API_VERSION}. Update @tarve/core.`);
  }
  const native: Partial<Record<PluginTarget, string>> = {};
  if (tarve.native !== undefined) {
    if (!tarve.native || typeof tarve.native !== "object" || Array.isArray(tarve.native)) throw new TypeError(`${name}: tarve.native must map targets to library paths`);
    for (const [target, path] of Object.entries(tarve.native)) {
      if (!isPluginTarget(target)) throw new TypeError(`${name}: unknown tarve.native target "${target}"`);
      if (typeof path !== "string" || !path.trim()) throw new TypeError(`${name}: tarve.native["${target}"] must be a path`);
      native[target] = isAbsolute(path) ? path : resolve(directory, path);
    }
  }
  return {
    name,
    version: typeof pkg.version === "string" ? pkg.version : "0.0.0",
    directory,
    apiVersion,
    entry: resolve(directory, tarve.plugin),
    native,
  };
}

/**
 * The plugins of the app whose package contains `root`: its own package when it is a plugin
 * (a plugin's demo app), then its `dependencies` and `optionalDependencies`, in that order.
 */
export function discoverPlugins(options: DiscoverPluginsOptions = {}): PluginDiscovery {
  const discovery: PluginDiscovery = { plugins: [], problems: [] };
  const root = findPackageRoot(options.root ?? process.cwd());
  if (!root) return discovery;
  const pkg = readJson(join(root, "package.json"));
  if (!pkg) return discovery;
  const seen = new Set<string>();
  const add = (directory: string, label: string) => {
    try {
      const manifest = readPluginManifest(directory);
      if (manifest && !seen.has(manifest.name)) {
        seen.add(manifest.name);
        discovery.plugins.push(manifest);
      }
    } catch (error) {
      discovery.problems.push({ package: label, message: (error as Error).message });
    }
  };
  add(root, typeof pkg.name === "string" ? pkg.name : root);
  const dependencies = [pkg.dependencies, pkg.optionalDependencies, ...options.includeDev ? [pkg.devDependencies] : []]
    .flatMap(list => list && typeof list === "object" ? Object.keys(list) : []);
  for (const name of new Set(dependencies)) {
    const directory = resolvePackageDirectory(name, root);
    if (directory) add(directory, name);
  }
  return discovery;
}

/** A discovered plugin's library for `target`, or why there is none. */
export function pluginNativeFor(manifest: PluginManifest, target: PluginTarget): string | undefined {
  return manifest.native[target];
}
