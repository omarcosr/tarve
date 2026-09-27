import { strict as assert } from "node:assert";
import { mkdir, mkdtemp, readdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import { build } from "../packages/core/build";
import { hostBuildTarget, targetConfig } from "../packages/core/targets";
import { buildNative } from "./native";

const root = resolve(import.meta.dir, "..");
const hostTarget = hostBuildTarget();
if (!hostTarget) throw new Error(`Standalone smoke is not supported for ${process.platform}-${process.arch}`);
const hostConfig = targetConfig(hostTarget);
await mkdir(join(root, "work"), { recursive: true });
const directory = await mkdtemp(join(root, "work/exe smoke "));
const executable = join(directory, `Tarve${hostConfig.executableSuffix}`);
const nativeLibrary = await buildNative(true);
await build({ entrypoint: join(root, "scripts/exe-smoke-entry.ts"), outfile: executable, nativeLibrary, name: "Tarve verification" });
assert.deepEqual(await readdir(directory), [`Tarve${hostConfig.executableSuffix}`], "The distribution must contain only the standalone executable");
const reportPath = join(directory, "report.json");
const cache = join(directory, "runtime-cache");
await mkdir(cache);
const env: NodeJS.ProcessEnv = {
  ...process.env,
  TEMP: cache,
  TMP: cache,
};
if (process.platform === "win32") env.PATH = join(process.env.SystemRoot ?? "C:/Windows", "System32");
delete env.TARVE_NATIVE;
delete env.TARVE_DEBUG;
delete env.BUN_BE_BUN;
const child = Bun.spawn([executable, "--smoke-test", "--smoke-report", reportPath], { cwd: directory, env, stdout: "inherit", stderr: "inherit" });
const timeout = setTimeout(() => child.kill(), 30_000);
try {
  assert.equal(await child.exited, 0, "Standalone executable must exit successfully; inspect the runtime temp directory if it fails");
  const report = await Bun.file(reportPath).json();
  assert.equal(report.result, "PASS");
  console.log(JSON.stringify({ ...report, standalone: true, reportPath }, null, 2));
} finally {
  clearTimeout(timeout);
}
