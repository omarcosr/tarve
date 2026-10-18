import { dirname, isAbsolute, resolve } from "node:path";
import type { BunPlugin } from "bun";
import { toPreviewModule } from "./example-transform";

/**
 * How the browser playground loads @tarve/core from its sources: Node/Bun-only imports of the
 * desktop paths resolve to the stand-ins in ./stubs. Shared by the Vite plugin and by the Bun
 * build that tests the playground (scripts/playground.test.ts), so both resolve alike.
 */
const EXAMPLE = /[\\/]docs[\\/](examples|guides)[\\/][^\\/]+\.tsx$/;

export const STUBS = resolve(import.meta.dirname, "stubs");
const root = resolve(import.meta.dirname, "../../../..");
const core = resolve(root, "packages/core/src");

/** Node built-ins core may import; each resolves to stubs/node.ts, which must export every name used. */
export const NODE_BUILTINS = new Set([
  "node:crypto", "node:fs", "node:fs/promises", "node:os", "node:path", "node:net", "node:zlib",
  "node:module", "node:child_process", "node:stream", "node:timers/promises",
]);

/** The stub for a bare import (not the relative bridge import), or undefined. */
export function stubFor(id: string): string | undefined {
  if (id === "bun:ffi") return resolve(STUBS, "bun-ffi.ts");
  if (id === "#tarve/assets") return resolve(STUBS, "tarve-assets.ts");
  if (id === "#tarve/runtime") return resolve(STUBS, "tarve-runtime.ts");
  if (NODE_BUILTINS.has(id)) return resolve(STUBS, "node.ts");
  return undefined;
}

/**
 * The playground's resolution for `Bun.build` with `target: "browser"`: @tarve/core from its
 * sources, the stubs, and documentation examples turned into modules exporting `preview`. A
 * Node built-in without a stub fails the build instead of reaching the browser.
 */
export function playgroundBunPlugin(): BunPlugin {
  return {
    name: "tarve-playground",
    setup(build) {
      build.onResolve({ filter: /^@tarve\/core(\/jsx-(dev-)?runtime)?$/ }, ({ path }) => ({
        path: resolve(core, path === "@tarve/core" ? "index.ts" : path.slice("@tarve/core/".length) + ".ts"),
      }));
      build.onResolve({ filter: /^(node:|bun:|#tarve\/)/ }, ({ path, importer }) => {
        const stub = stubFor(path);
        if (!stub) throw new Error(`${path} (imported by ${importer}) has no playground stub: add it to NODE_BUILTINS and stubs/`);
        return { path: stub };
      });
      build.onResolve({ filter: /^\.\.?\/bridge$/ }, ({ importer }) =>
        importer.replace(/\\/g, "/").includes("/packages/core/src/") ? { path: resolve(STUBS, "bridge.ts") } : undefined);
      // Bun runs onLoad only for paths a plugin resolved.
      build.onResolve({ filter: EXAMPLE }, ({ path, importer }) => ({ path: isAbsolute(path) ? path : resolve(dirname(importer), path) }));
      build.onLoad({ filter: EXAMPLE }, async ({ path }) => ({
        // Contents from a plugin skip the tsconfig, so the JSX runtime is named here.
        contents: "/** @jsxImportSource @tarve/core */\n" + toPreviewModule(path.replace(/^.*[\\/]/, "").slice(0, -4), await Bun.file(path).text()).code,
        loader: "tsx",
      }));
    },
  };
}
