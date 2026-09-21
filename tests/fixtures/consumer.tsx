import { strict as assert } from "node:assert";
import { resolve } from "node:path";
import { Window, Column, Text, Button, Image, createApp } from "tarve";
import picture from "./fixture.png" with { type: "file" };

let count = 0;
function App() {
  return <Window title="Tarve npm consumer" width={640} height={520} minWidth={400} minHeight={400}>
    <Column padding={24} gap={16}>
      <Text id="count">Count: {count}</Text>
      <Button id="increment" onClick={() => count++}>Increment</Button>
      <Image id="picture" src={picture} width={320} height={180}/>
    </Column>
  </Window>;
}
const app = createApp(App, { debug: true });
const errors: string[] = [];
app.onEvent(event => { if (event.type === "error") errors.push(event.message); });
try {
  await app.ready;
  await Bun.sleep(150);
  const initial = await app.inspect();
  assert(initial.frames > 0);
  const button = initial.nodes.find(node => node.id === "increment")!;
  app.debug({ type: "input", action: "move", x: button.x + 10, y: button.y + 10 });
  app.debug({ type: "input", action: "down" });
  app.debug({ type: "input", action: "up" });
  await Bun.sleep(100);
  const clicked = await app.inspect();
  assert.equal(clicked.nodes.find(node => node.id === "count")?.text, "Count: 1");
  assert.equal(clicked.nodes.find(node => node.id === "picture")?.height, 180);
  await app.capture(resolve("consumer.png"));
  await Bun.sleep(250);
  const idle = await app.inspect();
  assert.equal(idle.frames, clicked.frames);
  assert.deepEqual(errors, []);
  await Bun.write("result.json", JSON.stringify({ result: "PASS", executable: Bun.isStandaloneExecutable, nativeCallback: true, localImage: true, idleFrames: idle.frames - clicked.frames }, null, 2));
} finally {
  app.close();
  await app.closed;
}
