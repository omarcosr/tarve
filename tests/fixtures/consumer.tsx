import { strict as assert } from "node:assert";
import { resolve } from "node:path";
import { Window, Column, Text, Button, Checkbox, Slider, VirtualList, Image, createApp } from "tarve";
import picture from "./fixture.png" with { type: "file" };

let count = 0;
let checked = false;
let volume = 20;
let offset = 0;
const records = Array.from({ length: 1000 }, (_, index) => index);
function App() {
  return <Window title="Tarve npm consumer" width={640} height={640} minWidth={400} minHeight={400}>
    <Column padding={24} gap={16}>
      <Text id="count">Count: {count}</Text>
      <Button id="increment" onClick={() => count++}>Increment</Button>
      <Checkbox id="checkbox" label="Updates" checked={checked} onCheckedChange={value => { checked = value; }} />
      <Slider id="slider" label="Volume" value={volume} onValueChange={value => { volume = value; }} />
      <Image id="picture" src={picture} width={320} height={180}/>
      <VirtualList id="list" items={records} itemHeight={24} height={72} offset={offset}
        onScroll={next => { offset = next; }} renderItem={index => <Text id={`row-${index}`}>Row {index}</Text>} />
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
  const checkbox = clicked.nodes.find(node => node.id === "checkbox")!;
  app.debug({ type: "input", action: "move", x: checkbox.x + checkbox.width / 2, y: checkbox.y + checkbox.height / 2 });
  app.debug({ type: "input", action: "down" });
  app.debug({ type: "input", action: "up" });
  app.focus("slider");
  app.debug({ type: "input", action: "key", text: "ArrowRight" });
  await Bun.sleep(100);
  const controlled = await app.inspect();
  assert.equal(controlled.nodes.find(node => node.id === "checkbox")?.control?.checked, true);
  assert.equal(controlled.nodes.find(node => node.id === "slider")?.control?.value, 21);
  const list = controlled.nodes.find(node => node.id === "list")!;
  assert(list.scrollMax > 20_000);
  app.debug({ type: "input", action: "move", x: list.x + 20, y: list.y + 20 });
  app.debug({ type: "input", action: "wheel", delta: 240 });
  await Bun.sleep(100);
  const virtual = await app.inspect();
  assert.equal(virtual.nodes.find(node => node.id === "list")?.scroll, 240);
  assert(virtual.nodes.some(node => node.id === "row-10"));
  assert(virtual.nodes.length < 50);
  await app.capture(resolve("consumer.png"));
  await Bun.sleep(250);
  const idle = await app.inspect();
  assert.equal(idle.frames, virtual.frames);
  assert.deepEqual(errors, []);
  await Bun.write("result.json", JSON.stringify({ result: "PASS", executable: Bun.isStandaloneExecutable, nativeCallback: true, nativeControls: true, virtualList: true, localImage: true, idleFrames: idle.frames - virtual.frames }, null, 2));
} finally {
  app.close();
  await app.closed;
}
