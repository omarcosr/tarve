/**
 * Runs bench/render/render.tsx on Bun, Node and txiki.js (built as `tarve build` executables, as
 * apps ship) and prints the median of each phase.
 *   bun bench/render/run.ts           RUNTIMES=bun,txiki ITER=40 ROWS=2000 SHAPE=row|text|button|static
 */
import { join, resolve } from "node:path";

const root = resolve(import.meta.dir, "../..");
const out = join(root, "work/render");
const runtimes = (process.env.RUNTIMES ?? "bun,node,txiki").split(",");
for (const runtime of runtimes) {
  const exe = join(out, `render-${runtime}.exe`);
  const build = Bun.spawnSync(["bun", "run", "tarve", "build", "../bench/render/render.tsx", "--runtime", runtime, "--outfile", exe], { cwd: join(root, "examples"), stdout: "pipe", stderr: "pipe" });
  if (build.exitCode !== 0) { console.error(runtime, build.stderr.toString().slice(-600)); continue; }
  const run = Bun.spawnSync([exe], { env: process.env, stdout: "pipe", stderr: "pipe" });
  console.log(runtime.padEnd(6), run.stdout.toString().trim() || run.stderr.toString().trim().slice(-600));
}
