// txiki.js has no test runner: this entry (built with `tarve build --runtime txiki`, see
// scripts/smoke-headless-runtimes.ts) runs the same scenarios in order and writes a JSON report to
// the path in its last argument. It also records a digest of the counter frame's RGBA pixels, which
// the smoke compares with the stored snapshot's: pixel parity, independent of the PNG codec.
import { createHash } from "node:crypto";
import { writeFileSync } from "node:fs";
import { loadHeadlessRuntime } from "@tarve/headless";
import { cleanup } from "../src/index";
import { renderCounterFrame, scenarios } from "./scenarios";

const results: { name: string; error?: string }[] = [];
for (const scenario of scenarios) {
  try {
    await scenario.run();
    results.push({ name: scenario.name });
  } catch (error) {
    results.push({ name: scenario.name, error: error instanceof Error ? error.message : String(error) });
  } finally {
    cleanup();
  }
}
const view = await renderCounterFrame();
const frame = view.pixels();
const report = {
  build: (await loadHeadlessRuntime()).build,
  results,
  frame: { width: frame.width, height: frame.height, sha256: createHash("sha256").update(frame.rgba).digest("hex") },
};
cleanup();
for (const result of results) console.log(`${result.error ? "FAIL" : "ok  "} ${result.name}${result.error ? `: ${result.error}` : ""}`);
writeFileSync(process.argv[process.argv.length - 1]!, JSON.stringify(report));
