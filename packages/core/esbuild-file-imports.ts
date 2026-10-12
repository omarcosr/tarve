import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import type { Plugin } from "esbuild";

const ASSET = /\.(?:png|jpe?g|webp|gif|svg)$/i;

/**
 * esbuild rejects Bun's `with { type: "text" }` and `import x from "./a.png" with { type: "file" }`. Route such
 * imports (and plain image imports) through esbuild's file loader, which copies the asset next to the
 * bundle. Like Bun, the import is the asset's absolute path: esbuild's own path is relative to the
 * bundle, which `readFileSync` would resolve against the working directory instead.
 */
export const fileImportAttributes: Plugin = {
  name: "tarve-file-import-attributes",
  setup(build) {
    build.onResolve({ filter: /.*/ }, args => {
      if (args.namespace === "tarve-file") {
        return args.path.startsWith("node:") ? { path: args.path, external: true } : { path: args.path, namespace: "tarve-file-copy" };
      }
      const type = args.with?.type ?? (ASSET.test(args.path) && args.kind === "import-statement" ? "file" : undefined);
      if (type !== "file" && type !== "text") return undefined;
      return { path: resolve(dirname(args.importer), args.path), namespace: `tarve-${type}` };
    });
    build.onLoad({ filter: /.*/, namespace: "tarve-text" }, args => ({ contents: readFileSync(args.path, "utf8"), loader: "text" }));
    build.onLoad({ filter: /.*/, namespace: "tarve-file" }, args => ({
      contents: [
        `import relative from ${JSON.stringify(args.path)};`,
        `import { join } from "node:path";`,
        `export default join(import.meta.dirname, relative);`,
      ].join("\n"),
      loader: "js",
      resolveDir: dirname(args.path),
    }));
    build.onLoad({ filter: /.*/, namespace: "tarve-file-copy" }, args => ({
      contents: readFileSync(args.path),
      loader: "file",
    }));
  },
};
