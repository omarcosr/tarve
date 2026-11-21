// Cross-framework benchmark app (bench/frameworks, built from examples/ by build.ts). The same screen is built in every framework:
// a 48x48 marker at the client's top-left (magenta on the first frame, then green/blue on every
// update), an "Update" button at (64, 8) 120x32 and, with SCENE=list, 2,000 rows of text + button
// whose labels all change on each update. The harness reads the marker pixel from the screen.
import { Button, Column, Row, Scroll, Text, View, Window, createApp, type Renderer } from "@tarve/core";

const scene = process.env.SCENE ?? "empty";
const renderer = (process.env.R || undefined) as Renderer | undefined;
let tick = 0;
const marker = () => (tick === 0 ? "#ff00ff" : tick % 2 ? "#00ff00" : "#0000ff");

function Bench() {
  return (
    <Window title="bench" width={1024} height={760}>
      <Column flex={1} style={{ background: "#ffffff" }}>
        <Row style={{ height: 48, shrink: 0 }}>
          <View style={{ width: 48, height: 48, background: marker() }} />
          <View style={{ width: 16 }} />
          <Column style={{ paddingTop: 8 }}>
            <Button style={{ width: 120, height: 32 }} onClick={() => tick++}>Update</Button>
          </Column>
        </Row>
        {scene === "list" ? (
          <Scroll id="list" flex={1}>
            <Column>
              {Array.from({ length: 2000 }, (_, i) => (
                <Row key={i} style={{ height: 36, shrink: 0 }} gap={12}>
                  <Text style={{ flex: 1 }}>Record {i}: native layout and text {tick}</Text>
                  <Button size="sm">Open</Button>
                </Row>
              ))}
            </Column>
          </Scroll>
        ) : (
          <Text>hi</Text>
        )}
      </Column>
    </Window>
  );
}

const app = createApp(Bench, { renderer, lowPower: process.env.LOWPOWER === "1" });
await app.ready;
if (process.env.MEMORY === "1") {
  // Where the idle list's memory is: the JS heap and the native allocator's stages.
  await new Promise(resolve => setTimeout(resolve, 3000));
  const { js, native } = await app.stats();
  console.log(JSON.stringify({ heapUsedMb: js.heapUsedMb, native: native.memory }));
  app.close();
  process.exit(0);
}
if (process.env.STATS === "1") {
  // Phase breakdown of the full-list update the harness measures from the outside.
  const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
  await sleep(1500);
  const updates = Number(process.env.STATS_N ?? 20), gap = Number(process.env.STATS_GAP ?? 400);
  for (let i = 0; i < updates; i++) { tick++; app.update(); await sleep(gap); }
  const { js, native } = await app.stats();
  const ms = (s?: { p50: number; p95: number }) => s && `${s.p50.toFixed(1)}/${s.p95.toFixed(1)}`;
  console.log(JSON.stringify({
    update: ms(js.update), render: ms(js.render), diff: ms(js.diff),
    apply: ms(native.phases?.apply), layout: ms(native.phases?.layout), paint: ms(native.phases?.paint),
    present: ms(native.phases?.present), frame: ms(native.phases?.frame),
  }));
  app.close();
  process.exit(0);
}
await app.closed;
