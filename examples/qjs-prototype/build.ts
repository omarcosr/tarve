// Bundles entry.tsx for a bare QuickJS context: node builtins become stubs.
import { build } from "esbuild";
import { readFileSync, statSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

const dir = import.meta.dirname;
const result = await build({
  entryPoints: [join(dir, "entry.tsx")], bundle: true, write: false, platform: "browser", format: "iife", minify: !process.env.NOMINIFY,
  jsx: "automatic", jsxImportSource: "@tarve/core", logLevel: "silent",
  define: { "process.env.NODE_ENV": '"production"', "import.meta.url": '"file:///app.js"', ["import.meta." + "dir"]: '"/"', "import.meta.dirname": '"/"', "import.meta.main": "true", "import.meta.env": "{}", "import.meta.path": '"/app.js"' },
  plugins: [{ name: "stub-node", setup(b) {
    b.onResolve({ filter: /^(?:node:)?(?:module|child_process|timers\/promises|fs|fs\/promises|path|os|crypto|url|util|events|net|zlib|buffer|bun:ffi|node:ffi|worker_threads|tty|stream|assert)$/ }, () => ({ path: join(dir, "stub.js") }));
    // `with { type: "file" }` assets: their absolute path, which the native runtime reads.
    b.onResolve({ filter: /\.(?:svg|png|jpe?g|webp|gif|ttf|otf|woff2?)$/ }, a => ({ path: resolve(a.resolveDir, a.path), namespace: "asset" }));
    b.onLoad({ filter: /.*/, namespace: "asset" }, a => ({ contents: `export default ${JSON.stringify(a.path)};`, loader: "js" }));
  } }],
}).catch(error => { console.error(error.message); process.exit(1); });
const polyfill = readFileSync(join(dir, "polyfill.js"), "utf8");
writeFileSync(join(dir, "bundle.js"), polyfill + "\n" + result.outputFiles[0]!.text);
console.log("bundle", statSync(join(dir, "bundle.js")).size >> 10, "KB");
