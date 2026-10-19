// Runs the Go and TypeScript twins of the same benchmark and prints them side by side.
// bun go/bench/compare.ts [scene=updates] [renderer=auto] [runs=3]
import { spawnSync } from "node:child_process";
import { join } from "node:path";

const [scene = "updates", renderer = "auto", runs = "3"] = process.argv.slice(2);
const root = join(import.meta.dirname, "..", "..");
const goExe = join(root, "go", "bin", process.platform === "win32" ? "bench.exe" : "bench");
const build = spawnSync("go", ["build", "-o", "bin/", "./examples/bench"], { cwd: join(root, "go"), stdio: "inherit" });
if (build.status !== 0) process.exit(build.status ?? 1);

const env = { ...process.env, SCENE: scene, R: renderer };
const targets: Record<string, [string, string[]]> = {
  go: [goExe, []],
  bun: [process.execPath, [join(import.meta.dirname, "ts-bench.tsx")]],
};
type Result = Record<string, number | number[] | string>;
const results: Record<string, Result[]> = {};
for (let run = 0; run < Number(runs); run++) {
  for (const [name, [command, args]] of Object.entries(targets)) {
    const child = spawnSync(command, args, { cwd: root, env, encoding: "utf8", timeout: 120_000 });
    const line = child.stdout.split(/\r?\n/).find(l => l.startsWith("@result "));
    if (!line) { console.error(name, "failed:", child.stderr || child.stdout); process.exit(1); }
    (results[name] ??= []).push(JSON.parse(line.slice(8)));
  }
}
const median = (values: number[]) => values.sort((a, b) => a - b)[values.length >> 1];
const keys = ["firstFrameMs", "idleWorkingSetMb", "idlePrivateMb", "busyWorkingSetMb", "busyPrivateMb", "busyFrames",
  "hostRenderMs", "hostDiffMs", "hostUpdateMs", "applyMs", "layoutMs", "paintMs", "frameMs"];
const cell = (rows: Result[], key: string) => {
  const values = rows.map(row => row[key]).filter(v => v !== undefined);
  if (!values.length) return "-";
  if (Array.isArray(values[0])) return [0, 1].map(i => median(values.map(v => (v as number[])[i])).toFixed(2)).join(" / ");
  return String(Math.round(median(values as number[])));
};
console.log(`scene=${scene} renderer=${renderer} runs=${runs} (median; arrays are p50 / p95)`);
console.log("metric".padEnd(18) + Object.keys(results).map(n => n.padStart(18)).join(""));
for (const key of keys) console.log(key.padEnd(18) + Object.values(results).map(rows => cell(rows, key).padStart(18)).join(""));
