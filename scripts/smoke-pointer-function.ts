// pointerFunction on every runtime: runs scripts/pointer-function-entry.ts under Bun (the reference),
// then built as a Node.js and a txiki.js executable, and compares what each reports.
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { build } from "../packages/core/build";
import { buildNative } from "./native";

const root = resolve(import.meta.dir, "..");
const entry = join(root, "scripts/pointer-function-entry.ts");
const directory = await mkdtemp(join(root, "work/pointer function "));
try {
  const nativeLibrary = await buildNative(true);
  const run = async (name: string, command: string[]) => {
    const report = join(directory, `${name}.json`);
    const child = Bun.spawn([...command, report], { stdout: "inherit", stderr: "inherit", env: { ...process.env, TARVE_NATIVE: nativeLibrary } });
    if (await child.exited !== 0) throw new Error(`pointerFunction smoke: ${name} exited with ${child.exitCode}`);
    return JSON.parse(await readFile(report, "utf8")) as Record<string, unknown>;
  };
  const reference = await run("bun", ["bun", entry]);
  const reports: Record<string, Record<string, unknown>> = { bun: reference };
  for (const runtime of ["node", "txiki"] as const) {
    const executable = join(directory, `pointer-${runtime}${process.platform === "win32" ? ".exe" : ""}`);
    await build({ entrypoint: entry, outfile: executable, runtime, nativeLibrary });
    reports[runtime] = await run(runtime, [executable]);
  }
  console.log(JSON.stringify(reports, null, 2));
  const expected = JSON.stringify(reference);
  const differing = Object.entries(reports).filter(([, report]) => JSON.stringify(report) !== expected).map(([name]) => name);
  if (differing.length) {
    console.error(`pointerFunction differs from Bun on: ${differing.join(", ")}`);
    process.exit(1);
  }
  console.log("pointerFunction: Bun, Node.js and txiki.js agree");
} finally {
  await rm(directory, { recursive: true, force: true });
}
