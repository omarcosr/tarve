import { strict as assert } from "node:assert";
import { mkdir, readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { createApp } from "@tarve/core-internal";
import { App, connectRefresh, patch, setPatchSource } from "../examples/diff-view";
import { normalizePatch } from "../examples/patch-file";

assert.equal(normalizePatch(patch), patch);
assert.throws(() => normalizePatch("not a patch"));

const renderer = process.env.TARVE_SMOKE_RENDERER === "gpu" ? "gpu" : "cpu";
const app = createApp(App, { renderer, debug: true });
connectRefresh(() => app.update());
try {
  await app.ready;
  await Bun.sleep(160);
  const state = await app.inspect();
  const diff = state.nodes.find(node => node.id === "diff-demo");
  const scroll = state.nodes.find(node => node.id === "diff-demo-scroll");
  assert.equal(diff?.kind, "diff");
  assert(scroll, "Diff scroll container should exist");
  assert(state.nodes.find(node => node.id === "diff-search"), "Search input should exist");
  await mkdir(resolve("work"), { recursive: true });
  const output = resolve(`work/diff-example-${renderer}.png`);
  await app.capture(output);
  for (const name of ["api.patch", "readme.diff"]) {
    const source = await readFile(resolve("examples/patches", name), "utf8");
    setPatchSource(normalizePatch(source), name);
    await Bun.sleep(100);
    assert.equal((await app.inspect()).nodes.find(node => node.id === "diff-demo")?.kind, "diff");
  }
  const loadedOutput = resolve(`work/diff-example-loaded-${renderer}.png`);
  await app.capture(loadedOutput);
  console.log(`Diff example smoke passed: ${state.layoutNodes} native nodes. Screenshots: ${output}, ${loadedOutput}`);
} finally {
  app.close();
  await app.closed;
}
