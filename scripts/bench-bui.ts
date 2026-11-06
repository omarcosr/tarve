/**
 * Tarve vs BUI (blenderui, github.com/ppmpreetham/BUI) on BUI's own benchmark scene:
 * N animated cells in a 1000×800 window, modes anim / one / idle (see examples/bench/cells.tsx
 * and BUI's bindings/rust/bench/README.md).
 *
 *   (cd examples && bun run tarve build bench/cells.tsx --outfile ../work/bench-cells.exe)
 *   (cd BUI/bindings/rust/bench && cargo build --release -p bui-bench)
 *   BUI=path/to/bui-bench.exe bun scripts/bench-bui.ts
 *
 * CELLS=100,1000,3000  MODES=anim,one,idle  APPS=tarve-cpu,tarve-gpu,bui-cpu,bui-gpu  REPS=1
 * (tarve-txiki-cpu / tarve-txiki-gpu run TARVE_TXIKI, default work/bench-cells-txiki.exe;
 * tarve[-txiki]-signals-* bind each cell to signals, as BUI's JS bench sets DOM nodes)
 * TARVE=work/bench-cells.exe  JSON=path writes the rows.
 *
 * Each app reports its own frames and first frame (Tarve from process start, Bun's boot
 * included; BUI from its `main()`). CPU and memory are sampled from outside,
 * the same way for every app: process cycles (QueryProcessCycleTime, all threads, converted
 * with the nominal clock) and the working set every 200 ms over the measured window.
 */
const tarve = process.env.TARVE ?? "work/bench-cells.exe";
/** `tarve-txiki-cpu` / `tarve-txiki-gpu`: the same app built with `--runtime txiki`. */
const tarveTxiki = process.env.TARVE_TXIKI ?? "work/bench-cells-txiki.exe";
/**
 * BUI from JavaScript (@blender-ui/native, BUI's own bindings/node/bench/cells.js):
 * `bui-js-<runtime>[-react[-signals]]-<cpu|gpu>`, runtime bun, node, bunexe or qjs: the last two run
 * bench/cells-bun.exe and bench/cells-qjs.exe (`node cli.js build bench/cells.js -o … --console [--bun]`).
 * BUI_JS is the bindings/node directory, with the addon and bui-runtime built.
 */
const buiJs = process.env.BUI_JS;
const bui = process.env.BUI ?? "";
if (!bui) throw new Error("set BUI=path/to/bui-bench.exe");
const cellCounts = (process.env.CELLS ?? "100,1000,3000").split(",").map(Number);
const modes = (process.env.MODES ?? "anim,one,idle").split(",");
const apps = (process.env.APPS ?? "tarve-cpu,tarve-gpu,bui-cpu,bui-gpu").split(",");
const reps = Number(process.env.REPS ?? 1);
const warmup = 3, seconds = 10;

const probe = Bun.spawn(["powershell", "-NoProfile", "-Command", [
  "Add-Type -TypeDefinition 'using System; using System.Runtime.InteropServices; public static class P { [DllImport(\"kernel32.dll\")] public static extern IntPtr OpenProcess(uint a, bool i, int id); [DllImport(\"kernel32.dll\")] public static extern bool QueryProcessCycleTime(IntPtr h, out ulong c); [DllImport(\"kernel32.dll\")] public static extern bool CloseHandle(IntPtr h); }'",
  "$mhz = (Get-ItemProperty 'HKLM:\\HARDWARE\\DESCRIPTION\\System\\CentralProcessor\\0').'~MHz'",
  "[Console]::Out.WriteLine(\"$mhz\"); [Console]::Out.Flush()",
  "$in = [Console]::In",
  "while (($line = $in.ReadLine()) -ne $null) {",
  "  $p = Get-Process -Id $line -ErrorAction SilentlyContinue",
  "  if ($p) { $h = [P]::OpenProcess(0x1000, $false, [int]$line); $c = [uint64]0; [void][P]::QueryProcessCycleTime($h, [ref]$c); [void][P]::CloseHandle($h); [Console]::Out.WriteLine(\"$c $($p.WorkingSet64) $($p.PrivateMemorySize64)\") } else { [Console]::Out.WriteLine('x') }",
  "  [Console]::Out.Flush()",
  "}",
].join("\n")], { stdin: "pipe", stdout: "pipe", stderr: "inherit" });
const probeLines = lines(probe.stdout);
const hz = Number((await probeLines.next()).value) * 1e6;
let queue = Promise.resolve();
interface Sample { cycles: number; ws: number; priv: number; at: number }
function sample(pid: number): Promise<Sample | undefined> {
  const answer = queue.then(async () => {
    const at = performance.now();
    probe.stdin.write(`${pid}\n`);
    probe.stdin.flush();
    const line = (await probeLines.next()).value ?? "x";
    if (line === "x") return undefined;
    const [cycles, ws, priv] = line.split(" ").map(Number);
    return { cycles: cycles!, ws: ws!, priv: priv!, at };
  });
  queue = answer.then(() => undefined);
  return answer;
}
async function* lines(stream: ReadableStream<Uint8Array>): AsyncGenerator<string> {
  const decoder = new TextDecoder();
  let buffer = "";
  for await (const chunk of stream) {
    buffer += decoder.decode(chunk, { stream: true });
    let index: number;
    while ((index = buffer.indexOf("\n")) >= 0) {
      yield buffer.slice(0, index).replace(/\r$/, "");
      buffer = buffer.slice(index + 1);
    }
  }
  if (buffer) yield buffer;
}

async function run(app: string, cells: number, mode: string): Promise<Record<string, unknown> | undefined> {
  const gpu = app.endsWith("-gpu");
  const js = app.startsWith("bui-js-");
  if (js && !buiJs) throw new Error("set BUI_JS=path/to/BUI/bindings/node");
  const jsArgs = [`bench/cells.js`, String(cells), `--seconds=${seconds}`, ...(gpu ? ["--gpu"] : []),
    ...(mode === "anim" ? ["--anim"] : []), ...(app.includes("-react") ? ["--react"] : []), ...(app.includes("-signals") ? ["--signals"] : [])];
  // Executables built from bench/cells.js with `bui build` (QuickJS) and `bui build --bun`,
  // as Tarve's are with `tarve build` (Bun) and `--runtime txiki` (QuickJS).
  const exeArgs = jsArgs.slice(1);
  const jsCommand = app.startsWith("bui-js-node") ? ["node", ...jsArgs]
    : app.startsWith("bui-js-qjs") ? [`${buiJs}/bench/cells-qjs.exe`, ...exeArgs]
    : app.startsWith("bui-js-bunexe") ? [`${buiJs}/bench/cells-bun.exe`, ...exeArgs]
    : ["bun", ...jsArgs];
  const child = js
    ? Bun.spawn(jsCommand, { cwd: buiJs, env: { ...process.env, NODE_ENV: "production" }, stdout: "pipe", stderr: "pipe" })
    : app.startsWith("tarve")
    ? Bun.spawn([app.includes("txiki") ? tarveTxiki : tarve], { env: { ...process.env, CELLS: String(cells), MODE: mode, R: gpu ? "gpu" : "cpu", WARMUP: String(warmup), SECONDS: String(seconds), SIGNALS: app.includes("-signals") ? "1" : "0" }, stdout: "pipe", stderr: "pipe" })
    : Bun.spawn([bui, "--cells", String(cells), "--mode", mode, "--warmup", String(warmup), "--seconds", String(seconds)], { env: { ...process.env, BUI_GPU: gpu ? "1" : "0" }, stdout: "pipe", stderr: "pipe" });
  let start: Sample | undefined, end: Sample | undefined, sampling = false, report: Record<string, unknown> | undefined;
  const ws: number[] = [];
  const begin = async () => { start = await sample(child.pid); sampling = true; };
  const finish = async () => { sampling = false; end ??= await sample(child.pid); };
  // BUI marks nothing until it exits, so its window is timed from launch (its first frame takes ~5 ms).
  const timers = app.startsWith("bui") ? [setTimeout(begin, (warmup + 0.3) * 1000), setTimeout(finish, (warmup + seconds - 0.2) * 1000)] : [];
  const sampler = setInterval(async () => { if (sampling) { const s = await sample(child.pid); if (s) ws.push(s.ws); } }, 200);
  for await (const line of lines(child.stdout)) {
    if (line === "@mark start") await begin();
    else if (line === "@mark end") await finish();
    else if (line.startsWith("{")) report = JSON.parse(line);
  }
  await finish();
  timers.forEach(clearTimeout);
  clearInterval(sampler);
  await child.exited;
  if (!report || !start || !end) {
    console.error(`${app} ${cells} ${mode}: no result ${(await new Response(child.stderr).text()).slice(-300)}`);
    return undefined;
  }
  const wall = (end.at - start.at) / 1000;
  const cpuMs = (end.cycles - start.cycles) / hz * 1000;
  const fps = Number(report.fps);
  const mb = (bytes: number) => +(bytes / 1048576).toFixed(1);
  return {
    app, cells, mode, fps,
    cpuPct: +(cpuMs / 10 / wall).toFixed(1),
    cpuMsPerFrame: fps > 0.5 ? +(cpuMs / (fps * wall)).toFixed(2) : null,
    wsMb: mb(ws.reduce((a, b) => a + b, 0) / Math.max(1, ws.length)),
    privateMb: mb(end.priv),
    firstFrameMs: report.first_frame_ms === undefined ? null : Number(report.first_frame_ms),
    selfCpuMsPerFrame: report.cpu_ms_per_frame ?? null,
  };
}

const median = (values: number[]) => [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)]!;
const rows: Record<string, unknown>[] = [];
for (const cells of cellCounts) for (const mode of modes) for (const app of apps) {
  const samples: Record<string, unknown>[] = [];
  for (let rep = 0; rep < reps; rep++) {
    const row = await run(app, cells, mode);
    if (row) samples.push(row);
    await Bun.sleep(1000);
  }
  if (!samples.length) continue;
  const row: Record<string, unknown> = { app, cells, mode };
  for (const key of ["fps", "cpuPct", "cpuMsPerFrame", "wsMb", "privateMb", "firstFrameMs", "selfCpuMsPerFrame"]) {
    const values = samples.map(s => s[key]).filter((v): v is number => typeof v === "number");
    row[key] = values.length ? median(values) : null;
  }
  rows.push(row);
  console.log(JSON.stringify(row));
}
probe.stdin.end();
console.table(rows);
if (process.env.JSON) await Bun.write(process.env.JSON, JSON.stringify({ hz, rows }, null, 2));
process.exit(0);
export {};

