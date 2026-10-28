import { existsSync, readFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import type { Plugin } from "esbuild";
import { frameworkPlugins } from "./framework-plugins";

/** Modules esbuild bundles itself; any other file (images, text, wasm, .node, CSS…) stays an import that Bun embeds. */
const SCRIPT = /\.(?:[cm]?[jt]sx?|json)$/i;
/** Marks this plugin's own `build.resolve` calls, so they take esbuild's ordinary path. */
const OWN = Symbol("tarve-bun-prebundle");

export interface BunPrebundleOptions {
  /** The module to bundle: the app's entry, or the pack host entry that imports it. */
  entry: string;
  /** The app's own entry, whose package selects the framework plugins (Svelte…). */
  appEntrypoint: string;
  /** Directory the bundle is written to. */
  directory: string;
  define: Record<string, string>;
  compileJsx?: boolean;
}

/**
 * Bun does not honor `keepNames` (1.4.3 and 1.4.4 rename functions under `minify.identifiers`, and
 * Function.name with them: component names in the inspector, error names). So a Bun app is
 * bundled by esbuild with `keepNames`, the bundler and options Node.js and txiki.js executables use,
 * and `bun build --compile` then minifies and embeds that one module: the names live on as
 * `__name(fn, "Counter")`, which no renaming touches. Imports esbuild does not load itself — files
 * (images, `with { type }`), `bun:` modules, #tarve/runtime, esbuild — stay imports, with absolute
 * paths, and Bun resolves and embeds them exactly as when it bundled the app on its own.
 * Returns the bundle's path.
 */
export async function prebundleForBun(options: BunPrebundleOptions): Promise<string> {
  const sourceDirectory = join(import.meta.dirname, "src");
  const repositorySource = existsSync(join(sourceDirectory, "index.ts"));
  const plugin: Plugin = {
    name: "tarve-bun-prebundle",
    setup(build) {
      if (repositorySource) {
        build.onResolve({ filter: /^(?:@tarve\/core|tarve)(?:\/(?:jsx-runtime|jsx-dev-runtime))?$/ }, args => {
          const entry = args.path.replace(/^(?:@tarve\/core|tarve)/, "") || "/index";
          return { path: join(sourceDirectory, `${entry.slice(1)}.ts`) };
        });
      }
      build.onResolve({ filter: /^(?:#tarve\/runtime|bun|bun:.*)$/ }, args => ({ path: args.path, external: true }));
      build.onResolve({ filter: /.*/ }, async args => {
        if (args.pluginData === OWN || args.kind === "entry-point") return undefined;
        const attributed = Object.keys(args.with).length > 0;
        const resolved = await build.resolve(args.path, { kind: args.kind, importer: args.importer, resolveDir: args.resolveDir, namespace: args.namespace, pluginData: OWN });
        if (resolved.errors.length || resolved.external || resolved.namespace !== "file") return undefined;
        // esbuild's API finds its own binary and refuses to be bundled by esbuild; Bun bundles it.
        if (!attributed && args.path !== "esbuild" && SCRIPT.test(resolved.path)) return undefined;
        return { path: resolved.path, external: true };
      });
      if (options.compileJsx) {
        build.onLoad({ filter: /\.[jt]sx$/ }, async args => {
          if (/[\\/]node_modules[\\/]/.test(args.path) || args.path.startsWith(sourceDirectory)) return undefined;
          const { compileJsx } = await import("./jsx-compile");
          return { contents: (await compileJsx(readFileSync(args.path, "utf8"))).code, loader: args.path.endsWith(".jsx") ? "jsx" : "tsx", resolveDir: dirname(args.path) };
        });
      }
    },
  };
  const outfile = join(options.directory, basename(options.entry).replace(/\.[^.]+$/, "") + ".js");
  const { build } = await import("esbuild");
  await build({
    entryPoints: [options.entry],
    outfile,
    bundle: true,
    format: "esm",
    platform: "node",
    target: "esnext",
    conditions: ["bun"],
    jsx: "automatic",
    jsxImportSource: "@tarve/core",
    minify: true,
    keepNames: true,
    logLevel: "silent",
    define: { "process.env.NODE_ENV": JSON.stringify("production"), ...options.define },
    plugins: [plugin, ...await frameworkPlugins(options.appEntrypoint)],
  });
  return outfile;
}
