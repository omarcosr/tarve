import { strict as assert } from "node:assert";
import { mkdir } from "node:fs/promises";
import { resolve } from "node:path";
import { App } from "../examples/basic";
import { createApp } from "@tarve/core";
import type { Snapshot, NodeSnapshot, NativeEvent } from "@tarve/protocol";

const app = createApp(App, { debug: true });
const events: NativeEvent[] = [];
const errors: string[] = [];
app.onEvent(event => { events.push(event); if (event.type === "error") errors.push(event.message); });
function node(snapshot: Snapshot, id: string): NodeSnapshot {
  const item = snapshot.nodes.find(n => n.id === id);
  assert(item, `Missing node: ${id}`); return item;
}
async function settle(): Promise<Snapshot> { await Bun.sleep(120); return app.inspect(); }
async function click(id: string): Promise<Snapshot> {
  const box = node(await app.inspect(), id);
  app.debug({ type: "input", action: "move", x: box.x + box.width / 2, y: box.y + box.height / 2 });
  app.debug({ type: "input", action: "down" });
  app.debug({ type: "input", action: "up" });
  return settle();
}
try {
  await app.ready;
  await mkdir(resolve("work"), { recursive: true });
  const initial = await settle();
  assert(initial.frames > 0, "Vello must present a frame");
  assert(initial.shapes > 20, "Parley must shape the example text");
  assert.equal(initial.layoutNodes, initial.nodes.length, "Every node must have one retained layout node");
  const image = node(initial, "local-image");
  assert(image.width > 100 && image.height === 144, "Local image must have a real layout");
  await app.capture(resolve("work/basic.png"));
  await Bun.write(resolve("work/initial-layout.json"), JSON.stringify(initial, null, 2));
  const button = node(initial, "new-project");
  app.debug({ type: "input", action: "move", x: button.x + 10, y: button.y + 10 });
  const hover = await settle();
  assert.equal(hover.hovered, "new-project");
  assert.equal(hover.layouts, initial.layouts, "Hover must not recompute layout");
  assert.equal(hover.shapes, initial.shapes, "Hover must not reshape text");
  await app.capture(resolve("work/hover.png"));
  const clicked = await click("new-project");
  assert.equal(node(clicked, "save-status").text, "Project 1 created", "Click must roundtrip through Bun and update Rust");
  assert.equal(clicked.layoutNodesCreated, initial.layoutNodesCreated, "An app update must reuse existing layout nodes");
  for (const [id, expected] of [["variant-default", "Primary"], ["variant-secondary", "Secondary"], ["variant-outline", "Outline"], ["variant-ghost", "Ghost"], ["variant-destructive", "Destructive"]]) {
    assert(node(await click(id), "save-status").text.startsWith(expected), `${id} must dispatch click`);
  }
  const beforeDisabled = events.filter(e => e.type === "click").length;
  await click("disabled-button");
  assert.equal(events.filter(e => e.type === "click").length, beforeDisabled, "Disabled button must ignore click");
  await click("name-input");
  app.debug({ type: "input", action: "key", text: "SelectAll" });
  app.debug({ type: "input", action: "text", text: "Marcos 👩‍💻" });
  app.debug({ type: "input", action: "key", text: "Backspace" });
  const typed = await settle();
  assert.equal(node(typed, "name-input").text, "Marcos ");
  assert.equal(node(typed, "save-status").text, "Unsaved changes");
  assert.equal(node(await click("save"), "save-status").text, "Saved for Marcos ");
  await app.capture(resolve("work/interaction.png"));
  const beforeScroll = await app.inspect();
  const scroll = node(beforeScroll, "activity-scroll");
  assert(scroll.scrollMax > 300, "Activity must overflow");
  app.debug({ type: "input", action: "move", x: scroll.x + 30, y: scroll.y + 30 });
  app.debug({ type: "input", action: "wheel", delta: 180 });
  const scrolled = await settle();
  assert.equal(node(scrolled, "activity-scroll").scroll, 180);
  assert.equal(scrolled.layouts, beforeScroll.layouts, "Scroll must only paint");
  await app.capture(resolve("work/scrolled.png"));
  const page = node(scrolled, "page-scroll");
  app.debug({ type: "input", action: "move", x: page.x + 14, y: page.y + 100 });
  app.debug({ type: "input", action: "wheel", delta: page.scrollMax });
  const bottom = await settle();
  assert.equal(node(bottom, "page-scroll").scroll, page.scrollMax);
  const visibleImage = node(bottom, "local-image");
  assert(visibleImage.y >= 70 && visibleImage.y + visibleImage.height <= bottom.height, "Image must be fully visible after scrolling the page");
  await app.capture(resolve("work/bottom.png"));
  app.debug({ type: "input", action: "wheel", delta: -page.scrollMax });
  await settle();
  app.debug({ type: "resize", width: 920, height: 720 });
  const resized = await settle();
  assert(Math.abs(resized.width - 920) < 2, "Window must resize");
  assert(resized.layouts > scrolled.layouts, "Resize must reflow");
  await app.capture(resolve("work/resized.png"));
  app.debug({ type: "input", action: "move", x: -1, y: -1 });
  await settle();
  const idleBefore = await app.inspect();
  await Bun.sleep(500);
  const idleAfter = await app.inspect();
  assert.equal(idleAfter.frames, idleBefore.frames, "Idle window must not run a frame loop");
  assert.equal(idleAfter.layouts, idleBefore.layouts);
  assert.equal(idleAfter.paints, idleBefore.paints);
  assert.deepEqual(errors, [], "Native runtime must not report errors");
  console.log(JSON.stringify({ result: "PASS", initialFrames: initial.frames, nodes: initial.nodes.length, layouts: idleAfter.layouts, paints: idleAfter.paints, idleFrames: idleAfter.frames - idleBefore.frames, verified: ["FFI Worker", "Vello GPU", "Parley shaping", "Taffy Flex/Grid", "hover paint-only", "all button variants", "disabled button", "Bun state roundtrip", "Unicode input", "scroll clipping", "resize", "idle event loop", "local PNG"], captures: "work/*.png" }, null, 2));
} finally {
  app.close();
  await app.closed;
}
