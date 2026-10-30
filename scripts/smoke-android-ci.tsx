// Android end-to-end smoke for CI (an emulator): build with
//   bun packages/core/cli.ts build scripts/smoke-android-ci.tsx --target android-x64 --name CiSmoke --app-id dev.tarve.cismoke --outfile dist/CiSmoke.apk
// install, launch and read `adb logcat -s tarve`: the app logs one "tarve-ci-smoke <json>" line with
// what it checked on the device (render, layout, input, motion clock, storage, timers), then closes.
import { Button, Column, Input, Text, Window, createApp } from "@tarve/core";
import { readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

let clicks = 0;
const app = createApp(() => (
  <Window title="CI smoke">
    <Column id="main" style={{ padding: 16, gap: 8 }}>
      <Text id="title">Tarve on Android</Text>
      <Button id="press" onClick={() => { clicks++; app.update(); }}>{`Clicks: ${clicks}`}</Button>
      <Input id="field" placeholder="Type" />
      <Column id="box" style={{ width: 120, height: 40, background: "#2563eb", transform: "translateX(10%)" }} />
    </Column>
  </Window>
), { debug: true });

const results: Record<string, unknown> = { platform: process.platform };
async function check(name: string, run: () => unknown | Promise<unknown>): Promise<void> {
  try { results[name] = await run(); } catch (error) { results[name] = `ERROR ${(error as Error)?.message ?? error}`; }
}

await app.ready;
await check("timer", () => new Promise(resolve => setTimeout(() => resolve(true), 50)));
await check("storage", () => {
  const path = join(tmpdir(), "tarve-ci-smoke.txt");
  writeFileSync(path, "ok");
  return readFileSync(path, "utf8") === "ok";
});
await check("layout", async () => {
  const snapshot = await app.inspect();
  const box = snapshot.nodes.find(node => node.id === "box");
  return !!box && Math.round(box.width) === 120 && Math.round(box.height) === 40 && snapshot.width > 0;
});
await check("click", async () => {
  const snapshot = await app.inspect();
  const press = snapshot.nodes.find(node => node.id === "press");
  if (!press) return "no button";
  const x = press.x + press.width / 2, y = press.y + press.height / 2;
  app.debug({ type: "input", action: "move", x, y });
  app.debug({ type: "input", action: "down" });
  app.debug({ type: "input", action: "up" });
  await new Promise(resolve => setTimeout(resolve, 300));
  return clicks === 1;
});
const ok = Object.entries(results).every(([key, value]) => key === "platform" ? value === "android" : value === true);
console.log(`tarve-ci-smoke ${JSON.stringify({ ok, ...results })}`);
app.close();
