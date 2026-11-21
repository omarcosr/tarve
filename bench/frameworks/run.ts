/**
 * Cross-framework GUI benchmark (Windows). Builds are made by build.ts; this runs the harness
 * (harness/, measures every app from the outside the same way) over every app and scene,
 * RUNS times each, interleaved by run so slow drifts hit every app alike, and writes
 * work/frameworks/results.json (medians) + results.jsonl (every run) + shots/ (first run).
 *
 *   bun bench/frameworks/run.ts            RUNS=5 SCENES=empty,list APPS=electron,tauri
 */
import { appendFileSync, mkdirSync, readdirSync, statSync, existsSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";

const root = resolve(import.meta.dir, "../..");
const work = join(root, "work/frameworks");
const fw = join(root, "bench/frameworks");
const harness = join(work, "h.exe");
const cargo = join(work, "cargo-target/release");

interface App { name: string; exe: string; args?: string[]; env?: Record<string, string>; ship: string[] }
const electronDist = join(fw, "electron/node_modules/electron/dist");
const apps: App[] = [
  { name: "tarve-bun", exe: join(work, "tarve-bun/bench.exe"), ship: [join(work, "tarve-bun/bench.exe")] },
  { name: "tarve-bun-lowpower", exe: join(work, "tarve-bun/bench.exe"), env: { LOWPOWER: "1" }, ship: [join(work, "tarve-bun/bench.exe")] },
  { name: "tarve-node", exe: join(work, "tarve-node/bench.exe"), ship: [join(work, "tarve-node/bench.exe")] },
  { name: "tarve-node-lowpower", exe: join(work, "tarve-node/bench.exe"), env: { LOWPOWER: "1" }, ship: [join(work, "tarve-node/bench.exe")] },
  { name: "tarve-txiki", exe: join(work, "tarve-txiki/bench.exe"), ship: [join(work, "tarve-txiki/bench.exe")] },
  { name: "tarve-txiki-lowpower", exe: join(work, "tarve-txiki/bench.exe"), env: { LOWPOWER: "1" }, ship: [join(work, "tarve-txiki/bench.exe")] },
  { name: "electron", exe: join(electronDist, "electron.exe"), args: [join(fw, "electron")], ship: [electronDist, join(fw, "electron/main.js"), join(fw, "electron/package.json"), join(fw, "electron/dist")] },
  { name: "tauri", exe: join(fw, "tauri/target/release/bench-tauri.exe"), ship: [join(fw, "tauri/target/release/bench-tauri.exe")] },
  { name: "flutter", exe: join(fw, "flutter/build/windows/x64/runner/Release/bench_flutter.exe"), ship: [join(fw, "flutter/build/windows/x64/runner/Release")] },
  { name: "dioxus-native", exe: join(cargo, "bench-dioxus-native.exe"), ship: [join(cargo, "bench-dioxus-native.exe")] },
  { name: "egui", exe: join(cargo, "bench-egui.exe"), ship: [join(cargo, "bench-egui.exe")] },
];
const only = process.env.APPS?.split(",");
const selected = apps.filter(app => !only || only.includes(app.name));
const scenes = (process.env.SCENES ?? "empty,list").split(",");
const runs = Number(process.env.RUNS ?? 5);

function size(path: string): number {
  const st = statSync(path);
  return st.isDirectory() ? readdirSync(path).reduce((sum, entry) => sum + size(join(path, entry)), 0) : st.size;
}
/** Deflate zip of what ships (Windows tar), the download size. */
function zipped(app: App): number {
  const stage = join(work, "zip", app.name);
  rmSync(stage, { recursive: true, force: true });
  mkdirSync(stage, { recursive: true });
  const out = join(work, "zip", app.name + ".zip");
  rmSync(out, { force: true });
  const parts = app.ship.flatMap(path => statSync(path).isDirectory() ? ["-C", path, "."] : ["-C", join(path, ".."), path.split(/[\\/]/).pop()!]);
  const r = Bun.spawnSync(["tar", "-a", "-c", "-f", out, ...parts]);
  if (r.exitCode !== 0) throw new Error(r.stderr.toString());
  return statSync(out).size;
}

mkdirSync(join(work, "shots"), { recursive: true });
const mb = (bytes: number) => Math.round(bytes / 1048576 * 10) / 10;
const disk: Record<string, { mb: number; zipMb: number }> = {};
for (const app of selected) {
  if (!existsSync(app.exe)) throw new Error("missing build: " + app.exe);
  const key = app.ship.join("|");
  const same = Object.entries(disk).find(([name]) => selected.find(a => a.name === name)!.ship.join("|") === key);
  disk[app.name] = same ? same[1] : { mb: mb(app.ship.reduce((sum, path) => sum + size(path), 0)), zipMb: mb(zipped(app)) };
}
console.log(disk);

const all: Record<string, unknown>[] = [];
const jsonl = join(work, "results.jsonl");
rmSync(jsonl, { force: true });
for (let run = 0; run < runs; run++) for (const scene of scenes) for (const app of selected) {
  const env: Record<string, string> = { ...process.env as Record<string, string>, ...app.env };
  delete env.SHOT;
  if (run === 0) env.SHOT = join(work, "shots", `${app.name}-${scene}.bmp`);
  const proc = Bun.spawnSync([harness, scene, app.exe, ...(app.args ?? [])], { env, stdout: "pipe", stderr: "pipe" });
  const line = proc.stdout.toString().trim().split("\n").pop() ?? "";
  let result: Record<string, unknown>;
  try { result = JSON.parse(line); } catch { result = { error: line || proc.stderr.toString().slice(-300) }; }
  const row = { app: app.name, scene, run, at: new Date().toISOString(), ...result };
  all.push(row);
  appendFileSync(jsonl, JSON.stringify(row) + "\n");
  console.log(JSON.stringify(row));
  await Bun.sleep(1500);
}

const median = (values: number[]) => { const v = values.filter(Number.isFinite).sort((a, b) => a - b); return v.length ? v[Math.floor((v.length - 1) / 2)]! : null; };
const get = (row: Record<string, any>, path: string) => path.split(".").reduce((value, key) => value?.[key], row) as number;
const metrics = ["firstWindowMs", "firstFrameMs", "idle.privateMb", "idle.privateWsMb", "idle.wsMb", "idle.threads", "idle.handles", "idle.procs", "idleCpuPct", "machineBusyPct", "gpuDedicatedMb", "gpuSharedMb", "busyCpuPct", "busyGpu3dPct", "updateMs.p50", "updateMs.p95", "updateMs.max", "updateMs.misses", "peakPrivateMb", "peakWsMb", "after.privateMb", "after.privateWsMb"];
const summary = selected.flatMap(app => scenes.map(scene => {
  const rows = all.filter(row => row.app === app.name && row.scene === scene && !row.error);
  const out: Record<string, unknown> = { app: app.name, scene, runs: rows.length, errors: all.filter(row => row.app === app.name && row.scene === scene && row.error).map(row => row.error), diskMb: disk[app.name]!.mb, zipMb: disk[app.name]!.zipMb };
  if (scene === "list") out.scrolledAll = rows.every(row => row.scrolled === true);
  for (const metric of metrics) out[metric] = median(rows.map(row => get(row, metric)));
  return out;
}));
await Bun.write(join(work, "results.json"), JSON.stringify({ at: new Date().toISOString(), runs, summary }, null, 2));
console.table(summary.map(row => Object.fromEntries(["app", "scene", "diskMb", "zipMb", "firstFrameMs", "idle.privateMb", "idle.privateWsMb", "busyCpuPct", "updateMs.p50"].map(key => [key, row[key]]))));
