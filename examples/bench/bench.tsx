// Benchmark app for `bun run bench:compare`. Compile it per version with
// `tarve build bench.tsx` from that checkout's examples/ directory; SCENE picks empty,
// fixed (2,000-row list), updates (the same list re-rendered every tick), components,
// boxes (600 shadowed boxes changing size and color every tick), text (300 labels whose
// numbers change every tick) or list (a 100,000-row VirtualList); R picks the renderer.
const t0 = performance.now();
import { setTimeout as sleep } from "node:timers/promises";
import { Button, Column, Row, Scroll, Text, View, VirtualList, Window, createApp, type Renderer } from "@tarve/core";
import { App as ComponentsApp } from "../components/components-view";
import { lucideReactAdapter, phosphorReactAdapter, reactSvgAdapter } from "@tarve/react-icons";
const tImport = performance.now();
const scene = process.env.SCENE ?? "empty";
// R=default leaves the renderer to the app's options (lowPower picks cpu).
const renderer = (process.env.R === "default" ? undefined : process.env.R ?? "auto") as Renderer | undefined;
function Empty() { return <Window title="bench" width={800} height={600}><Text>hi</Text></Window>; }
let tick = 0;
function Fixed() {
  return <Window title="bench" width={1024} height={760}><Column padding={16} gap={12} flex={1}>{scene === "updates" && <Text>Tick {tick}</Text>}<Scroll id="list" flex={1}><Column>
    {Array.from({ length: 2000 }, (_, i) => <Row key={i} style={{ height: 36, shrink: 0 }} gap={12}><Text style={{ flex: 1 }}>Record {i}: native layout and text</Text><Button size="sm">Open</Button></Row>)}
  </Column></Scroll></Column></Window>;
}
const color = (i: number) => "#" + [i * 37, i * 91 + 60, i * 53 + 120].map(v => (v % 200 + 40).toString(16).padStart(2, "0")).join("");
function Boxes() {
  return <Window title="bench" width={1024} height={760}><Column padding={8} gap={4}>
    {Array.from({ length: 20 }, (_, row) => <Row key={row} gap={4}>{Array.from({ length: 30 }, (_, col) => {
      const i = row * 30 + col;
      return <View key={col} style={{ width: 24 + (i + tick) % 4 * 2, height: 28, radius: 6, background: color(i + tick), boxShadow: { y: 2, blur: 6, color: "#00000040" } }} />;
    })}</Row>)}
  </Column></Window>;
}
function Labels() {
  return <Window title="bench" width={1024} height={760}><Row padding={8} gap={8}>
    {Array.from({ length: 6 }, (_, col) => <Column key={col} flex={1} gap={2}>{Array.from({ length: 50 }, (_, row) => {
      const i = col * 50 + row;
      return <Text key={row}>Label {i}: {(i * 7919 + tick * 31) % 100000}</Text>;
    })}</Column>)}
  </Row></Window>;
}
const rows = Array.from({ length: 100_000 }, (_, i) => i);
let listOffset = 0;
function List() {
  return <Window title="bench" width={1024} height={760}><Column padding={16} flex={1}>
    <VirtualList id="list" items={rows} itemHeight={28} offset={listOffset} onScroll={offset => { listOffset = offset; app.update(); }}
      renderItem={i => <Row key={i} style={{ height: 28 }} gap={12}><Text style={{ flex: 1 }}>Row {i}: virtualized</Text><Text>{i % 997}</Text></Row>} />
  </Column></Window>;
}
const animated = scene === "updates" || scene === "boxes" || scene === "text";
const SceneView = scene === "fixed" || scene === "updates" ? Fixed : scene === "components" ? ComponentsApp
  : scene === "boxes" ? Boxes : scene === "text" ? Labels : scene === "list" ? List : Empty;
const app = createApp(SceneView, { debug: true, renderer, lowPower: process.env.LOWPOWER === "1", componentAdapters: [reactSvgAdapter, lucideReactAdapter, phosphorReactAdapter] });
await app.ready;
let s = await app.inspect();
while (s.frames === 0) { await sleep(1); s = await app.inspect(); }
const tFrame = performance.now();
const r = Math.round;
// Process numbers come from the parent (bench:compare samples Windows at each mark), so every
// runtime, txiki.js included, is measured the same way.
const mark = async (name: string) => { console.log(`@mark ${name}`); await sleep(600); };
const out: Record<string, unknown> = { scene, renderer, importsMs: r(tImport - t0), firstFrameMs: r(tFrame) };
await sleep(3000);
await mark("idle-start");
let f0 = (await app.inspect()).frames;
await sleep(4000);
await mark("idle-end");
out.idleFrames = (await app.inspect()).frames - f0;
const cx = s.width / 2, cy = s.height / 2;
f0 = (await app.inspect()).frames;
await mark("busy-start");
for (let i = 0; i < 240; i++) {
  app.debug({ type: "input", action: "wheel", delta: i % 80 < 40 ? 60 : -60 });
  app.debug({ type: "input", action: "move", x: cx + Math.sin(i / 7) * cx * 0.8, y: cy + Math.cos(i / 9) * cy * 0.6 });
  if (animated) { tick++; app.update(); }
  await sleep(16);
}
await mark("busy-end");
out.busyFrames = (await app.inspect()).frames - f0;
// Phase percentiles of the busy run (app.stats() is missing on builds older than it).
if (typeof app.stats === "function") {
  const { js, native } = await app.stats();
  const ms = (summary: { p50: number; p95: number; p99: number } | undefined) => summary && [summary.p50, summary.p95, summary.p99];
  Object.assign(out, {
    jsUpdateMs: ms(js.update), jsRenderMs: ms(js.render), jsDiffMs: ms(js.diff),
    applyMs: ms(native.phases?.apply), layoutMs: ms(native.phases?.layout), paintMs: ms(native.phases?.paint),
    presentMs: ms(native.phases?.present), frameMs: ms(native.phases?.frame),
    gpuMb: (native.memory?.current as { gpuMb?: number } | undefined)?.gpuMb,
    memoryStages: Object.fromEntries((native.memory?.stages ?? []).map(stage => [stage.label, stage.workingSetMb])),
  });
}
// Minimized: what an app left in the taskbar costs.
if (process.env.MINIMIZED !== "0") {
  // HIDE=1: hidden (tray) instead of minimized.
  if (process.env.HIDE === "1") app.hide(); else app.minimize();
  await sleep(3000);
  f0 = (await app.inspect()).frames;
  await mark("min-start");
  await sleep(4000);
  await mark("min-end");
  out.minFrames = (await app.inspect()).frames - f0;
  if (typeof app.stats === "function") out.minGpuMb = ((await app.stats()).native.memory?.current as { gpuMb?: number } | undefined)?.gpuMb;
}
console.log(JSON.stringify(out));
app.close();
process.exit(0);
