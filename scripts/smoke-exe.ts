import { strict as assert } from "node:assert";
import { parseArgs } from "node:util";
import { mkdir, mkdtemp, readdir, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { build } from "../packages/core/build";
import { hostBuildTarget, targetConfig } from "../packages/core/targets";
import { buildNative } from "./native";
import { encodePng } from "../packages/core/src/png";

const root = resolve(import.meta.dir, "..");
const { values } = parseArgs({ args: process.argv.slice(2), options: { runtime: { type: "string" } } });
const runtime = values.runtime as "bun" | "node" | "txiki" | undefined;
const hostTarget = hostBuildTarget();
if (!hostTarget) throw new Error(`Standalone smoke is not supported for ${process.platform}-${process.arch}`);
const hostConfig = targetConfig(hostTarget);
await mkdir(join(root, "work"), { recursive: true });
const directory = await mkdtemp(join(root, "work/exe smoke "));
const executable = join(directory, `Tarve${hostConfig.executableSuffix}`);
const nativeLibrary = await buildNative(true);
// App metadata: icon, version details and app id reach the executable (Windows) or a desktop entry (Linux).
const iconDirectory = await mkdtemp(join(root, "work/exe smoke icon "));
const icon = join(iconDirectory, "icon.png");
await writeFile(icon, encodePng(new Uint8Array(256 * 256 * 4).map((_, i) => (i % 4 === 1 ? 0 : 220)), 256, 256));
await build({
  entrypoint: join(root, "scripts/exe-smoke-entry.ts"), outfile: executable, nativeLibrary, name: "Tarve verification",
  version: "1.2.3", description: "Tarve smoke executable", publisher: "Tarve", copyright: "© Tarve", icon, appId: "Tarve.Verification",
  runtime,
});
const expectedFiles = process.platform === "win32"
  ? [`Tarve${hostConfig.executableSuffix}`]
  : [`Tarve${hostConfig.executableSuffix}`, "Tarve.Verification.desktop", "Tarve.Verification.png"].sort();
assert.deepEqual((await readdir(directory)).sort(), expectedFiles, "The distribution must contain only the standalone executable (and, on Linux, its desktop entry)");
if (process.platform === "win32") {
  // The Bun executable keeps a section after its resources, which resedit cannot read: ask Windows.
  const script = [
    "Add-Type -AssemblyName System.Drawing",
    `$v = (Get-Item -LiteralPath '${executable.replaceAll("'", "''")}').VersionInfo`,
    `$i = [System.Drawing.Icon]::ExtractAssociatedIcon('${executable.replaceAll("'", "''")}').ToBitmap()`,
    "$c = $i.GetPixel(16, 16)",
    "@{ description = $v.FileDescription; company = $v.CompanyName; copyright = $v.LegalCopyright; version = $v.ProductVersion; pixel = @($c.R, $c.G, $c.B) } | ConvertTo-Json -Compress",
  ].join("; ");
  const probe = Bun.spawnSync(["powershell", "-NoProfile", "-NonInteractive", "-Command", script], { stdout: "pipe", stderr: "pipe" });
  const details = JSON.parse(probe.stdout.toString()) as { description: string; company: string; copyright: string; version: string; pixel: number[] };
  assert.equal(details.description, "Tarve smoke executable");
  assert.equal(details.company, "Tarve");
  assert.equal(details.copyright, "© Tarve");
  assert.match(details.version, /^1\.2\.3/);
  // Windows scales the 32 px entry, so allow rounding.
  assert.ok([220, 0, 220].every((value, index) => Math.abs(details.pixel[index]! - value) <= 3), `the executable's icon is the app icon (got ${details.pixel})`);
}
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
  console.log(JSON.stringify({ ...report, standalone: true, runtime: runtime ?? "bun", reportPath }, null, 2));
} finally {
  clearTimeout(timeout);
}
