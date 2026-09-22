import { strict as assert } from "node:assert";
import { mkdir } from "node:fs/promises";
import { resolve } from "node:path";
import { App } from "../examples/forms-view";
import { createApp } from "@tarve/core";
import type { NodeSnapshot, Snapshot, NativeEvent } from "@tarve/protocol";

const app = createApp(App, { debug: true });
const errors: string[] = [];
app.onEvent((event: NativeEvent) => { if (event.type === "error") errors.push(event.message); });
const settle = async (): Promise<Snapshot> => { await Bun.sleep(100); return app.inspect(); };
function node(snapshot: Snapshot, id: string): NodeSnapshot {
  const found = snapshot.nodes.find(item => item.id === id);
  assert(found, `Missing node: ${id}`);
  return found;
}
function choice(snapshot: Snapshot, role: string, label: string): NodeSnapshot {
  const found = snapshot.nodes.find(item => item.control?.role === role && item.control.label === label);
  assert(found, `Missing ${role}: ${label}`);
  return found;
}
function key(value: string): void { app.debug({ type: "input", action: "key", text: value }); }
async function click(id: string): Promise<Snapshot> {
  const item = node(await app.inspect(), id);
  app.debug({ type: "input", action: "move", x: item.x + item.width / 2, y: item.y + item.height / 2 });
  app.debug({ type: "input", action: "down" });
  app.debug({ type: "input", action: "up" });
  return settle();
}

try {
  await app.ready;
  const initial = await settle();
  await mkdir(resolve("work"), { recursive: true });
  await app.capture(resolve("work/forms.png"));
  assert(initial.frames > 0);
  assert.equal(node(initial, "updates").control?.checked, false);
  assert.equal(node(initial, "notifications").control?.checked, true);
  assert.equal(node(initial, "volume").control?.value, 36);
  assert.equal(node(initial, "volume-progress").control?.value, 36);

  const checkbox = await click("updates");
  assert.equal(node(checkbox, "updates").control?.checked, true, "Checkbox click must change state");
  const switched = await click("notifications");
  assert.equal(node(switched, "notifications").control?.checked, false, "Switch click must change state");

  app.focus("volume");
  key("ArrowRight");
  const slider = await settle();
  assert.equal(node(slider, "volume").control?.value, 40, "Slider keyboard step must update Bun state");
  assert.equal(node(slider, "volume-progress").control?.value, 40, "Progress must follow the same state");
  key("End");
  const end = await settle();
  assert.equal(node(end, "volume").control?.value, 100, "Slider End key must reach maximum");

  const billing = choice(end, "tab", "Billing");
  app.focus(billing.id);
  key("Enter");
  const tabbed = await settle();
  assert.equal(choice(tabbed, "tab", "Billing").control?.checked, true, "Tab must activate by keyboard");
  const personal = choice(tabbed, "radio", "Personal");
  app.focus(personal.id);
  key("Space");
  const radio = await settle();
  assert.equal(choice(radio, "radio", "Personal").control?.checked, true, "Radio choice must activate by keyboard");
  assert.equal(node(radio, "selected-plan").text, "Selected: personal");
  const enterprise = choice(radio, "radio", "Enterprise");
  app.focus(enterprise.id);
  assert.notEqual((await settle()).focused, enterprise.id, "Disabled option must not take focus");

  const idleBefore = await app.inspect();
  await Bun.sleep(300);
  const idleAfter = await app.inspect();
  assert.equal(idleAfter.frames, idleBefore.frames, "Controls must not keep a frame loop running");
  assert.deepEqual(errors, []);
  console.log(JSON.stringify({ result: "PASS", controls: ["Checkbox", "Switch", "Slider", "Progress", "Tabs", "RadioGroup", "disabled", "idle"] }, null, 2));
} finally {
  app.close();
  await app.closed;
}
