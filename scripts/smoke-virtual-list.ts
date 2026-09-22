import { strict as assert } from "node:assert";
import { App, itemHeight, records } from "../examples/large-list-view";
import { createApp } from "@tarve/core";
import type { NativeEvent, NodeSnapshot, Snapshot } from "@tarve/protocol";

const app = createApp(App, { debug: true });
const errors: string[] = [];
const scrollEvents: NativeEvent[] = [];
app.onEvent(event => {
  if (event.type === "error") errors.push(event.message);
  if (event.type === "scroll") scrollEvents.push(event);
});
function node(snapshot: Snapshot, id: string): NodeSnapshot {
  const found = snapshot.nodes.find(item => item.id === id);
  assert(found, `Missing node: ${id}`);
  return found;
}
const settle = async (): Promise<Snapshot> => { await Bun.sleep(120); return app.inspect(); };
try {
  await app.ready;
  const first = await settle();
  assert(first.frames > 0);
  assert(first.layoutNodes < 120,
    `Only visible rows should have native layout nodes (got ${first.layoutNodes})`);
  assert.equal(node(first, "records").scrollMax, records.length * itemHeight - 600);
  assert(first.nodes.some(item => item.id === "record-0"));
  const textIndex = first.nodes.findIndex(item => item.id === "record-0");
  const outerRow = first.nodes[textIndex - 2];
  const innerRow = first.nodes[textIndex - 1];
  assert(outerRow?.kind === "row" && innerRow?.kind === "row");
  assert(innerRow.y >= outerRow.y - 0.1 && innerRow.y + innerRow.height <= outerRow.y + outerRow.height + 0.1,
    "Padded content must fit inside its virtual row");

  const list = node(first, "records");
  app.debug({ type: "input", action: "move", x: list.x + 20, y: list.y + 20 });
  app.debug({ type: "input", action: "wheel", delta: 360 });
  const middle = await settle();
  assert.equal(node(middle, "records").scroll, 360);
  assert(middle.nodes.some(item => item.id === `record-${Math.floor(360 / itemHeight)}`));
  assert(!middle.nodes.some(item => item.id === "record-0"));
  assert(middle.layoutNodes < 120);
  assert(scrollEvents.some(event => event.type === "scroll" && event.offset === 360));

  const thumbX = list.x + list.width - 5;
  app.debug({ type: "input", action: "move", x: thumbX, y: list.y + 15 });
  app.debug({ type: "input", action: "down" });
  app.debug({ type: "input", action: "move", x: thumbX, y: list.y + list.height / 2 });
  app.debug({ type: "input", action: "up" });
  const dragged = await settle();
  const dragOffset = node(dragged, "records").scroll;
  assert(dragOffset > node(first, "records").scrollMax * 0.4, "Dragging the scrollbar should jump through the virtual list");
  assert(node(dragged, "visible-range").text.includes(`First visible row: ${Math.floor(dragOffset / itemHeight) + 1}`));
  assert(!dragged.nodes.some(item => item.id === "record-0"));
  assert(dragged.layoutNodes < 120);

  app.debug({ type: "input", action: "wheel", delta: 2_000_000 });
  const last = await settle();
  assert(last.nodes.some(item => item.id === `record-${records.length - 1}`));
  assert(last.layoutNodes < 120);
  const button = node(last, `open-${records.length - 1}`);
  app.debug({ type: "input", action: "move", x: button.x + button.width / 2, y: button.y + button.height / 2 });
  app.debug({ type: "input", action: "down" });
  app.debug({ type: "input", action: "up" });
  const clicked = await settle();
  assert(node(clicked, "visible-range").text.includes(records.at(-1)!));
  const before = await app.inspect();
  await Bun.sleep(300);
  const idle = await app.inspect();
  assert.equal(idle.frames, before.frames);
  assert.deepEqual(errors, []);
  console.log(JSON.stringify({ result: "PASS", items: records.length, maxLayoutNodes: Math.max(first.layoutNodes, middle.layoutNodes, last.layoutNodes), idleFrames: idle.frames - before.frames }, null, 2));
} finally {
  app.close();
  await app.closed;
}
