// Node.js check: bundles a script that drives the routers and builds RouterView's tree (no
// native window), as `tarve run --runtime node` bundles apps, then runs it with `node`.
// Usage: bun packages/router/scripts/node-smoke.ts
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { build } from "esbuild";

const root = resolve(import.meta.dir, "../../..");
const directory = mkdtempSync(join(tmpdir(), "tarve-router-node-"));
try {
  const entry = join(directory, "entry.ts");
  writeFileSync(entry, `
import { createStackRouter, createTabRouter, route, RouterView, TabRouterView } from ${JSON.stringify(join(root, "packages/router/src/index.ts").replaceAll("\\\\", "/"))};
const screen = () => ({ type: "view", props: {} });
const stack = createStackRouter({ routes: { home: route("/", screen), user: route("/users/:id", screen) }, transition: "slide" });
let updates = 0;
stack.attach({ update: () => updates++ });
const user = stack.navigate("/users/42?tab=posts");
if (user?.params.id !== "42" || user.query.tab !== "posts" || !stack.canGoBack() || updates !== 1) throw new Error("stack navigate failed");
const view = RouterView({ router: stack });
if (typeof view.type !== "function") throw new Error("RouterView did not build a tree");
stack.pop();
const tabs = createTabRouter({ tabs: { a: { routes: { a: route("/a", screen) } }, b: { routes: { b: route("/b", screen), item: route("/b/:x", screen) } } } });
tabs.navigate("/b/1");
if (tabs.active !== "b" || !tabs.back() || !tabs.back() || tabs.active !== "a") throw new Error("tab router failed");
TabRouterView({ router: tabs });
console.log("router ok on node " + process.version);
`);
  const outfile = join(directory, "entry.mjs");
  await build({
    entryPoints: [entry], outfile, bundle: true, platform: "node", format: "esm", target: "node26",
    jsx: "automatic", jsxImportSource: "@tarve/core", tsconfig: join(root, "tsconfig.json"), logLevel: "warning",
  });
  const result = spawnSync("node", [outfile], { stdio: "inherit", env: { ...process.env, TARVE_NO_NATIVE: "1" } });
  process.exit(result.status ?? 1);
} finally {
  rmSync(directory, { recursive: true, force: true });
}
