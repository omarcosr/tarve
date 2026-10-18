// Several windows of one app: a second window opens with its own tree, takes input,
// answers layout and inspect for itself, closes alone, and closing the first window
// closes the rest.
import { Column, createApp, Pressable, Text, Window } from "@tarve/core";
import { strict as assert } from "node:assert";
import { setTimeout as sleep } from "node:timers/promises";

const errors: string[] = [];
const onError = (event: { error: Error }) => errors.push(event.error.message);
let clicks = 0;
const app = createApp(() => (
  <Window title="Main window" width={360} height={220} position={{ x: 100, y: 100 }}>
    <Column style={{ padding: 16 }}><Text>main</Text></Column>
  </Window>
), { debug: true, onError });
await app.ready;
const timeout = setTimeout(() => { console.error("smoke:windows timed out"); process.exit(1); }, 20_000);

const child = app.openWindow(() => (
  <Window title="Second window" width={300} height={200} position={{ x: 520, y: 100 }}>
    <Column style={{ padding: 16 }}>
      <Pressable id="button" onClick={() => { clicks++; child.update(); }}><Text>{`clicks ${clicks}`}</Text></Pressable>
    </Column>
  </Window>
), { id: "second", debug: true, onError });
await child.ready;
const [main, second] = [await app.inspect(), await child.inspect()];
assert.equal(main.width, 360, "the main window keeps its size");
assert.equal(second.width, 300, "the second window has its own size");
assert.ok(second.nodes.some(node => node.id === "button"), "the second window has its own tree");
assert.ok(!main.nodes.some(node => node.id === "button"), "the main tree does not have the second window's nodes");

const box = child.layout(["button"])?.button;
assert.ok(box, "the second window answers synchronous layout reads");
const at = { x: box.x + box.width / 2, y: box.y + box.height / 2 };
child.debug({ type: "input", action: "move", ...at });
child.debug({ type: "input", action: "down", ...at } as never);
child.debug({ type: "input", action: "up", ...at } as never);
for (let i = 0; i < 40 && clicks === 0; i++) await sleep(50);
assert.equal(clicks, 1, "a click in the second window runs its handler");

child.close();
await child.closed;
assert.ok((await app.inspect()).width > 0, "closing the second window leaves the app running");

const third = app.openWindow(() => <Window title="Third window"><Text>third</Text></Window>, { onError });
await third.ready;
app.close();
await Promise.all([app.closed, third.closed]);
clearTimeout(timeout);
assert.deepEqual(errors, [], "no errors");
console.log("smoke:windows passed");
process.exit(0);
