/**
 * @tarve/test and @tarve/headless on the other runtimes: the scenarios `bun test` runs
 * (packages/test/smoke/scenarios.tsx) run again under Node.js (`node --test` on the bundle
 * `tarve run --runtime node` makes) and as a txiki.js executable (`tarve build --runtime txiki`).
 *
 * txiki.js's WebAssembly has no SIMD, so it runs the baseline build (packages/headless/README.md).
 * Every scenario must pass there too, PNG snapshots included, and the RGBA pixels txiki.js renders
 * must equal the stored snapshot's.
 *
 *   bun run smoke:headless-runtimes
 */
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { readPngRgba } from "../packages/core/src/index";
import { nativePath } from "../packages/core/src/bridge/runtime";
import { runNode } from "../packages/core/node-dev";
import { buildTxiki } from "../packages/core/txiki-build";

const root = resolve(import.meta.dirname, "..");
const smoke = join(root, "packages/test/smoke");
const wasm = join(root, "packages/headless/wasm");
for (const file of ["tarve_web.js", "tarve_web_bg.wasm", "baseline/tarve_web.js", "baseline/tarve_web_bg.wasm"]) {
  if (!existsSync(join(wasm, file))) throw new Error(`packages/headless/wasm/${file} is missing: run bun run build:wasm`);
}

const failures: string[] = [];

console.log("[headless runtimes] Node.js: node --test packages/test/smoke/scenarios.test.ts");
const nodeStatus = await runNode(join(smoke, "scenarios.test.ts"), ["--test"]);
if (nodeStatus !== 0) failures.push(`node --test exited with ${nodeStatus}`);

console.log("[headless runtimes] txiki.js: packages/test/smoke/txiki.ts");
const work = join(root, "work/headless-runtimes");
rmSync(work, { recursive: true, force: true });
mkdirSync(work, { recursive: true });
try {
  const executable = await buildTxiki({ entrypoint: join(smoke, "txiki.ts"), outfile: join(work, `scenarios${process.platform === "win32" ? ".exe" : ""}`), nativeLibrary: nativePath() });
  const reportFile = join(work, "report.json");
  const child = Bun.spawn([executable, reportFile], { stdout: "inherit", stderr: "inherit" });
  const timer = setTimeout(() => child.kill(), 120_000);
  const code = await child.exited;
  clearTimeout(timer);
  if (code !== 0 || !existsSync(reportFile)) {
    failures.push(`the txiki.js executable exited with ${code} and no report`);
  } else {
    const report = JSON.parse(readFileSync(reportFile, "utf8")) as {
      build: string;
      results: { name: string; error?: string }[];
      frame: { width: number; height: number; sha256: string };
    };
    if (report.build !== "baseline") failures.push(`txiki.js ran the ${report.build} build; expected baseline (no WebAssembly SIMD)`);
    if (report.results.length === 0) failures.push("txiki.js ran no scenarios");
      for (const result of report.results) {
      if (result.error) failures.push(`txiki.js: "${result.name}": ${result.error}`);
      }
    const stored = await readPngRgba(join(root, "packages/test/__snapshots__/counter.png"));
    const digest = createHash("sha256").update(stored.rgba).digest("hex");
    if (report.frame.width !== stored.width || report.frame.height !== stored.height || report.frame.sha256 !== digest) {
      failures.push(`txiki.js counter frame ${report.frame.width}x${report.frame.height} ${report.frame.sha256} differs from counter.png's pixels (${digest})`);
    }
  }
} finally {
  rmSync(work, { recursive: true, force: true });
}

if (failures.length) {
  console.error(failures.join("\n"));
  process.exit(1);
}
console.log("[headless runtimes] PASS: Node.js and txiki.js run every scenario, with pixel-identical frames");
