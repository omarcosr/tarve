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
import devServer from "@hono/vite-dev-server";
import bunAdapter from "@hono/vite-dev-server/bun";
import { svelte } from "@sveltejs/vite-plugin-svelte";
import { pages } from "hono-svelte/vite";
import { resolve } from "node:path";
import { defineConfig } from "vite";

const appPages = pages({ dts: true });
const entry = "src/routes/index.ts";

export default defineConfig(({ command, mode }) => {
  if (mode === "client" || mode === "client-cf") {
    return {
      plugins: [svelte(), appPages],
      build: {
        outDir: mode === "client-cf" ? "dist-cf/public" : "dist",
        emptyOutDir: true,
        rollupOptions: {
          input: { ...appPages.input(), styles: resolve("src/styles.css") },
          output: {
            entryFileNames: "static/[name].js",
            chunkFileNames: "static/chunks/[name]-[hash].js",
            assetFileNames: "static/[name][extname]",
          },
        },
      },
    };
  }

  if (command === "serve") {
    return {
      plugins: [svelte(), appPages, devServer({ entry, adapter: bunAdapter() })],
    };
  }

  if (mode === "worker") {
    return {
      publicDir: false,
      // Workers run Svelte's server build: resolve the "worker" export condition, never "browser".
      ssr: { resolve: { conditions: ["workerd", "worker", "module", "import", "default"] } },
      plugins: [svelte(), appPages, workerBuild({ entry, outputDir: "dist-cf", output: "worker.js" })],
    };
  }

  return {
    plugins: [svelte(), appPages, bunBuild({ entry, staticRoot: "./dist" })],
  };
});
