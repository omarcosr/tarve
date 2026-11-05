import { existsSync, readFileSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { resolveImport, resolveSvelte, resolveTarveSvelte, SVELTE_SPECIFIER, TARVE_SVELTE_SPECIFIER } from "./resolve";

type LoadResult = { contents: string; loader: "js" | "ts"; resolveDir?: string };
/** The subset of the esbuild / Bun plugin API this plugin uses (both accept it). */
interface PluginBuild {
  onResolve(options: { filter: RegExp; namespace?: string }, callback: (args: { path: string; importer: string; resolveDir?: string }) => { path: string; namespace?: string } | undefined): void;
  onLoad(options: { filter: RegExp; namespace?: string }, callback: (args: { path: string }) => LoadResult | Promise<LoadResult>): void;
}

export interface SveltePluginOptions {
  /** Hears compiler warnings; defaults to console.warn. */
  onWarning?: (message: string) => void;
}

const NAMESPACE = "tarve-svelte";
/** Global style sheets an app imports (`import "./style.css"`). */
const CSS_NAMESPACE = "tarve-css";

/** Strips TypeScript from a `.svelte.ts` module before Svelte compiles its runes. */
async function stripTypes(source: string, path: string): Promise<string> {
  const bun = (globalThis as { Bun?: { Transpiler: new (options: object) => { transformSync(code: string): string } } }).Bun;
  if (bun) return new bun.Transpiler({ loader: "ts" }).transformSync(source);
  const { transform } = await import("esbuild");
  return (await transform(source, { loader: "ts", sourcefile: path, format: "esm" })).code;
}

/** Import specifiers of a compiled file: Svelte's client build, and relative paths made absolute. */
function importsOf(file: string) {
  return (specifier: string) => {
    if (SVELTE_SPECIFIER.test(specifier) || TARVE_SVELTE_SPECIFIER.test(specifier)) return resolveImport(specifier);
    // Relative `.svelte` imports stay relative: Bun hands absolute paths to its own loader, not to onResolve.
    if (/\.svelte(\.(js|ts))?$|\.css$/.test(specifier)) return specifier;
    if (specifier.startsWith("./") || specifier.startsWith("../")) return join(dirname(file), specifier).replace(/\\/g, "/");
    return specifier;
  };
}

/**
 * `.svelte` components and `.svelte.js/.ts` modules for esbuild, `Bun.build` and
 * `Bun.plugin`. Compiled files live in their own namespace (Bun's runtime does not
 * hand unknown extensions in the file namespace to plugins); their imports are absolute.
 */
export function sveltePlugin(options: SveltePluginOptions = {}) {
  const warn = options.onWarning ?? ((message: string) => console.warn(`[tarve/svelte] ${message}`));
  return {
    name: "tarve-svelte",
    setup(build: PluginBuild) {
      // Resolving svelte/package.json re-enters this hook under Bun.plugin: let that lookup through.
      let resolving = false;
      build.onResolve({ filter: SVELTE_SPECIFIER }, args => {
        // Entry points are paths, even "svelte/main.ts".
        if (resolving || !args.importer) return undefined;
        resolving = true;
        try { return { path: resolveSvelte(args.path) }; } finally { resolving = false; }
      });
      build.onResolve({ filter: TARVE_SVELTE_SPECIFIER }, args => ({ path: resolveTarveSvelte(args.path) }));
      build.onResolve({ filter: /\.svelte(\.(js|ts))?$/ }, args => {
        // Bun names a namespaced importer "tarve-svelte:<path>".
        const path = isAbsolute(args.path) ? args.path
          : resolve(args.importer?.startsWith(`${NAMESPACE}:`) ? dirname(args.importer.slice(NAMESPACE.length + 1)) : args.resolveDir ?? dirname(args.importer), args.path);
        // `import { x } from "./store.svelte"` names the module store.svelte.ts (or .js), as Vite resolves it.
          const module = path.endsWith(".svelte") && !existsSync(path) ? [path + ".ts", path + ".js"].find(existsSync) : undefined;
        return { path: module ?? path, namespace: NAMESPACE };
      });
      // `import "./app.css"`: a global style sheet, registered as the module loads (like a <link>).
      // Imports with attributes (`with { type: "file" }`) stay files.
      build.onResolve({ filter: /\.css$/ }, args => {
        if (Object.keys((args as { with?: object }).with ?? {}).length) return undefined;
        if (!isAbsolute(args.path) && !args.path.startsWith(".")) return undefined;
        const directory = args.importer?.startsWith(`${NAMESPACE}:`) || args.importer?.startsWith(`${CSS_NAMESPACE}:`)
          ? dirname(args.importer.slice(args.importer.indexOf(":") + 1)) : args.resolveDir ?? dirname(args.importer);
        return { path: isAbsolute(args.path) ? args.path : resolve(directory, args.path), namespace: CSS_NAMESPACE };
      });
      build.onLoad({ filter: /.*/, namespace: CSS_NAMESPACE }, async args => {
        const { parseCss, cssImports } = await import("./css");
        const source = readFileSync(args.path, "utf8");
        const rules = parseCss(source, message => warn(`${args.path}: ${message}`));
        // `@import "./other.css"` registers the other sheet first, as the cascade orders them.
        // Kept relative: Bun's runtime hands absolute paths to its own loader, not to onResolve.
        const imports = cssImports(source).map(url => `import ${JSON.stringify(/^\.{1,2}\//.test(url) ? url : "./" + url)};`);
        return {
          contents: `${imports.join("\n")}\nimport { registerCss } from ${JSON.stringify(resolveImport("@tarve/svelte/css"))};\nregisterCss(${JSON.stringify(rules)});\n`,
          loader: "js", resolveDir: dirname(args.path),
        };
      });
      // A bundle resolves `svelte` through this plugin: no runtime lookup by path.
      // The client build by absolute path: under Bun.plugin this hook also runs at runtime, where a
        // bare "svelte" may reach Bun's resolver (no importer) and load the server build.
        build.onLoad({ filter: /[\\/]svelte-client\.ts$/ }, () => ({ contents: `export { mount, unmount, flushSync } from ${JSON.stringify(resolveImport("svelte"))};`, loader: "ts" }));
      build.onLoad({ filter: /.*/, namespace: NAMESPACE }, async args => {
        // The compiler loads on the first component: plugins for apps without Svelte stay cheap.
        const { compileSvelte, compileSvelteModule } = await import("./compiler");
        let source = readFileSync(args.path, "utf8");
        const target = { resolve: importsOf(args.path) };
        let compiled;
        if (args.path.endsWith(".svelte")) compiled = compileSvelte(source, args.path, {}, target);
        else {
          if (args.path.endsWith(".ts")) source = await stripTypes(source, args.path);
          compiled = compileSvelteModule(source, args.path, target);
        }
        compiled.warnings.forEach(warn);
        return { contents: compiled.code, loader: "js", resolveDir: dirname(args.path) };
      });
    },
  };
}
