import { writeFileSync } from "node:fs";
import { dirname, isAbsolute, join } from "node:path";
import type { AppHandle } from "@tarve/core-internal";
import type { Snapshot } from "@tarve/protocol";

// Runtime-neutral (Bun, Node.js SEA, txiki.js): no node:assert, no Bun globals.
function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}
const sleep = (milliseconds: number) => new Promise(resolve => setTimeout(resolve, milliseconds));
const same = (actual: unknown, expected: unknown, message: string) => assert(JSON.stringify(actual) === JSON.stringify(expected), `${message} (got ${JSON.stringify(actual)})`);

/** Runs inside the actual compiled executable using its embedded native runtime. */
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
    await sleep(100);
    initial = await app.inspect();
  }
  assert(initial.frames > 0, "Renderer must present a frame from the standalone executable");
  assert(initial.shapes > 3, "Parley must shape text from the standalone executable");
  await app.capture(join(dirname(reportPath), "executable.png"));
  const button = node(initial, "smoke-action");
  app.debug({ type: "input", action: "move", x: button.x + button.width / 2, y: button.y + button.height / 2 });
  app.debug({ type: "input", action: "down" });
  app.debug({ type: "input", action: "up" });
  await sleep(200);
  const clicked = await app.inspect();
  same(node(clicked, "smoke-status").text, "Clicked: 1", "FFI events must roundtrip to the embedded runtime");
  app.debug({ type: "input", action: "move", x: -1, y: -1 });
  await sleep(150);
  const before = await app.inspect();
  await sleep(350);
  const after = await app.inspect();
  same(after.frames, before.frames, "Idle standalone executable must not run a frame loop");
  same(errors, [], "Native standalone runtime must not report errors");
  writeFileSync(reportPath, JSON.stringify({ result: "PASS", executable: process.execPath, cwd: process.cwd(), frames: after.frames, nodes: initial.nodes.length, ffiEvents: true, idleFrames: after.frames - before.frames }, null, 2));
}
