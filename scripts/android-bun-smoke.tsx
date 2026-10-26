// Bun on Android, end to end: build with
//   bunx tarve build scripts/android-bun-smoke.tsx --target android-x64 --runtime bun --permission CAMERA
// install, launch, and read `adb logcat -s tarve`: the app logs one "android-bun-smoke" JSON line
// (Bun APIs inside the app sandbox, the bridge round trip, notify and permissions), then closes.
import { Button, Column, Text, Window, createApp } from "@tarve/core";
import { Database } from "bun:sqlite";
import { join } from "node:path";

let status = "running";
const app = createApp(() => (
  <Window title="Bun on Android">
    <Column flex={1} align="center" justify="center" gap={12}>
      <Text id="status">{status}</Text>
      <Button id="ok" onClick={() => app.close()}>Close</Button>
    </Column>
  </Window>
));
await app.ready;

const results: Record<string, unknown> = { platform: process.platform, arch: process.arch, bun: Bun.version };
async function check(name: string, run: () => unknown | Promise<unknown>): Promise<void> {
  try { results[name] = await run(); } catch (error) { results[name] = `ERROR ${(error as Error)?.message ?? error}`; }
}
await check("home", () => process.env.HOME);
await check("file", async () => {
  const path = join(process.env.HOME ?? ".", "bun-smoke.txt");
  await Bun.write(path, "written by Bun");
  return await Bun.file(path).text();
});
await check("sqlite", () => {
  const db = new Database(join(process.env.HOME ?? ".", "bun-smoke.db"));
  db.run("create table if not exists t (v integer)");
  db.run("insert into t values (42)");
  const row = db.query("select count(*) as n from t").get() as { n: number };
  db.close();
  return row.n > 0;
});
await check("fetch", async () => (await fetch("https://example.com", { signal: AbortSignal.timeout(10_000) })).status);
await check("spawn", () => Bun.spawnSync(["/system/bin/toybox", "echo", "spawned"]).stdout.toString().trim());
await check("shell", async () => (await Bun.$`echo shell`.text()).trim());
await check("worker", async () => {
  const worker = new Worker(URL.createObjectURL(new Blob(["postMessage(6 * 7)"], { type: "application/javascript" })));
  const value = await new Promise(resolve => { worker.onmessage = event => resolve(event.data); });
  worker.terminate();
  return value;
});
await check("layout", () => app.layout(["status"])?.status?.width ?? null);
await check("checkPermissions", () => app.checkPermissions(["CAMERA"]));
await check("notify", () => { app.notify({ title: "Tarve on Bun", body: "Sent from a Bun app on Android" }); return true; });
status = "done";
app.update();
console.log(`android-bun-smoke ${JSON.stringify(results)}`);
await Bun.sleep(1500);
app.close();
await app.closed;
