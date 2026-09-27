import { strict as assert } from "node:assert";
import { mkdir } from "node:fs/promises";
import { resolve } from "node:path";
import { App } from "../examples/basic-view";
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
async function hover(id: string): Promise<Snapshot> {
  const box = node(await app.inspect(), id);
  let latest: Snapshot | undefined;
  // Keep synthetic pointer input and its diagnostic snapshot adjacent in the
  // native command queue. A real desktop cursor (notably under WSLg) can move
  // over the window while the smoke test is sleeping and legitimately replace
  // tree.hovered with whatever is under the physical pointer.
  for (let attempt = 0; attempt < 3; attempt++) {
    app.debug({ type: "input", action: "move", x: box.x + 10, y: box.y + 10 });
    latest = await app.inspect();
    if (latest.hovered === id) return latest;
  }
  return latest!;
}
async function waitForFrameQuiescence(): Promise<Snapshot> {
  const deadline = performance.now() + 3_000;
  let previous = await app.inspect();
  let stableSince = performance.now();
  while (performance.now() < deadline) {
    await Bun.sleep(50);
    const current = await app.inspect();
    if (current.frames !== previous.frames || current.layouts !== previous.layouts || current.paints !== previous.paints) {
      stableSince = performance.now();
    } else if (performance.now() - stableSince >= 250) {
      return current;
    }
    previous = current;
  }
  throw new Error("Native frame stream did not become idle");
}
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
  const beforeTheme = await app.inspect();
  const dark = await click("theme-toggle");
  assert.equal(dark.layouts, beforeTheme.layouts, "Theme switching must not recompute layout");
  assert.equal(dark.shapes, beforeTheme.shapes, "Theme switching must not reshape text");
  assert(dark.paints > beforeTheme.paints, "Theme switching must repaint");
  await app.capture(resolve("work/dark.png"));
  const light = await click("theme-toggle");
  assert.equal(light.layouts, beforeTheme.layouts, "Switching back to light must remain paint-only");
  assert.equal(light.shapes, beforeTheme.shapes, "Switching back to light must not reshape text");
  const hovered = await hover("new-project");
  assert.equal(hovered.hovered, "new-project");
  assert.equal(hovered.layouts, light.layouts, "Hover must not recompute layout");
  assert.equal(hovered.shapes, light.shapes, "Hover must not reshape text");
  await app.capture(resolve("work/hover.png"));
  const clicked = await click("new-project");
  assert.equal(node(clicked, "save-status").text, "Project 1 created", "Click must roundtrip through Bun and update Rust");
  assert(clicked.nodes.some(item => item.id === "demo-modal"), "New project must open the modal");
  const closedAfterNewProject = await click("demo-modal-close");
  assert(!closedAfterNewProject.nodes.some(item => item.id === "demo-modal"), "New-project modal must close cleanly");
  for (const [id, expected] of [["variant-default", "Primary"], ["variant-secondary", "Secondary"], ["variant-outline", "Outline"], ["variant-ghost", "Ghost"], ["variant-destructive", "Destructive"]]) {
    assert(node(await click(id), "save-status").text.startsWith(expected), `${id} must dispatch click`);
  }
  const modal = await click("open-modal");
  assert(node(modal, "demo-modal").width > 800, "Modal overlay must cover the window");
  assert(node(modal, "demo-modal-content").width <= 480, "Modal content must keep its shadcn-sized panel");
  assert.equal(modal.focused, "demo-modal-close", "Opening a modal must move focus into the dialog");
  await app.capture(resolve("work/modal.png"));
  app.debug({ type: "input", action: "key", text: "Escape" });
  const escaped = await settle();
  assert(!escaped.nodes.some(item => item.id === "demo-modal"), "Escape must close the modal");
  await click("open-modal");
  const closeButton = await click("demo-modal-close");
  assert(!closeButton.nodes.some(item => item.id === "demo-modal"), "Close button must dismiss the modal");
  await click("open-modal");
  app.debug({ type: "input", action: "move", x: 8, y: 8 });
  app.debug({ type: "input", action: "down" });
  app.debug({ type: "input", action: "up" });
  const backdropClosed = await settle();
  assert(!backdropClosed.nodes.some(item => item.id === "demo-modal"), "Backdrop click must close the modal");
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
  const idleBefore = await waitForFrameQuiescence();
  await Bun.sleep(500);
  const idleAfter = await app.inspect();
  assert.equal(idleAfter.frames, idleBefore.frames, "Idle window must not run a frame loop");
  assert.equal(idleAfter.layouts, idleBefore.layouts);
  assert.equal(idleAfter.paints, idleBefore.paints);
  assert.deepEqual(errors, [], "Native runtime must not report errors");
  console.log(JSON.stringify({ result: "PASS", initialFrames: initial.frames, nodes: initial.nodes.length, layouts: idleAfter.layouts, paints: idleAfter.paints, idleFrames: idleAfter.frames - idleBefore.frames, verified: ["FFI event bridge", "renderer presentation", "Parley shaping", "Taffy Flex/Grid", "light/dark theme switch", "hover paint-only", "all button variants", "shadcn modal", "modal focus trap", "Escape/backdrop dismiss", "disabled button", "Bun state roundtrip", "Unicode input", "scroll clipping", "resize", "idle event loop", "local PNG"], captures: "work/*.png" }, null, 2));
} finally {
  app.close();
  await app.closed;
}
