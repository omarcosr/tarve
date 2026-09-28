import { strict as assert } from "node:assert";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { Button, Column, Text, Window, createApp, readPngRgba, type AppHandle, type RgbaImage } from "@tarve/core-internal";

// Real-window smoke for the development runtime tooling: dev error overlay,
// native frame-time overlay (and its zero-idle guarantee) and same-window
// remount under `bun --hot`.
const root = resolve(import.meta.dir, "..");
const work = resolve(root, "work");
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
const texts = async (app: AppHandle) => (await app.inspect()).nodes.map(node => node.text).join("\n");

{
  let broken = false;
  let count = 0;
  const app = createApp(() => {
    if (broken) throw new Error("smoke boom");
    return Window({
      title: "Tarve Devtools Smoke", width: 520, height: 360,
      children: Column({ padding: 16, gap: 8, children: [
        Text({ id: "count", children: `count ${count}` }),
        Button({ id: "bump", onClick: () => { count++; app.update(); }, children: "Bump" }),
      ] }),
    });
  }, { debug: true, dev: true, onError: () => {} });
  try {
    await app.ready;
    await settle();

    broken = true;
    app.update();
    await settle();
    assert.match(await texts(app), /smoke boom/, "render error shows the in-window overlay");
    broken = false;
    await click(app, "__tarve-dev-error-dismiss");
    assert.match(await texts(app), /count 0/, "dismiss renders the app again");

    const plain = resolve(work, "devtools-plain.png");
    const graph = resolve(work, "devtools-frame-overlay.png");
    await app.capture(plain);
    app.setFrameOverlay(true);
    for (let index = 0; index < 5; index++) await click(app, "bump");
    await app.capture(graph);
    const corner = (image: RgbaImage) => {
      let sum = 0;
      for (let y = image.height - 60; y < image.height - 8; y++) {
        for (let x = image.width - 190; x < image.width - 8; x++) {
          const i = (y * image.width + x) * 4;
          sum += image.rgba[i]! + image.rgba[i + 1]! + image.rgba[i + 2]!;
        }
      }
      return sum;
    };
    assert.notEqual(corner(await readPngRgba(graph)), corner(await readPngRgba(plain)), "frame overlay paints the corner graph");

    await Bun.sleep(600);
    const before = (await app.inspect()).frames;
    await Bun.sleep(1_000);
    assert.equal((await app.inspect()).frames, before, "frame overlay must not schedule frames while idle");
  } finally {
    app.close();
    await app.closed;
  }
}

{
  const entry = resolve(work, "devtools-hot-entry.ts");
  const source = (version: string) => `import { Text, Window, render } from "@tarve/core-internal";
const key = Symbol.for("tarve.devApp");
const existing = Boolean((globalThis as Record<symbol, unknown>)[key]);
console.log("MOUNT ${version} existing=" + existing);
void render(() => Window({ title: "Tarve Hot Smoke", width: 320, height: 160, children: Text({ id: "version", children: "${version}" }) }), { dev: true });
setTimeout(async () => {
  const app = (globalThis as Record<symbol, any>)[key];
  await app.ready;
  const snapshot = await app.inspect();
  console.log("SNAP ${version} " + snapshot.nodes.some((node: { text: string }) => node.text === "${version}"));
}, 700);
`;
  await writeFile(entry, source("v1"));
  const child = Bun.spawn([process.execPath, "--hot", entry], {
    cwd: root, env: { ...process.env, TARVE_DEV: "1" }, stdout: "pipe", stderr: "inherit",
  });
  const lines: string[] = [];
  const decoder = new TextDecoder();
  void (async () => {
    for await (const chunk of child.stdout) lines.push(...decoder.decode(chunk).split(/\r?\n/).filter(Boolean));
  })();
  const waitFor = async (line: string) => {
    const deadline = Date.now() + 20_000;
    while (!lines.includes(line)) {
      assert(Date.now() < deadline, `timed out waiting for "${line}"; got ${JSON.stringify(lines)}`);
      assert.equal(child.exitCode, null, `hot process exited early; got ${JSON.stringify(lines)}`);
      await Bun.sleep(100);
    }
  };
  try {
    await waitFor("MOUNT v1 existing=false");
    await waitFor("SNAP v1 true");
    await writeFile(entry, source("v2"));
    await waitFor("MOUNT v2 existing=true");
    await waitFor("SNAP v2 true");
  } finally {
    child.kill();
    await child.exited;
    await rm(entry, { force: true });
  }
}

console.log("[tarve smoke:devtools] PASS");
