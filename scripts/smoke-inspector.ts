import { strict as assert } from "node:assert";
import { mkdir } from "node:fs/promises";
import { resolve } from "node:path";
import { Button, Column, Text, Window, createApp, type AppHandle } from "@tarve/core-internal";
import { jsx } from "@tarve/core-internal/jsx-runtime";
import { INSPECTOR_CAPTURE_ID, INSPECTOR_HIGHLIGHT_ID, INSPECTOR_SLOT, type Inspector } from "@tarve/core-internal/devtools/inspector";

// Real-window smoke for the visual inspector (`tarve dev --inspect`): a second window
// of the app with the component tree, render counts and the event log, and the picker
// overlay in the app window. Run alone or from smoke-devtools.ts (one native app per process).
const work = resolve(import.meta.dir, "..", "work");
await mkdir(work, { recursive: true });
const settle = () => Bun.sleep(150);

async function click(app: AppHandle, id: string): Promise<void> {
  const item = (await app.inspect()).nodes.find(node => node.id === id);
  assert(item, `Missing node: ${id}`);
  app.debug({ type: "input", action: "move", x: item.x + item.width / 2, y: item.y + item.height / 2 });
  app.debug({ type: "input", action: "down" });
  app.debug({ type: "input", action: "up" });
  await settle();
}

let count = 0;
function Counter(props: { value: number }) {
  return Text({ id: "count", children: `count ${props.value}` });
}
const app = createApp(() => Window({
  title: "Tarve Inspector Smoke", width: 520, height: 360,
  children: Column({ padding: 16, gap: 8, children: [
    jsx(Counter, { value: count }),
    Button({ id: "bump", onClick: () => { count++; }, children: "Bump" }),
  ] }),
}), { debug: true, dev: { inspector: true }, onError: () => {} });
const inspector = (app as unknown as Record<symbol, Inspector | undefined>)[INSPECTOR_SLOT];
try {
  await app.ready;
  assert(inspector, "dev.inspector creates an inspector");
  const deadline = Date.now() + 10_000;
  while (!inspector.window) { assert(Date.now() < deadline, "inspector window opens"); await settle(); }
  const panelWindow = inspector.window;
  await panelWindow.ready;
  await click(app, "bump");
  await click(app, "bump");
  await Bun.sleep(300);
  const panel = (await panelWindow.inspect()).nodes.map(node => node.text).join("\n");
  assert.match(panel, /<Counter>/, "the inspector window shows the component tree");
  // The first click can go to activating the window (the inspector opened on top): count what landed.
  assert(count >= 1, "a click reached the app");
  assert(panel.includes(`×${count + 1}`), `Counter rendered ${count + 1} times (mount + clicks): ${panel}`);
  assert.match(panel, /click #bump/, "the event log shows the clicks");

  inspector.setPicking(true);
  await inspector.refreshBoxes();
  await settle();
  const nodes = (await app.inspect()).nodes;
  assert(nodes.some(node => node.id === INSPECTOR_CAPTURE_ID), "picker mode adds the capture layer");
  const bump = nodes.find(node => node.id === "bump")!;
  app.debug({ type: "input", action: "move", x: bump.x + bump.width / 2, y: bump.y + bump.height / 2 });
  await settle();
  await inspector.refreshBoxes();
  await settle();
  const highlight = (await app.inspect()).nodes.find(node => node.id === INSPECTOR_HIGHLIGHT_ID);
  assert(highlight, "hovering a node while picking highlights it");
  assert(Math.abs(highlight.x - bump.x) < 1.5 && Math.abs(highlight.width - bump.width) < 1.5, `highlight covers the button: ${JSON.stringify({ highlight, bump })}`);
  await app.capture(resolve(work, "devtools-inspector-app.png"));
  const before = count;
  app.debug({ type: "input", action: "down" });
  app.debug({ type: "input", action: "up" });
  await Bun.sleep(400);
  assert.equal(count, before, "the picker click does not reach the app");
  assert.equal(inspector.state.selected, "h:bump", "the picker click selects the node");
  assert(inspector.state.layout, "the selected node has a layout box");
  assert(!(await app.inspect()).nodes.some(node => node.id === INSPECTOR_CAPTURE_ID), "picking ends after the click");
  const details = (await panelWindow.inspect()).nodes.map(node => node.text).join("\n");
  assert.match(details, /Style \(resolved\)/, "the inspector shows the selected node's style");
  await panelWindow.capture(resolve(work, "devtools-inspector.png"));
} finally {
  app.close();
  await app.closed;
}
console.log("[tarve smoke:inspector] PASS");
