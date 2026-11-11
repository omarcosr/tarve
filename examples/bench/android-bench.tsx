// Android benchmark: one APK runs every scene of bench.tsx in turn (process.env is empty on
// the device) and logs one JSON line per scene to logcat (`adb logcat -s tarve`).
// Build: bunx tarve build examples/bench/android-bench.tsx --target android-arm64
const t0 = performance.now();
import { Button, Column, Row, Scroll, Text, View, VirtualList, Window, createApp, type Renderer } from "@tarve/core";
const renderer = ((globalThis as { TARVE_BENCH_RENDERER?: Renderer }).TARVE_BENCH_RENDERER ?? "auto") as Renderer;
const sleep = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));
const scenes = ["empty", "fixed", "updates", "boxes", "text", "list"] as const;
let scene: (typeof scenes)[number] = "empty";
let tick = 0;
function Empty() { return <Text>hi</Text>; }
function Fixed() {
  return <Column padding={16} gap={12} flex={1}>{scene === "updates" && <Text>Tick {tick}</Text>}<Scroll id="list" flex={1}><Column>
    {Array.from({ length: 2000 }, (_, i) => <Row key={i} style={{ height: 36, shrink: 0 }} gap={12}><Text style={{ flex: 1 }}>Record {i}: native layout and text</Text><Button size="sm">Open</Button></Row>)}
  </Column></Scroll></Column>;
}
const color = (i: number) => "#" + [i * 37, i * 91 + 60, i * 53 + 120].map(v => (v % 200 + 40).toString(16).padStart(2, "0")).join("");
function Boxes() {
  return <Column padding={8} gap={4}>
    {Array.from({ length: 30 }, (_, row) => <Row key={row} gap={4}>{Array.from({ length: 12 }, (_, col) => {
      const i = row * 12 + col;
      return <View key={col} style={{ width: 24 + (i + tick) % 4 * 2, height: 28, radius: 6, background: color(i + tick), boxShadow: { y: 2, blur: 6, color: "#00000040" } }} />;
    })}</Row>)}
  </Column>;
}
function Labels() {
  return <Row padding={8} gap={8}>
    {Array.from({ length: 3 }, (_, col) => <Column key={col} flex={1} gap={2}>{Array.from({ length: 60 }, (_, row) => {
      const i = col * 60 + row;
      return <Text key={row}>L{i}: {(i * 7919 + tick * 31) % 100000}</Text>;
    })}</Column>)}
  </Row>;
}
const rows = Array.from({ length: 100_000 }, (_, i) => i);
let listOffset = 0;
function List() {
  return <Column padding={16} flex={1}>
    <VirtualList id="list" items={rows} itemHeight={28} offset={listOffset} onScroll={offset => { listOffset = offset; app.update(); }}
      renderItem={i => <Row key={i} style={{ height: 28 }} gap={12}><Text style={{ flex: 1 }}>Row {i}: virtualized</Text><Text>{i % 997}</Text></Row>} />
  </Column>;
}
function Bench() {
  const body = scene === "fixed" || scene === "updates" ? <Fixed /> : scene === "boxes" ? <Boxes /> : scene === "text" ? <Labels /> : scene === "list" ? <List /> : <Empty />;
  return <Window title="bench">{body}</Window>;
}
const app = createApp(Bench, { debug: true, renderer });
await app.ready;
let s = await app.inspect();
while (s.frames === 0) { await sleep(1); s = await app.inspect(); }
const r = Math.round;
console.log("@bench " + JSON.stringify({ renderer, firstFrameMs: r(performance.now()), width: s.width, height: s.height }));
const ms = (x: { p50: number; p95: number; p99: number; max?: number } | undefined) => x && [x.p50, x.p95, x.p99, x.max].map(v => v === undefined ? v : Math.round(v * 100) / 100);
for (const name of scenes) {
  scene = name; tick = 0; listOffset = 0;
  const tSwitch = performance.now();
  app.update();
  await app.inspect();
  const switchMs = r(performance.now() - tSwitch);
  await sleep(1500);
  let f0 = (await app.inspect()).frames;
  await sleep(3000);
  const idleFrames = (await app.inspect()).frames - f0;
  const animated = name === "updates" || name === "boxes" || name === "text";
  const cx = s.width / 2, cy = s.height / 2;
  await app.stats({ reset: true });
  f0 = (await app.inspect()).frames;
  const tBusy = performance.now();
  for (let i = 0; i < 240; i++) {
    app.debug({ type: "input", action: "wheel", delta: i % 80 < 40 ? 60 : -60 });
    app.debug({ type: "input", action: "move", x: cx + Math.sin(i / 7) * cx * 0.8, y: cy + Math.cos(i / 9) * cy * 0.6 });
    if (animated) { tick++; app.update(); }
    await sleep(16);
  }
  const busyMs = performance.now() - tBusy;
  const busyFrames = (await app.inspect()).frames - f0;
  const { js, native } = await app.stats({ reset: true });
  const ph: Partial<NonNullable<typeof native.phases>> = native.phases ?? {};
  console.log("@bench " + JSON.stringify({
    scene: name, switchMs, idleFrames, busyFrames, busyFps: r(busyFrames / busyMs * 1000), loopMs: r(busyMs),
    jsUpdate: ms(js.update), jsRender: ms(js.render), jsDiff: ms(js.diff),
    apply: ms(ph.apply), layout: ms(ph.layout), paint: ms(ph.paint), present: ms(ph.present), frame: ms(ph.frame),
    heapMb: js.heapUsedMb, mem: native.memory?.current,
  }));
}
console.log("@bench done");
app.close();
