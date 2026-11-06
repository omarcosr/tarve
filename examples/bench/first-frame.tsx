// Tarve's side of BUI's startup benchmark (bindings/node/bench/first-frame.js): the same small
// counter app, quitting once its first frame is on screen. Prints the time since the runtime
// started and the resident memory then: `first-frame <ms> rss <MB>`.
import { Button, Column, Row, Text, createApp } from "@tarve/core";
import { Window } from "@tarve/core";

let count = 0;
function App() {
  return <Window title="first frame" width={360} height={200}>
    <Column padding={24} gap={12} flex={1} style={{ background: "#2b2b2b", foreground: "#e6e6e6" }}>
      <Text style={{ fontSize: 20, fontWeight: 700 }}>Hello</Text>
      <Row gap={12} align="center">
        <Text>Clicks: {count}</Text>
        <Button onClick={() => { count++; app.update(); }}>Add one</Button>
      </Row>
    </Column>
  </Window>;
}

const app = createApp(App, { renderer: process.env.R === "cpu" ? "cpu" : "gpu" });
await app.ready;
// txiki.js has no process.memoryUsage.rss(): its RSS is reported as 0 there.
const rss = typeof process.memoryUsage?.rss === "function" ? process.memoryUsage.rss() : (process.memoryUsage?.()?.rss ?? 0);
console.log(`first-frame ${performance.now().toFixed(1)} rss ${(rss / 1048576).toFixed(1)}`);
app.close();
process.exit(0);
