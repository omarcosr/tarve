/**
 * Compares compiled benchmark executables (built from examples/bench/bench.tsx)
 * scene by scene: first frame, memory, idle and busy CPU, frames.
 *
 *   (cd examples && bun run tarve build bench/bench.tsx --outfile ../work/bench-head.exe)
 *   bun run bench:compare work/bench-old.exe work/bench-head.exe
 *
 * SCENES=fixed,updates,components limits the scenes; RUNS sets the runs per cell
 * (default 3, the median is reported).
 * SCENES=boxes,text,list runs the stress scenes (see examples/bench/bench.tsx).
 *
 * Every run is appended to HISTORY (default work/bench-history.jsonl; HISTORY=0 skips it),
 * named by LABEL="what changed", and each row is compared with the previous and the best
 * run of the same executable name, scene and renderer: "Δ last" and "Δ best" per metric,
 * lower is better, changes within ±5% shown as "≈". Keep a change when the numbers climb.
 */
import { appendFile, mkdir } from "node:fs/promises";
import { dirname } from "node:path";

const exes = process.argv.slice(2);
if (exes.length === 0) throw new Error("usage: bun run bench:compare <bench.exe> [<bench.exe> …]");
const scenes = (process.env.SCENES ?? "empty,fixed,components").split(",");
const renderers = (process.env.RENDERERS ?? "cpu,auto").split(",");
const runs = Number(process.env.RUNS ?? 3);
const keys = ["firstFrameMs", "privateMb", "wsMb", "wsPeakMb", "idleCpuPct", "idleFrames", "busyCpuPct", "busyFrames", "gpuDedicatedMb"] as const;
/** [p50, p95, p99] milliseconds from app.stats(); absent on older builds. */
const phaseKeys = ["jsUpdateMs", "applyMs", "layoutMs", "paintMs", "presentMs", "frameMs"] as const;
const median = (values: number[]) => [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)]!;
const rows: Record<string, unknown>[] = [];
for (const scene of scenes) for (const renderer of renderers) for (const exe of exes) {
  const samples: Record<string, number>[] = [];
  for (let run = 0; run < runs; run++) {
    const child = Bun.spawn([exe], { env: { ...process.env, SCENE: scene, R: renderer }, stdout: "pipe", stderr: "pipe" });
    const line = (await new Response(child.stdout).text()).split(/\r?\n/).find(text => text.startsWith("{"));
    if (line) samples.push(JSON.parse(line));
    else console.error(`${exe} ${scene} ${renderer}: ${(await new Response(child.stderr).text()).slice(-400)}`);
    await Bun.sleep(1500);
  }
  if (samples.length === 0) continue;
  const row: Record<string, unknown> = { exe: exe.split(/[\\/]/).pop(), scene, renderer };
  for (const key of keys) row[key] = median(samples.map(sample => Number(sample[key])));
  for (const key of phaseKeys) {
    const values = samples.map(sample => (sample as Record<string, unknown>)[key]).filter(Array.isArray) as number[][];
    if (values.length) row[key] = [0, 1, 2].map(index => median(values.map(value => value[index]!))).join("/");
  }
  rows.push(row);
  console.log(JSON.stringify(row));
}
console.table(rows);
if (process.env.HISTORY !== "0") await recordHistory(rows, process.env.HISTORY ?? "work/bench-history.jsonl", process.env.LABEL ?? "");

/** Lower is better for every tracked metric; phase metrics compare their p50. */
const trackedKeys = ["firstFrameMs", "privateMb", "idleCpuPct", "busyCpuPct", "minCpuPct", "gpuMb", "jsUpdateMs", "layoutMs", "paintMs", "frameMs"] as const;
function metric(row: Record<string, unknown>, key: string): number | undefined {
  const value = row[key];
  const number = typeof value === "string" ? Number(value.split("/")[0]) : typeof value === "number" ? value : NaN;
  return Number.isFinite(number) ? number : undefined;
}
function delta(now: number | undefined, then: number | undefined): string {
  if (now === undefined || then === undefined) return "";
  if (then === 0) return now === 0 ? "≈" : "new";
  const percent = (now - then) / Math.abs(then) * 100;
  return Math.abs(percent) <= 5 ? "≈" : `${percent > 0 ? "+" : ""}${percent.toFixed(0)}%`;
}
async function recordHistory(current: Record<string, unknown>[], path: string, label: string): Promise<void> {
  const file = Bun.file(path);
  const past: Record<string, unknown>[] = (await file.exists() ? await file.text() : "").split("\n").filter(Boolean).map(line => JSON.parse(line));
  const id = (row: Record<string, unknown>) => `${row.exe}|${row.scene}|${row.renderer}`;
  const comparison = current.map(row => {
    const same = past.filter(entry => id(entry) === id(row));
    const last = same.at(-1);
    const out: Record<string, unknown> = { scene: row.scene, renderer: row.renderer, exe: row.exe };
    for (const key of trackedKeys) {
      const now = metric(row, key);
      if (now === undefined) continue;
      const values = same.map(entry => metric(entry, key)).filter((value): value is number => value !== undefined);
      out[key] = `${now} (last ${delta(now, last && metric(last, key)) || "-"}, best ${delta(now, values.length ? Math.min(...values) : undefined) || "-"})`;
    }
    return out;
  });
  if (past.length) console.table(comparison);
  const commit = Bun.spawnSync(["git", "rev-parse", "--short", "HEAD"]).stdout.toString().trim();
  const at = new Date().toISOString();
  const lines = current.map(row => JSON.stringify({ at, label, commit, ...row })).join("\n") + "\n";
  await mkdir(dirname(path), { recursive: true });
  await appendFile(path, lines);
  console.log(`history: ${current.length} row(s) → ${path}${label ? ` (${label})` : ""}`);
}
