// Bundles entry.tsx for a bare QuickJS context: node builtins become stubs.

const result = await Bun.build({
  entrypoints: [import.meta.dir + "/entry.tsx"], target: "browser", format: "iife", minify: !process.env.NOMINIFY,
  define: { "process.env.NODE_ENV": '"production"', "import.meta.url": '"file:///app.js"', "import.meta.dir": '"/"', "import.meta.dirname": '"/"', "import.meta.main": "true", "import.meta.env": "({})", "import.meta.path": '"/app.js"' },
  plugins: [{ name: "stub-node", setup(b) {
    b.onResolve({ filter: /^(?:node:)?(?:module|child_process|timers\/promises|fs|fs\/promises|path|os|crypto|url|util|events|net|zlib|buffer|bun:ffi|node:ffi|worker_threads|tty|stream|assert)$/ }, () => ({ path: import.meta.dir + "/stub.js" }));
    // `with { type: "file" }` assets: their absolute path, which the native runtime reads.
    b.onResolve({ filter: /\.(?:svg|png|jpe?g|webp|gif|ttf|otf|woff2?)$/ }, a => ({ path: require("node:path").resolve(a.resolveDir, a.path), namespace: "asset" }));
    b.onLoad({ filter: /.*/, namespace: "asset" }, a => ({ contents: `export default ${JSON.stringify(a.path)};`, loader: "js" }));
  } }],
});
if (!result.success) { console.error(result.logs.join("\n")); process.exit(1); }
const polyfill = await Bun.file(import.meta.dir + "/polyfill.js").text();
await Bun.write(import.meta.dir + "/bundle.js", polyfill + "\n" + await result.outputs[0]!.text());
console.log("bundle", (await Bun.file(import.meta.dir + "/bundle.js").size) >> 10, "KB");
