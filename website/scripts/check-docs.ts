// Verifies that every exported component has a catalog entry and a usage example,
// then type-checks every example against the real @tarve/core sources.
import { readdirSync } from "node:fs";
import { resolve } from "node:path";
import api from "../src/lib/generated/api.json";
import { orderedNames } from "../src/lib/docs/catalog";

const examplesDir = resolve(import.meta.dir, "../src/lib/docs/examples");
const repo = resolve(import.meta.dir, "../..");
const exported = new Set(api.components.map((component) => component.name));
const documented = new Set(orderedNames);
const examples = new Set(readdirSync(examplesDir).filter((file) => file.endsWith(".tsx")).map((file) => file.slice(0, -4)));

const problems = [
  ...[...exported].filter((name) => !documented.has(name)).map((name) => `${name}: exported but missing from catalog.ts`),
  ...[...documented].filter((name) => !exported.has(name)).map((name) => `${name}: in catalog.ts but not exported by @tarve/core`),
  ...[...documented].filter((name) => !examples.has(name)).map((name) => `${name}: no example in src/lib/docs/examples`),
  ...[...examples].filter((name) => !documented.has(name)).map((name) => `${name}.tsx: example without a catalog entry`),
];
if (problems.length) {
  console.error(problems.map((problem) => "  ✗ " + problem).join("\n"));
  process.exit(1);
}

const tsc = Bun.spawnSync(["bun", resolve(repo, "node_modules/typescript/bin/tsc"), "--noEmit", "-p", resolve(examplesDir, "tsconfig.json")], {
  cwd: repo,
  stdout: "inherit",
  stderr: "inherit",
});
if (tsc.exitCode !== 0) process.exit(tsc.exitCode ?? 1);
const playground = Bun.spawnSync(
  ["bun", resolve(repo, "node_modules/typescript/bin/tsc"), "--noEmit", "-p", resolve(import.meta.dir, "../src/lib/playground/tsconfig.json")],
  { cwd: repo, stdout: "inherit", stderr: "inherit" },
);
if (playground.exitCode !== 0) process.exit(playground.exitCode ?? 1);
// The playground loads @tarve/core in the browser with stand-ins for Node/Bun built-ins
// (src/lib/playground/stubs); a name core imports that a stub lacks breaks every live example.
const stubs = resolve(import.meta.dir, "../src/lib/playground/stubs");
const browser = await Bun.build({
  entrypoints: [resolve(repo, "packages/core/src/index.ts")],
  target: "browser",
  throw: false,
  plugins: [{
    name: "playground-stubs",
    setup(build) {
      build.onResolve({ filter: /^node:/ }, () => ({ path: resolve(stubs, "node.ts") }));
      build.onResolve({ filter: /^bun:ffi$/ }, () => ({ path: resolve(stubs, "bun-ffi.ts") }));
      build.onResolve({ filter: /^#tarve\/assets$/ }, () => ({ path: resolve(stubs, "tarve-assets.ts") }));
      build.onResolve({ filter: /^#tarve\/runtime$/ }, () => ({ path: resolve(stubs, "tarve-runtime.ts") }));
      build.onResolve({ filter: /^\.\.?\/bridge$/ }, (args) =>
        args.importer.replace(/\\/g, "/").includes("/packages/core/src/") ? { path: resolve(stubs, "bridge.ts") } : undefined);
    },
  }],
});
if (!browser.success) {
  console.error(browser.logs.map((log) => "  ✗ playground: " + log.message).join("\n"));
  process.exit(1);
}
console.log(`[check-docs] ${documented.size} components documented, ${examples.size} examples type-check.`);
