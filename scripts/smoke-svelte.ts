// Builds the Svelte example into a standalone executable for each runtime and runs it.
// bun scripts/smoke-svelte.ts [--runtime bun|node|txiki]
import { strict as assert } from "node:assert";
import { mkdir, mkdtemp } from "node:fs/promises";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { build } from "../packages/core/build";
import { hostBuildTarget, targetConfig } from "../packages/core/targets";
import { buildNative } from "./native";

const root = resolve(import.meta.dir, "..");
const { values } = parseArgs({ args: process.argv.slice(2), options: { runtime: { type: "string", multiple: true } } });
const runtimes = (values.runtime?.length ? values.runtime : ["bun", "node", "txiki"]) as ("bun" | "node" | "txiki")[];
const target = hostBuildTarget();
if (!target) throw new Error(`Unsupported host ${process.platform}-${process.arch}`);
await mkdir(join(root, "work"), { recursive: true });
// The executables embed this checkout's native library, built for release.
const nativeLibrary = await buildNative(true);
for (const runtime of runtimes) {
  const directory = await mkdtemp(join(root, `work/svelte smoke ${runtime} `));
  const executable = join(directory, `SvelteSmoke${targetConfig(target).executableSuffix}`);
  const started = performance.now();
  await build({ entrypoint: join(root, "scripts/svelte-smoke-entry.ts"), outfile: executable, runtime, name: "Svelte smoke", nativeLibrary });
  const built = performance.now() - started;
  const reportPath = join(directory, "report.json");
  const child = Bun.spawn([executable, "--smoke-report", reportPath], { cwd: directory, stdout: "inherit", stderr: "inherit" });
  const timeout = setTimeout(() => child.kill(), 60_000);
  try {
    assert.equal(await child.exited, 0, `${runtime}: the executable must exit successfully`);
    const report = await Bun.file(reportPath).json();
    console.log(JSON.stringify({ runtime, buildMs: Math.round(built), ...report }));
    assert.equal(report.result, "PASS", `${runtime}: ${JSON.stringify(report)}`);
  } finally {
    clearTimeout(timeout);
  }
}
