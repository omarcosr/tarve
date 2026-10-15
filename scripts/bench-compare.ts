/**
 * Compares compiled benchmark executables (built from examples/bench/bench.tsx)
 * scene by scene: first frame, memory, idle and busy CPU, frames.
 *
 *   (cd examples && bun run tarve build bench/bench.tsx --outfile ../work/bench-head.exe)
 *   bun run bench:compare work/bench-old.exe work/bench-head.exe
 *
 * SCENES=fixed,updates,components limits the scenes; RUNS sets the runs per cell
 * (default 3, the median is reported).
 */
export {};

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
