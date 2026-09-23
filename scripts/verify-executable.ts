import { strict as assert } from "node:assert";
import { dirname, isAbsolute, join } from "node:path";
import type { AppHandle } from "@tarve/core";
import type { Snapshot } from "@tarve/protocol";

/** Runs inside the actual compiled EXE, using its embedded DLL and image. */
export async function verifyExecutable(app: AppHandle, errors: string[]): Promise<void> {
  const reportIndex = process.argv.indexOf("--smoke-report");
  const reportPath = reportIndex >= 0 ? process.argv[reportIndex + 1] : undefined;
  assert(reportPath && isAbsolute(reportPath), "--smoke-report requires an absolute path");
  const node = (snapshot: Snapshot, id: string) => {
    const item = snapshot.nodes.find(n => n.id === id);
    assert(item, `Missing node: ${id}`);
    return item;
  };
  let initial = await app.inspect();
  for (let i = 0; initial.frames === 0 && i < 50; i++) {
    await Bun.sleep(100);
    initial = await app.inspect();
  }
  assert(initial.frames > 0, "Vello must present a frame from the EXE");
  assert(initial.shapes > 20, "Parley must shape text from the EXE");
  const image = node(initial, "local-image");
  assert(image.width > 100 && image.height === 144, "Embedded image must have a real layout");
  await app.capture(join(dirname(reportPath), "executable.png"));
  const button = node(initial, "new-project");
  app.debug({ type: "input", action: "move", x: button.x + button.width / 2, y: button.y + button.height / 2 });
  app.debug({ type: "input", action: "down" });
  app.debug({ type: "input", action: "up" });
  await Bun.sleep(200);
  const clicked = await app.inspect();
  assert.equal(node(clicked, "save-status").text, "Project 1 created", "FFI events must roundtrip to embedded Bun");
  app.debug({ type: "input", action: "move", x: -1, y: -1 });
  await Bun.sleep(150);
  const before = await app.inspect();
  await Bun.sleep(350);
  const after = await app.inspect();
  assert.equal(after.frames, before.frames, "Idle EXE must not run a frame loop");
  assert.deepEqual(errors, [], "Native EXE runtime must not report errors");
  await Bun.write(reportPath, JSON.stringify({ result: "PASS", executable: process.execPath, cwd: process.cwd(), frames: after.frames, nodes: initial.nodes.length, ffiEvents: true, idleFrames: after.frames - before.frames }, null, 2));
}
