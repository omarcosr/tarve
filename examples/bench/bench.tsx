// Benchmark app for `bun run bench:compare`. Compile it per version with
// `tarve build bench.tsx` from that checkout's examples/ directory; SCENE picks empty,
// fixed (2,000-row list), updates (the same list re-rendered every tick) or components,
// R picks the renderer.
const t0 = performance.now();
import { execFile } from "node:child_process";
import { setTimeout as sleep } from "node:timers/promises";
import { promisify } from "node:util";
import { Button, Column, Row, Scroll, Text, Window, createApp, type Renderer } from "@tarve/core";
import { App as ComponentsApp } from "../components/components-view";
import { lucideReactAdapter, phosphorReactAdapter, reactSvgAdapter } from "@tarve/react-icons";
const tImport = performance.now();
const scene = process.env.SCENE ?? "empty";
const renderer = (process.env.R ?? "auto") as Renderer;
function Empty() { return <Window title="bench" width={800} height={600}><Text>hi</Text></Window>; }
let tick = 0;
function Fixed() {
  return <Window title="bench" width={1024} height={760}><Column padding={16} gap={12} flex={1}>{scene === "updates" && <Text>Tick {tick}</Text>}<Scroll id="list" flex={1}><Column>
    {Array.from({ length: 2000 }, (_, i) => <Row key={i} style={{ height: 36, shrink: 0 }} gap={12}><Text style={{ flex: 1 }}>Record {i}: native layout and text</Text><Button size="sm">Open</Button></Row>)}
  </Column></Scroll></Column></Window>;
}
const View = scene === "fixed" || scene === "updates" ? Fixed : scene === "components" ? ComponentsApp : Empty;
const app = createApp(View, { debug: true, renderer, componentAdapters: [reactSvgAdapter, lucideReactAdapter, phosphorReactAdapter] });
await app.ready;
let s = await app.inspect();
while (s.frames === 0) { await sleep(1); s = await app.inspect(); }
const tFrame = performance.now();
const r = Math.round;
const mb = (x: number) => r(x / 1048576);
const ps = async (cmd: string) => (await promisify(execFile)("powershell", ["-NoProfile", "-Command", cmd], { windowsHide: true })).stdout.trim();
const cpu = () => { const u = process.cpuUsage(); return (u.user + u.system) / 1000; };
const out: Record<string, unknown> = { scene, renderer, importsMs: r(tImport - t0), firstFrameMs: r(tFrame) };
await sleep(3000);
out.privateMb = mb(Number(await ps(`(Get-Process -Id ${process.pid}).PrivateMemorySize64`)));
out.wsMb = mb(process.memoryUsage().rss);
let f0 = (await app.inspect()).frames, c0 = cpu(), w0 = performance.now();
await sleep(4000);
out.idleCpuPct = +((cpu() - c0) / (performance.now() - w0) * 100).toFixed(2);
out.idleFrames = (await app.inspect()).frames - f0;
const cx = s.width / 2, cy = s.height / 2;
f0 = (await app.inspect()).frames; c0 = cpu(); w0 = performance.now();
let peak = 0;
for (let i = 0; i < 240; i++) {
  app.debug({ type: "input", action: "wheel", delta: i % 80 < 40 ? 60 : -60 });
  app.debug({ type: "input", action: "move", x: cx + Math.sin(i / 7) * cx * 0.8, y: cy + Math.cos(i / 9) * cy * 0.6 });
  if (scene === "updates") { tick++; app.update(); }
  await sleep(16);
  if (i % 20 === 0) peak = Math.max(peak, process.memoryUsage().rss);
}
out.busyCpuPct = +((cpu() - c0) / (performance.now() - w0) * 100).toFixed(1);
out.busyFrames = (await app.inspect()).frames - f0;
out.wsPeakMb = mb(peak);
// Phase percentiles of the busy run (app.stats() is missing on builds older than it).
if (typeof app.stats === "function") {
  const { js, native } = await app.stats();
  const ms = (summary: { p50: number; p95: number; p99: number } | undefined) => summary && [summary.p50, summary.p95, summary.p99];
  Object.assign(out, {
    jsUpdateMs: ms(js.update), jsRenderMs: ms(js.render), jsDiffMs: ms(js.diff),
    applyMs: ms(native.phases?.apply), layoutMs: ms(native.phases?.layout), paintMs: ms(native.phases?.paint),
    presentMs: ms(native.phases?.present), frameMs: ms(native.phases?.frame),
    memoryStages: Object.fromEntries((native.memory?.stages ?? []).map(stage => [stage.label, stage.workingSetMb])),
  });
}
out.gpuDedicatedMb = Number(await ps(`[math]::Round(((Get-Counter '\\GPU Process Memory(pid_${process.pid}_*)\\Dedicated Usage' -ErrorAction SilentlyContinue).CounterSamples | Measure-Object CookedValue -Sum).Sum / 1MB)`)) || 0;
console.log(JSON.stringify(out));
app.close();
process.exit(0);
