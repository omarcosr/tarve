/**
 * Startup, Tarve vs BUI from JavaScript: BUI's own bench (bindings/node/bench/first-frame.js, a
 * small React counter that quits at its first frame) against the same app in Tarve
 * (examples/bench/first-frame.tsx). Each prints `first-frame <ms since runtime start> rss <MB>`.
 *
 *   (cd examples && bun run tarve build bench/first-frame.tsx --outfile ../work/first-frame.exe)
 *   BUI_JS=path/to/BUI/bindings/node bun scripts/bench-bui-startup.ts [runs=12]
 *
 * Medians of `runs` launches after one warm-up launch, plus launch-to-exit wall time.
 */
import { mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const runs = Number(process.argv[2] ?? 12);
const buiJs = process.env.BUI_JS;
if (!buiJs) throw new Error("set BUI_JS=path/to/BUI/bindings/node");
const root = resolve(import.meta.dir, "..");
const buiApp = join(buiJs, "bench", "first-frame.js");
const dir = mkdtempSync(join(tmpdir(), "tarve-startup-"));
const env = { ...process.env, NODE_ENV: "production" };

function buiBuild(args: string[], out: string): string {
  const result = Bun.spawnSync(["node", join(buiJs!, "cli.js"), "build", buiApp, "-o", out, "--console", ...args], { cwd: buiJs });
  if (result.exitCode !== 0) throw new Error(result.stderr.toString());
  return out;
}

const tarveExe = join(root, "work", "first-frame.exe");
// `tarve build bench/first-frame.tsx --runtime txiki`: Tarve on QuickJS, against BUI's QuickJS build.
const tarveTxiki = join(root, "work", "first-frame-txiki.exe");
const variants: [string, string[], Record<string, string>, string | null][] = [
  ["Tarve Bun executable (GPU)", [tarveExe], {}, tarveExe],
  ["Tarve Bun executable (CPU)", [tarveExe], { R: "cpu" }, tarveExe],
  ["Tarve QuickJS executable (txiki, GPU)", [tarveTxiki], {}, tarveTxiki],
  ["Tarve on Bun (bun app.tsx)", ["bun", join(root, "examples", "bench", "first-frame.tsx")], {}, null],
  ["BUI QuickJS executable (bui build)", [buiBuild([], join(dir, "qjs-app.exe"))], {}, "self"],
  ["BUI Bun executable (bui build --bun)", [buiBuild(["--bun"], join(dir, "bun-app.exe"))], {}, "self"],
  ["BUI on Bun (bun app.js)", ["bun", buiApp], {}, null],
  ["BUI on Node.js (node app.js)", ["node", buiApp], {}, null],
];

const median = (values: number[]) => [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)]!;
const rows: Record<string, unknown>[] = [];
for (const [name, command, extra, sized] of variants) {
  const wall: number[] = [], first: number[] = [], rss: number[] = [];
  for (let i = 0; i <= runs; i++) {
    const started = performance.now();
    const result = Bun.spawnSync(command, { env: { ...env, ...extra }, cwd: command[0] === "bun" && command[1]!.includes("examples") ? join(root, "examples") : undefined });
    const ms = performance.now() - started;
    const match = /first-frame ([\d.]+) rss ([\d.]+)/.exec(result.stdout.toString());
    if (!match) throw new Error(`${name}: ${result.stderr.toString() || result.stdout.toString()}`);
    if (i === 0) continue;
    wall.push(ms);
    first.push(Number(match[1]));
    rss.push(Number(match[2]));
  }
  const row = {
    runtime: name,
    firstFrameMs: Math.round(median(first)),
    bestFirstFrameMs: Math.round(Math.min(...first)),
    launchToExitMs: Math.round(median(wall)),
    rssMb: +median(rss).toFixed(1),
    sizeMb: sized ? +(statSync(sized === "self" ? command[0]! : sized).size / 1048576).toFixed(1) : null,
  };
  rows.push(row);
  console.log(JSON.stringify(row));
}
console.table(rows);
if (process.env.JSON) await Bun.write(process.env.JSON, JSON.stringify(rows, null, 2));
rmSync(dir, { recursive: true, force: true });
