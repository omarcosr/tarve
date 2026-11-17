// FFI call cost on every runtime: runs scripts/bench-ffi-entry.ts under Bun, then built as a Node.js
// and a txiki.js executable, and prints ns/call through Tarve's loadLibrary and through the
// runtime's own FFI. TARVE_BENCH_FFI_CALLS sets the calls per timed loop (default 100000).
//
//   bun run bench:ffi
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { build } from "../packages/core/build";
import { nativePath } from "../packages/core/src/bridge/runtime";

interface Report { runtime: string; calls: number; pid: number[]; "ns/call": Record<"tarve" | "raw", Record<string, number>> }

const root = resolve(import.meta.dir, "..");
const entry = join(root, "scripts/bench-ffi-entry.ts");
const directory = await mkdtemp(join(root, "work/bench ffi "));
try {
  const nativeLibrary = nativePath();
  const run = async (name: string, command: string[]) => {
    const file = join(directory, `${name}.json`);
    const child = Bun.spawn([...command, file], { stdout: "inherit", stderr: "inherit", env: { ...process.env, TARVE_NATIVE: nativeLibrary } });
    if (await child.exited !== 0) throw new Error(`bench:ffi: ${name} exited with ${child.exitCode}`);
    return JSON.parse(await readFile(file, "utf8")) as Report;
  };
  const reports: Report[] = [await run("bun", ["bun", entry])];
  for (const runtime of ["node", "txiki"] as const) {
    const executable = join(directory, `bench-ffi-${runtime}${process.platform === "win32" ? ".exe" : ""}`);
    await build({ entrypoint: entry, outfile: executable, runtime, nativeLibrary });
    reports.push(await run(runtime, [executable]));
  }
  for (const report of reports) {
    if (new Set(report.pid).size !== 1) throw new Error(`bench:ffi: ${report.runtime} pids disagree: ${report.pid.join(", ")}`);
  }
  const rows = Object.keys(reports[0]!["ns/call"].tarve).map(name => {
    const row: Record<string, string | number> = { "ns/call": name };
    for (const report of reports) {
      const { tarve, raw } = report["ns/call"];
      row[`${report.runtime} tarve`] = tarve[name]!;
      row[`${report.runtime} raw`] = raw[name]!;
      row[`${report.runtime} wrapper`] = Math.round((tarve[name]! - raw[name]!) * 10) / 10;
    }
    return row;
  });
  console.log(`bench:ffi: best of 5 loops of ${reports[0]!.calls} calls (tick: per tick)`);
  console.table(rows);
} finally {
  await rm(directory, { recursive: true, force: true });
}
