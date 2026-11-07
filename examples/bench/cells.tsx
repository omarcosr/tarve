// The BUI / gpui benchmark scene (github.com/ppmpreetham/BUI, bindings/rust/bench) on Tarve:
// a 1000×800 window filled with CELLS rounded, coloured boxes with a centred number.
// MODE=anim changes every cell's colour and number each frame, MODE=one re-renders the
// whole scene each frame but only cell 0 changes, MODE=idle renders once. R picks the
// renderer (cpu, gpu, auto). Run by scripts/bench-bui.ts, which samples CPU and memory
// from outside the process the same way for every app.
import { Text, View, Window, batch, createApp, memo, signal, type Renderer } from "@tarve/core";

const tImported = performance.now();
const cells = Number(process.env.CELLS ?? 100);
const mode = process.env.MODE ?? "anim";
const renderer = (process.env.R ?? "cpu") as Renderer;
const warmup = Number(process.env.WARMUP ?? 3) * 1000;
const seconds = Number(process.env.SECONDS ?? 10) * 1000;
const width = 1000, height = 800, gap = 2;
const cols = Math.max(1, Math.ceil(Math.sqrt(cells * width / height)));
const rows = Math.ceil(cells / cols);
const w = Math.floor((width - gap) / cols - gap);
const h = Math.floor((height - gap) / rows - gap);
const font = Math.floor(Math.min(14, Math.max(8, ((height - gap) / rows - gap) * 0.55)));

// The colour exactly as BUI's bench/cells.js computes it (the same JS work per frame).
function cellColor(i: number, t: number): string {
  const h = ((i * 7 + t * 3) % 360) / 60, s = 0.55, v = 0.75, c = v * s;
  const x = c * (1 - Math.abs((h % 2) - 1)), m = v - c;
  const [r, g, b] = [[c, x, 0], [x, c, 0], [0, c, x], [0, x, c], [x, 0, c], [c, 0, x]][Math.floor(h) % 6]!;
  const hex = (u: number) => Math.round((u + m) * 255).toString(16).padStart(2, "0");
  return `#${hex(r!)}${hex(g!)}${hex(b!)}`;
}
const tFor = (i: number, t: number) => (mode === "one" && i !== 0 ? 0 : t);
const indexes = Array.from({ length: cells }, (_, i) => i);
let t = 0;

function PlainCell({ i, t }: { i: number; t: number }) {
  return <View style={{ width: w, height: h, background: cellColor(i, t), radius: 3, align: "center", justify: "center" }}>
    <Text style={{ fontSize: font, foreground: "#ffffff" }}>{String((i * 13 + t) % 1000)}</Text>
  </View>;
}
// MEMO=1: each cell is a memo component, re-rendered only when its props change (BUI's
// "React with signals" analogue: the grid does not render again, only the changed cell).
const Cell = process.env.MEMO === "1" ? memo(PlainCell) : PlainCell;

// SIGNALS=1: each cell's colour and label are signals (BUI's DOM / "React with signals"):
// the grid renders once, and a frame sets only the changed signals.
const signals = process.env.SIGNALS === "1";
const colors = signals ? indexes.map(i => signal(cellColor(i, 0))) : [];
const labels = signals ? indexes.map(i => signal(String((i * 13) % 1000))) : [];
function tick(): void {
  if (!signals) { app.update(); return; }
  batch(() => {
    const count = mode === "one" ? 1 : cells;
    for (let i = 0; i < count; i++) {
      colors[i]!.value = cellColor(i, t);
      labels[i]!.value = String((i * 13 + t) % 1000);
    }
  });
}

function Scene() {
  if (signals) return <Window title="tarve-bench" width={width} height={height}>
    <View style={{ flex: 1, direction: "row", wrap: true, alignContent: "start", gap, padding: gap, background: "#303030" }}>
      {indexes.map(i => <View key={i} style={{ width: w, height: h, background: colors[i]!, radius: 3, align: "center", justify: "center" }}>
        <Text style={{ fontSize: font, foreground: "#ffffff" }}>{labels[i]!}</Text>
      </View>)}
    </View>
  </Window>;
  return <Window title="tarve-bench" width={width} height={height}>
    <View style={{ flex: 1, direction: "row", wrap: true, alignContent: "start", gap, padding: gap, background: "#303030" }}>
      {process.env.MEMO === "1"
        ? indexes.map(i => <Cell key={i} i={i} t={tFor(i, t)} />)
        // The whole grid as JSX, re-rendered every frame (React with state).
        : indexes.map(i => <View key={i} style={{ width: w, height: h, background: cellColor(i, tFor(i, t)), radius: 3, align: "center", justify: "center" }}>
          <Text style={{ fontSize: font, foreground: "#ffffff" }}>{String((i * 13 + tFor(i, t)) % 1000)}</Text>
        </View>)}
    </View>
  </Window>;
}

const tCreate = performance.now();
const app = createApp(Scene, { debug: true, renderer });
const tCreated = performance.now();
let firstFrameMs = 0;
// Frames counted from the `frame` events, as BUI's bench counts its requestAnimationFrame
// callbacks: `app.inspect()` would snapshot every node into the measured window.
let framesSeen = 0;
const tickTimes: number[] = [];
// `frame` (debug builds of the window) arrives after each present: the requestAnimationFrame of the scene.
app.onEvent(event => {
  if (event.type !== "frame") return;
  framesSeen++;
  if (!firstFrameMs) firstFrameMs = performance.now();
  if (mode !== "idle") {
    t++;
    const started = performance.now();
    tick();
    // The flush of a signal batch runs in a microtask: time it there.
    queueMicrotask(() => queueMicrotask(() => tickTimes.push(performance.now() - started)));
  }
});
await app.ready;
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
while (!firstFrameMs) await sleep(1);
await sleep(warmup);
console.log("@mark start");
const f0 = framesSeen, w0 = performance.now();
await sleep(seconds);
const frames = framesSeen - f0, wall = performance.now() - w0;
console.log("@mark end");
const { js, native } = await app.stats();
const p50 = (summary: { p50: number } | undefined) => summary?.p50;
// MEMORY=1: where the memory goes (JS heap, native stages and now).
if (process.env.MEMORY === "1") console.log(JSON.stringify({ jsc: await import("bun:jsc").then(jsc => { const s = jsc.heapStats(); return { types: Object.entries(s.objectTypeCounts).sort((a, b) => b[1] - a[1]).slice(0, 16), heapMb: Math.round(s.heapSize / 1048576), capacityMb: Math.round(s.heapCapacity / 1048576), extraMb: Math.round(s.extraMemorySize / 1048576) }; }).catch(() => null), heapUsedMb: js.heapUsedMb, rssMb: Math.round((process.memoryUsage?.()?.rss ?? 0) / 1048576), native: native.memory }));
const phases = { render: p50(js.render), diff: p50(js.diff), shadow: p50(js.shadow), send: p50(js.send), update: p50(js.update), apply: p50(native.phases?.apply), layout: p50(native.phases?.layout), paint: p50(native.phases?.paint), present: p50(native.phases?.present), frame: p50(native.phases?.frame) };
console.log(JSON.stringify({ app: `tarve-${process.env.MEMO === "1" ? "memo-" : ""}${signals ? "signals-" : ""}${renderer}`, cells, mode, fps: +(frames / wall * 1000).toFixed(1), frames, wallMs: Math.round(wall), first_frame_ms: Math.round(firstFrameMs), tickMs: tickTimes.length ? +[...tickTimes].sort((a, b) => a - b)[tickTimes.length >> 1]!.toFixed(2) : 0, startup: { imported: Math.round(tImported), createApp: Math.round(tCreate), started: Math.round(tCreated) }, phases }));
// CAPTURE=<file.png>: the frame as the renderer drew it, to look at.
if (process.env.CAPTURE) await app.capture(process.env.CAPTURE);
app.close();
// TARVE_PROFILE: the window prints the profiler's report as it closes.
if (process.env.TARVE_PROFILE) await sleep(Number(process.env.PROFILE_WAIT ?? 20) * 1000);
process.exit(0);
