import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { mount } from "../../packages/svelte/src/index";
import InputProbe from "./InputProbe.svelte";

// Real input for scripts/smoke-svelte-input.ts: reports where its targets are on screen,
// then what the app saw, until the driver asks it to quit.
const directory = process.argv[process.argv.indexOf("--input-dir") + 1]!;
const { app, target, component } = mount(InputProbe, { window: { width: 420, height: 420 } });
const probe = component as unknown as { snapshot(): Record<string, unknown> };
await app.ready;
await new Promise(resolve => setTimeout(resolve, 500));
const snapshot = await app.inspect();
const rects = Object.fromEntries(["button", "field", "rich", "pane"].map(id => {
  const rect = target.querySelector("#" + id)!.getBoundingClientRect();
  return [id, { x: rect.x, y: rect.y, width: rect.width, height: rect.height }];
}));
writeFileSync(join(directory, "targets.json"), JSON.stringify({ scale: snapshot.scale, rects }));
const timer = setInterval(() => {
  writeFileSync(join(directory, "state.json"), JSON.stringify(probe.snapshot()));
  if (existsSync(join(directory, "quit"))) { clearInterval(timer); app.close(); }
}, 100);
await app.closed;
