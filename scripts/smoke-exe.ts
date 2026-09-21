import { strict as assert } from "node:assert";
import { mkdir, mkdtemp, readdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import { build } from "../packages/core/build";

const root = resolve(import.meta.dir, "..");
await mkdir(join(root, "work"), { recursive: true });
const directory = await mkdtemp(join(root, "work/exe smoke "));
const executable = join(directory, "Tarve.exe");
await build({ entrypoint: join(root, "scripts/exe-smoke-entry.ts"), outfile: executable, nativeLibrary: join(root, "native/target/release/tarve_native.dll"), name: "Tarve verification" });
assert.deepEqual(await readdir(directory), ["Tarve.exe"], "The distribution must contain only the EXE");
const reportPath = join(directory, "report.json");
const cache = join(directory, "runtime-cache");
await mkdir(cache);
const env: NodeJS.ProcessEnv = {
  ...process.env,
  PATH: join(process.env.SystemRoot ?? "C:/Windows", "System32"),
  TEMP: cache,
  TMP: cache,
};
delete env.TARVE_NATIVE;
delete env.TARVE_DEBUG;
delete env.BUN_BE_BUN;
const child = Bun.spawn([executable, "--smoke-test", "--smoke-report", reportPath], { cwd: directory, env, stdout: "inherit", stderr: "inherit" });
const timeout = setTimeout(() => child.kill(), 30_000);
try {
  assert.equal(await child.exited, 0, "Standalone EXE must exit successfully; inspect %TEMP%/tarve-startup-error.log if it fails");
  const report = await Bun.file(reportPath).json();
  assert.equal(report.result, "PASS");
  console.log(JSON.stringify({ ...report, standalone: true, reportPath }, null, 2));
} finally {
  clearTimeout(timeout);
}
