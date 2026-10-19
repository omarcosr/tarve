// TypeScript twin of go/examples/bench: same scenes, same input script, same output keys.
// SCENE=empty|fixed|updates|virtual, R=auto|gpu|cpu.
import { setTimeout as sleep } from "node:timers/promises";
import { Button, Column, Row, Scroll, Text, VirtualList, Window, createApp, type Renderer } from "@tarve/core";

const scene = process.env.SCENE ?? "fixed";
const renderer = (process.env.R ?? "auto") as Renderer;
let tick = 0;
let listOffset = 0;
const row = (i: number) => <Row key={i} style={{ height: 36, shrink: 0 }} gap={12}><Text style={{ flex: 1 }}>Record {i}: native layout and text</Text><Button size="sm">Open</Button></Row>;
const items = Array.from({ length: 2000 }, (_, i) => i);
function View() {
  // The same 2,000 rows through VirtualList: only those in view (and the overscan) are compiled.
  if (scene === "virtual") return <Window title="bench" width={1024} height={760}><Column padding={16} gap={12} flex={1}><Text>Tick {tick}</Text>
    <VirtualList id="list" items={items} itemHeight={36} overscan={4} offset={listOffset} keyForItem={i => i} renderItem={i => row(i)} onScroll={offset => { listOffset = offset; }} style={{ flex: 1 }} />
  </Column></Window>;
  if (scene === "empty") return <Window title="bench" width={800} height={600}><Text>hi</Text></Window>;
  return <Window title="bench" width={1024} height={760}><Column padding={16} gap={12} flex={1}>{scene === "updates" && <Text>Tick {tick}</Text>}<Scroll id="list" flex={1}><Column>
    {Array.from({ length: 2000 }, (_, i) => <Row key={i} style={{ height: 36, shrink: 0 }} gap={12}><Text style={{ flex: 1 }}>Record {i}: native layout and text</Text><Button size="sm">Open</Button></Row>)}
  </Column></Scroll></Column></Window>;
}
const app = createApp(View, { debug: true, renderer });
await app.ready;
// "ready" comes after native presented the first frame.
const firstFrameMs = Math.round(performance.now());
let s = await app.inspect();
while (s.frames === 0) { await sleep(1); s = await app.inspect(); }
const out: Record<string, unknown> = { runtime: typeof Bun !== "undefined" ? "bun" : "node", scene, renderer, firstFrameMs };
const frames = async () => (await app.inspect()).frames;
const memory = async (label: string) => {
  const current = (await app.stats()).native.memory?.current;
  if (current) Object.assign(out, { [label + "WorkingSetMb"]: current.workingSetMb, [label + "PrivateMb"]: current.privateMb });
};
await sleep(3000);
await memory("idle");
let f0 = await frames();
await sleep(4000);
out.idleFrames = (await frames()) - f0;
await app.stats({ reset: true });
const cx = s.width / 2, cy = s.height / 2;
f0 = await frames();
for (let i = 0; i < 240; i++) {
  app.debug({ type: "input", action: "wheel", delta: i % 80 < 40 ? 60 : -60 });
  app.debug({ type: "input", action: "move", x: cx + Math.sin(i / 7) * cx * 0.8, y: cy + Math.cos(i / 9) * cy * 0.6 });
  if (scene === "updates" || scene === "virtual") { tick++; app.update(); }
  await sleep(16);
}
out.busyFrames = (await frames()) - f0;
await memory("busy");
const { js, native } = await app.stats();
const ms = (p: { p50: number; p95: number; p99: number } | undefined) => p && [p.p50, p.p95, p.p99];
Object.assign(out, {
  hostRenderMs: ms(js.render), hostDiffMs: ms(js.diff), hostUpdateMs: ms(js.update),
  applyMs: ms(native.phases?.apply), layoutMs: ms(native.phases?.layout), paintMs: ms(native.phases?.paint),
  presentMs: ms(native.phases?.present), frameMs: ms(native.phases?.frame),
});
console.log("@result " + JSON.stringify(out));
app.close();
await app.closed;
