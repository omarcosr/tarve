import { strict as assert } from "node:assert";
import { mkdir } from "node:fs/promises";
import { resolve } from "node:path";
import { App } from "../examples/forms-view";
import { createApp } from "@tarve/core-internal";
import type { NodeSnapshot, Snapshot, NativeEvent } from "@tarve/protocol";

const app = createApp(App, { debug: true });
const errors: string[] = [];
app.onEvent((event: NativeEvent) => { if (event.type === "error") errors.push(event.message); });
// Bun-state round trips (native event -> JS render -> native patch) are async,
// so a fixed sleep races on slow CI runners. Poll until the expectation holds.
async function settle(ready: (snapshot: Snapshot) => boolean = () => true, timeoutMs = 5_000): Promise<Snapshot> {
  await Bun.sleep(100);
  const deadline = Date.now() + timeoutMs;
  let snapshot = await app.inspect();
  while (!ready(snapshot) && Date.now() < deadline) {
    await Bun.sleep(50);
    snapshot = await app.inspect();
  }
  return snapshot;
}
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
async function click(id: string, ready?: (snapshot: Snapshot) => boolean): Promise<Snapshot> {
  const item = node(await app.inspect(), id);
  app.debug({ type: "input", action: "move", x: item.x + item.width / 2, y: item.y + item.height / 2 });
  app.debug({ type: "input", action: "down" });
  app.debug({ type: "input", action: "up" });
  return settle(ready);
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
  assert.equal(node(initial, "role-select-trigger").control?.label, "Developer");

  const has = (id: string) => (s: Snapshot) => s.nodes.some(item => item.id === id);
  const selectOpen = await click("role-select-trigger", has("role-select-option-designer"));
  assert(node(selectOpen, "role-select-option-designer"), "Select popup must render its options");
  const selectedRole = await click("role-select-option-designer", s => node(s, "role-select-trigger").control?.label === "Designer" && !has("role-select-option-designer")(s));
  assert.equal(node(selectedRole, "role-select-trigger").control?.label, "Designer");
  assert.equal(selectedRole.nodes.some(item => item.id === "role-select-option-designer"), false,
    "Select popup must close after choosing an option");

  await click("role-select-trigger", has("role-select-option-manager"));
  assert(node(await app.inspect(), "role-select-option-manager"), "Select must reopen");
  app.focus("profile-notes");
  const blurredSelect = await settle(s => !has("role-select-option-manager")(s));
  assert.equal(blurredSelect.nodes.some(item => item.id === "role-select-option-manager"), false,
    "Select popup must close when its trigger loses focus");

  app.debug({ type: "input", action: "text", text: "First line" });
  key("Enter");
  app.debug({ type: "input", action: "text", text: "Second line" });
  const textarea = await settle(s => node(s, "profile-notes").text === "First line\nSecond line");
  assert.equal(node(textarea, "profile-notes").text, "First line\nSecond line",
    "TextArea must accept multiline native input");

  const checkbox = await click("updates", s => node(s, "updates").control?.checked === true);
  assert.equal(node(checkbox, "updates").control?.checked, true, "Checkbox click must change state");
  const switched = await click("notifications", s => node(s, "notifications").control?.checked === false);
  assert.equal(node(switched, "notifications").control?.checked, false, "Switch click must change state");

  app.focus("volume");
  key("ArrowRight");
  const slider = await settle(s => node(s, "volume-progress").control?.value === 40);
  assert.equal(node(slider, "volume").control?.value, 40, "Slider keyboard step must update Bun state");
  assert.equal(node(slider, "volume-progress").control?.value, 40, "Progress must follow the same state");
  key("End");
  const end = await settle(s => node(s, "volume").control?.value === 100 && node(s, "volume-progress").control?.value === 100);
  assert.equal(node(end, "volume").control?.value, 100, "Slider End key must reach maximum");

  const billing = choice(end, "tab", "Billing");
  app.focus(billing.id);
  key("Enter");
  const tabbed = await settle(s => choice(s, "tab", "Billing").control?.selected === true);
  assert.equal(choice(tabbed, "tab", "Billing").control?.selected, true, "Tab must activate by keyboard");
  const personal = choice(tabbed, "radio", "Personal");
  app.focus(personal.id);
  key("Space");
  const radio = await settle(s => node(s, "selected-plan").text === "Selected: personal");
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
  console.log(JSON.stringify({ result: "PASS", controls: ["Checkbox", "Switch", "Slider", "Progress", "Tabs", "RadioGroup", "Select", "TextArea", "disabled", "idle"] }, null, 2));
} finally {
  app.close();
  await app.closed;
}
