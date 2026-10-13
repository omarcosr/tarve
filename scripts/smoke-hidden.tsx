// A window hidden to the tray (app.hide()) gives its GPU resources back and draws
// nothing, even with an animation running; updates made meanwhile show up once
// app.show() brings it back, with frames again.
import { Column, createApp, Spinner, Text, Window } from "@tarve/core";
import { strict as assert } from "node:assert";
import { execFileSync } from "node:child_process";
import { rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";

let label = "before";
const errors: string[] = [];
const app = createApp(() => (
  <Window title="Hidden smoke" width={320} height={200}>
    <Column flex={1} align="center" justify="center" gap={8}>
      <Spinner size={32} />
      <Text id="label">{label}</Text>
    </Column>
  </Window>
), { debug: true, closeBehavior: "hide", onError: event => errors.push(event.error.message) });

/** Dedicated + shared GPU memory of this process in MB (Windows), or null where unavailable. */
function gpuMb(): number | null {
  if (process.platform !== "win32") return null;
  try {
    const out = execFileSync("powershell", ["-NoProfile", "-Command",
      `[math]::Round((((Get-Counter '\\GPU Process Memory(pid_${process.pid}_*)\\Shared Usage','\\GPU Process Memory(pid_${process.pid}_*)\\Dedicated Usage' -ErrorAction Stop).CounterSamples | Measure-Object CookedValue -Sum).Sum) / 1MB)`],
    { encoding: "utf8", windowsHide: true }).trim();
    return Number(out);
  } catch { return null; }
}

try {
  await app.ready;
  await sleep(1500);
  const shown = await app.inspect();
  assert.ok(shown.fps > 10, `an animating window draws (fps ${shown.fps})`);
  const gpuShown = gpuMb();

  app.hide();
  await sleep(1500);
  const before = (await app.inspect()).frames;
  label = "while hidden";
  app.update();
  await sleep(1500);
  const hidden = await app.inspect();
  assert.equal(hidden.frames, before, "a hidden window draws no frames");
  assert.equal(hidden.fps, 0);
  const gpuHidden = gpuMb();
  if (gpuShown !== null && gpuHidden !== null && gpuShown > 0) {
    assert.ok(gpuHidden < gpuShown / 4, `GPU memory is given back while hidden (${gpuShown} → ${gpuHidden} MB)`);
  }
  // Capturing a hidden window still works (tests and tools capture hidden windows).
  const capture = join(tmpdir(), `tarve-hidden-${process.pid}.png`);
  await app.capture(capture);
  assert.ok(statSync(capture).size > 0, "a hidden window captures");
  rmSync(capture, { force: true });
  assert.equal((await app.inspect()).fps, 0, "and it stays parked afterwards");

  app.show();
  await sleep(1500);
  const again = await app.inspect();
  assert.ok(again.frames > hidden.frames && again.fps > 10, `shown again, it draws (fps ${again.fps})`);
  assert.equal(again.nodes.find(node => node.id === "label")?.text, "while hidden", "updates made while hidden are shown");
  assert.deepEqual(errors, []);
  console.log(`[tarve smoke:hidden] PASS ${JSON.stringify({ fpsShown: shown.fps, fpsAgain: again.fps, gpuShown, gpuHidden })}`);
} finally {
  app.close();
}
