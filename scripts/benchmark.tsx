import { strict as assert } from "node:assert";
import { mkdir } from "node:fs/promises";
import { cpus } from "node:os";
import { resolve } from "node:path";
import { Button, Column, Row, Scroll, Text, Window, createApp, BunFfiBridge } from "tarve";

const rows = 2000;
const samples = 60;
let revision = 0;
function App() {
  return <Window title="Tarve performance measurement" width={1024} height={760}>
    <Column padding={16} gap={12} flex={1}>
      <Text id="revision">Revision {revision}</Text>
      <Scroll id="list" flex={1}>
        <Column>
          {Array.from({ length: rows }, (_, index) => <Row key={index} style={{ height: 36, shrink: 0 }} gap={12}>
            <Text style={{ flex: 1 }}>Record {index}: native layout and text</Text>
            <Button size="sm" onClick={() => revision++}>Open</Button>
          </Row>)}
        </Column>
      </Scroll>
    </Column>
  </Window>;
}
const start = performance.now();
const app = createApp(App, { debug: true, bridge: new BunFfiBridge({ libraryPath: resolve("native/target/release/tarve_native.dll") }) });
const errors: string[] = [];
app.onEvent(event => { if (event.type === "error") errors.push(event.message); });

function nextFrame(action: () => void): Promise<number> {
  return new Promise((resolveFrame, reject) => {
    const begin = performance.now();
    const timer = setTimeout(() => { unsubscribe(); reject(new Error("Frame timed out")); }, 10_000);
    const unsubscribe = app.onEvent(event => {
      if (event.type === "frame") {
        clearTimeout(timer);
        unsubscribe();
        resolveFrame(performance.now() - begin);
      }
    });
    action();
  });
}
function stats(values: number[]) {
  const sorted = [...values].sort((a, b) => a - b);
  const percentile = (p: number) => +sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * p) - 1)].toFixed(2);
  return { samples: values.length, medianMs: percentile(0.5), p95Ms: percentile(0.95), maxMs: percentile(1) };
}
try {
  await app.ready;
  let initial = await app.inspect();
  while (initial.frames === 0) { await Bun.sleep(10); initial = await app.inspect(); }
  const startupMs = performance.now() - start;
  const list = initial.nodes.find(node => node.id === "list")!;
  app.debug({ type: "input", action: "move", x: list.x + 20, y: list.y + 20 });
  await Bun.sleep(100);
  const scroll: number[] = [];
  for (let i = 0; i < samples + 5; i++) {
    const latency = await nextFrame(() => app.debug({ type: "input", action: "wheel", delta: 36 }));
    if (i >= 5) scroll.push(latency);
  }
  const updates: number[] = [];
  for (let i = 0; i < samples + 5; i++) {
    const latency = await nextFrame(() => { revision++; app.update(); });
    if (i >= 5) updates.push(latency);
  }
  const before = await app.inspect();
  await Bun.sleep(400);
  const after = await app.inspect();
  assert.equal(after.frames, before.frames, "No frame loop while idle");
  assert.equal(after.layoutNodesCreated, initial.layoutNodesCreated, "Updates must retain Taffy nodes");
  assert(after.paintedNodes < 100, "Only the viewport should be encoded");
  assert.deepEqual(errors, []);
  const report = {
    cpu: cpus()[0]?.model, bun: Bun.version, platform: `${process.platform}-${process.arch}`,
    workload: { rows, nodes: after.nodes.length, visibleNodes: after.paintedNodes },
    startupMs: +startupMs.toFixed(2), scroll: stats(scroll), updates: stats(updates),
    layoutNodesCreated: after.layoutNodesCreated, measureCalls: after.measureCalls, idleFrames: after.frames - before.frames,
    measurement: "Bun input/update dispatch to native frame notification; includes bridge and presentation scheduling, not photon latency. First five samples discarded.",
  };
  await mkdir("work", { recursive: true });
  await Bun.write("work/benchmark.json", JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
} finally {
  app.close();
  await app.closed;
}
