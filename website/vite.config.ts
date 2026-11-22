// Bun-first: run everything with bun (bun run dev/build/start).
// NOTE: @hono/vite-build is ESM-only. Bun loads vite.config.ts natively as
// ESM, so the "/bun" subpath works. Under plain node, Vite loads the config
// through require() and "/bun" fails.
//
// Modes:
//   client     → browser bundles in dist/ (served by the Bun build)
//   production → Bun server in dist/index.js
//   client-cf  → browser bundles in dist-cf/public/ (Cloudflare static assets)
//   worker     → Cloudflare Worker in dist-cf/worker.js
import bunBuild from "@hono/vite-build/bun";
import workerBuild from "@hono/vite-build/cloudflare-workers";
import devServer, { defaultOptions as devServerDefaults } from "@hono/vite-dev-server";
import bunAdapter from "@hono/vite-dev-server/bun";
import { svelte } from "@sveltejs/vite-plugin-svelte";
import { pages } from "hono-svelte/vite";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { defineConfig } from "vite";
import { tarvePlayground } from "./src/lib/playground/vite-plugin";

const appPages = pages({ dts: true });
const entry = "src/routes/index.ts";

// Server builds embed the agent files (page.md, llms.txt…) rendered by scripts/build-agents.ts.
function requireAgentFiles() {
  if (!existsSync(resolve("src/lib/generated/agents.json"))) {
    throw new Error("src/lib/generated/agents.json is missing: run `bun run docs:agents` before building the server.");
  }
}

export default defineConfig(({ command, mode }) => {
  if (mode === "client" || mode === "client-cf") {
    return {
      plugins: [tarvePlayground(), svelte(), appPages],
      build: {
        outDir: mode === "client-cf" ? "dist-cf/public" : "dist",
        emptyOutDir: true,
        rollupOptions: {
          input: { ...appPages.input(), styles: resolve("src/styles.css") },
          output: {
            entryFileNames: "static/[name].js",
            chunkFileNames: "static/chunks/[name]-[hash].js",
            // The playground runtime is hashed into chunks/ so it can be cached as immutable.
            assetFileNames: (asset) =>
              asset.names.some((name) => name.endsWith(".wasm"))
                ? "static/chunks/[name]-[hash][extname]"
                : "static/[name][extname]",
          },
        },
      },
    };
  }

  if (command === "serve") {
    return {
      plugins: [tarvePlayground(), svelte(), appPages, devServer({
          entry,
          adapter: bunAdapter(),
          // Let Vite serve the playground's WebAssembly runtime instead of routing it to Hono,
          // and let Hono answer the pages' Markdown copies (`/docs/testing.md`) that the default skips.
          exclude: [
            ...devServerDefaults.exclude.filter((pattern) => String(pattern) !== String(/.*\.mdx?$/)),
            /.*\.mdx$/,
            /\.wasm(\?.*)?$/,
          ],
        })],
    };
  }

  if (mode === "worker") {
    requireAgentFiles();
    return {
      publicDir: false,
      // Workers run Svelte's server build: resolve the "worker" export condition, never "browser".
      ssr: { resolve: { conditions: ["workerd", "worker", "module", "import", "default"] } },
      plugins: [tarvePlayground(), svelte(), appPages, workerBuild({ entry, outputDir: "dist-cf", output: "worker.js" })],
    };
  }

  requireAgentFiles();
  return {
    plugins: [tarvePlayground(), svelte(), appPages, bunBuild({ entry, staticRoot: "./dist" })],
  };
});
