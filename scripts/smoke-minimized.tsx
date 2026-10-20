// A minimized `lowPower` window gives its GPU device back like a hidden one, draws
// nothing while an animation runs, and asks Windows for EcoQoS; restored, it builds
// the device again and draws, updates made meanwhile included.
import { Column, createApp, Spinner, Text, Window } from "@tarve/core";
import { strict as assert } from "node:assert";
import { setTimeout as sleep } from "node:timers/promises";

let label = "before";
const errors: string[] = [];
const app = createApp(() => (
  <Window title="Minimized smoke" width={320} height={200}>
    <Column flex={1} align="center" justify="center" gap={8}>
      <Spinner size={32} />
      <Text id="label">{label}</Text>
    </Column>
  </Window>
), { debug: true, lowPower: true, renderer: "gpu", onError: event => errors.push(event.error.message) });

/** Video memory of this process in MB (DXGI, Windows), or undefined where unavailable. */
async function gpuMb(): Promise<number | undefined> {
  return ((await app.stats()).native.memory?.current as { gpuMb?: number } | undefined)?.gpuMb;
}

try {
  await app.ready;
  await sleep(1500);
  const shown = await app.inspect();
  assert.ok(shown.fps > 10, `an animating window draws (fps ${shown.fps})`);
  const gpuShown = await gpuMb();

  app.minimize();
  await sleep(1500);
  const before = (await app.inspect()).frames;
  label = "while minimized";
  app.update();
  await sleep(1500);
  const minimized = await app.inspect();
  assert.equal(minimized.frames, before, "a minimized window draws no frames");
  const gpuMinimized = await gpuMb();
  if (gpuShown !== undefined && gpuMinimized !== undefined) {
    assert.ok(gpuMinimized < gpuShown, `video memory is given back while minimized (${gpuShown} → ${gpuMinimized} MB)`);
  }

  const restoredAt = performance.now();
  app.show();
  let again = await app.inspect();
  while (again.frames <= minimized.frames && performance.now() - restoredAt < 5000) {
    await sleep(5);
    again = await app.inspect();
  }
  const firstFrameAfterRestoreMs = Math.round(performance.now() - restoredAt);
  await sleep(1000);
  again = await app.inspect();
  assert.ok(again.frames > minimized.frames && again.fps > 10, `restored, it draws (fps ${again.fps})`);
  assert.equal(again.nodes.find(node => node.id === "label")?.text, "while minimized", "updates made while minimized are shown");
  assert.deepEqual(errors, []);
  console.log(`[tarve smoke:minimized] PASS ${JSON.stringify({ fpsShown: shown.fps, fpsAgain: again.fps, gpuShown, gpuMinimized, firstFrameAfterRestoreMs })}`);
} finally {
  app.close();
}
