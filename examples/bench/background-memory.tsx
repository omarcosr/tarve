// Memory a hidden window gives back. Renders ROWS rows, re-renders them CHURN times with
// new text (garbage for the JS heap), then hides the window and reads process memory and
// the JS heap before and after. GARBAGE MB (about) of short-lived objects are left behind
// just before the window hides, as a burst of work would.
import { Text, View, Window, createApp } from "@tarve/core";

const rows = Number(process.env.ROWS ?? 3000);
const churn = Number(process.env.CHURN ?? 40);
let round = 0;
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

function Scene() {
  return <Window title="background-memory" width={800} height={600}>
    <View style={{ flex: 1, direction: "column", overflow: "clip" }}>
      {Array.from({ length: rows }, (_, i) => <Text key={i}>{`row ${i} round ${round} ${"x".repeat(40)}`}</Text>)}
    </View>
  </Window>;
}

const app = createApp(Scene);
await app.ready;
for (; round < churn; round++) {
  app.update();
  await sleep(16);
}
await sleep(1500);
const read = async () => {
  const { js, native } = await app.stats();
  return { heapMb: js.heapUsedMb, privateMb: native.memory?.current?.privateMb, workingSetMb: native.memory?.current?.workingSetMb };
};
const garbage = (count: number) => Array.from({ length: count }, (_, i) => ({ i, text: `garbage ${i}` })).length;
garbage(Number(process.env.GARBAGE ?? 100) * 1024 * 8);
const visible = await read();
app.hide();
await sleep(2500);
const hidden = await read();
console.log(JSON.stringify({ rows, churn, visible, hidden }));
app.close();
