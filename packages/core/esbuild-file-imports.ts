import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import type { Plugin } from "esbuild";

/**
 * esbuild rejects Bun's `with { type: "text" }` and `import x from "./a.png" with { type: "file" }`. Route such
 * imports through esbuild's file loader, which copies the asset next to the
 * bundle and exports its path, matching what Bun returns.
 */
export const fileImportAttributes: Plugin = {
  name: "tarve-file-import-attributes",
  setup(build) {
    build.onResolve({ filter: /.*/ }, args => {
      const type = args.with?.type;
      if (type !== "file" && type !== "text") return undefined;
      return { path: resolve(dirname(args.importer), args.path), namespace: `tarve-${type}` };
    });
    build.onLoad({ filter: /.*/, namespace: "tarve-text" }, args => ({ contents: readFileSync(args.path, "utf8"), loader: "text" }));
    build.onLoad({ filter: /.*/, namespace: "tarve-file" }, args => ({
      contents: readFileSync(args.path),
      loader: "file",
      resolveDir: dirname(args.path),
    }));
  },
};
