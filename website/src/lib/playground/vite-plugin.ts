import { basename, resolve } from "node:path";
import type { Plugin } from "vite";
import { toPreviewModule } from "./example-transform";
import { STUBS as stubs, stubFor } from "./resolve";

const root = resolve(import.meta.dirname, "../../../..");
const core = resolve(root, "packages/core/src");

/**
 * Lets the browser import Tarve straight from packages/core: maps the package name and its JSX
 * runtime to the sources, stubs Bun/Node-only imports of the desktop bridge, and turns
 * `examples/<Name>.tsx?playground` imports into mountable modules.
 */
export function tarvePlayground(): Plugin {
  return {
    name: "tarve-playground",
    enforce: "pre",
    config: () => ({
      resolve: {
        alias: [
          { find: /^@tarve\/core\/jsx-runtime$/, replacement: resolve(core, "jsx-runtime.ts") },
          { find: /^@tarve\/core\/jsx-dev-runtime$/, replacement: resolve(core, "jsx-dev-runtime.ts") },
          { find: /^@tarve\/core$/, replacement: resolve(core, "index.ts") },
        ],
      },
      oxc: { jsx: { runtime: "automatic", importSource: "@tarve/core" } },
      server: { fs: { allow: [root] } },
    }),
    async resolveId(id, importer) {
      if (!importer || !importer.replace(/\\/g, "/").includes("/packages/")) return null;
      if (id === "./bridge" || id === "../bridge") {
        const resolved = await this.resolve(id, importer, { skipSelf: true });
        if (resolved && resolved.id.replace(/\\/g, "/").endsWith("/packages/core/src/bridge/index.ts")) {
          return resolve(stubs, "bridge.ts");
        }
      }
      return stubFor(id) ?? null;
    },
    transform(code, id) {
      const [file, query] = id.split("?");
      if (query !== "playground" || !file!.endsWith(".tsx")) return null;
      return { code: toPreviewModule(basename(file!, ".tsx"), code).code, map: null };
    },
  };
}
