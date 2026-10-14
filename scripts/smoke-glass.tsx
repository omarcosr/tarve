// Liquid glass: a Glass box over sharp stripes shows them blurred (the D3D11 renderer),
// while a plain translucent box the same size shows them sharp. On renderers without a
// backdrop (wgpu, CPU) the glass box paints its tint only, and this smoke reports that.
import { createApp, Glass, readPngRgba, View, Window } from "@tarve/core";
import { strict as assert } from "node:assert";
import { mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";

const errors: string[] = [];
// A motion runs during the capture, so the captured frame is one prepared fresh (the
// fused glass once showed only on a frame's second draw).
let moving = false;
const app = createApp(() => (
  <Window title="Glass smoke" width={400} height={300} style={{ background: "#ffffff" }}>
    <View id="stage" style={{ position: "relative", flex: 1 }}>
      {Array.from({ length: 50 }, (_, i) => (
        <View key={i} style={{ position: "absolute", left: i * 8, top: 0, width: 4, height: 300, background: i % 2 ? "#ff0000" : "#0000ff" }} />
      ))}
      <Glass id="glass" tint="#ffffff10" radius={20} shadow={false} material={{ blur: 16, refraction: 12, highlight: 1 }}
        style={{ position: "absolute", left: 20, top: 40, width: 160, height: 100 }} />
      <View id="plain" style={{ position: "absolute", left: 220, top: 40, width: 160, height: 100, radius: 20, background: "#ffffff10" }} />
      <View id="mover" style={{ position: "absolute", left: moving ? 360 : 0, top: 280, width: 20, height: 20, radius: 10, background: "#00ff00", transition: { left: { duration: 20000, easing: "linear" } } }} />
      {/* Two drops 12 px apart that share a merge key (bridging within blend / 2) fuse; the same two without one keep the gap. */}
      {(["joined", "apart"] as const).map((kind, row) => [0, 1].map(column => (
        <Glass key={kind + column} id={`${kind}-${column}`} variant="clear" tint="#ffffffcc" radius={20} shadow={false}
          merge={kind === "joined" ? "drops" : undefined} blend={40} material={{ blur: 2, refraction: 10, highlight: 0 }}
          style={{ position: "absolute", left: 44 + row * 180 + column * 52, top: 200, width: 40, height: 40 }} />
      )))}
    </View>
  </Window>
), { debug: true, onError: event => errors.push(event.error.message) });

try {
  await app.ready;
  await sleep(300);
  moving = true;
  app.update();
  await sleep(400);
  mkdirSync(resolve("work"), { recursive: true });
  const path = resolve("work/smoke-glass.png");
  await app.capture(path);
  const image = await readPngRgba(path);
  const scale = image.width / 400;
  // Mean horizontal colour difference between neighbouring pixels: ~50 across the stripes, ~0 when blurred.
  const roughness = (x0: number, y0: number, x1: number, y1: number) => {
    let sum = 0, count = 0;
    for (let y = Math.floor(y0 * scale); y < y1 * scale; y++) {
      for (let x = Math.floor(x0 * scale); x < x1 * scale - 1; x++) {
        const i = (y * image.width + x) * 4;
        sum += Math.abs(image.rgba[i]! - image.rgba[i + 4]!) + Math.abs(image.rgba[i + 2]! - image.rgba[i + 6]!);
        count++;
      }
    }
    return sum / count;
  };
  const glass = roughness(50, 60, 150, 120);
  const plain = roughness(250, 60, 350, 120);
  const stripes = roughness(50, 160, 150, 190);
  assert.ok(stripes > 30, `stripes are sharp outside both boxes (${stripes.toFixed(1)})`);
  assert.ok(plain > 30, `a plain translucent box keeps the stripes sharp (${plain.toFixed(1)})`);
  // D3D11 (Windows GPU) has a glyph atlas and the backdrop; wgpu and the CPU renderer paint the tint only.
  const backdrop = process.platform === "win32" && typeof (await app.inspect()).glyphRasterizations === "number" && process.env.TARVE_RENDERER !== "cpu";
  // The darkest channel around the midpoint of each pair's gap: a bare stripe is saturated
  // (one channel near 0), under the merged pair's veil it is whitened.
  const whiteness = (x: number, y: number) => {
    let darkest = 255;
    for (let dx = -4; dx <= 4; dx++) { const i = (Math.round(y * scale) * image.width + Math.round((x + dx) * scale)) * 4; darkest = Math.min(darkest, image.rgba[i]!, image.rgba[i + 1]!, image.rgba[i + 2]!); }
    return darkest;
  };
  const joined = whiteness(90, 220);
  const apart = whiteness(270, 220);
  // The fused pair is one surface, so no edge light crosses the midpoint between them.
  assert.ok(apart < 40, `unmerged drops leave the gap between them bare (${apart})`);
  if (backdrop) {
    assert.ok(glass < 4, `the glass box blurs the stripes (${glass.toFixed(1)})`);
    assert.ok(joined > 120, `merged drops bridge the gap between them (${joined})`);
    console.log(`[smoke-glass] PASS: blurred backdrop ${glass.toFixed(1)} vs sharp ${plain.toFixed(1)}; merged gap ${joined} vs ${apart}`);
  } else {
    console.log(`[smoke-glass] PASS (no backdrop on this renderer: tint only, roughness ${glass.toFixed(1)})`);
  }
  assert.ok((await app.inspect()).activeMotions > 0, "the capture happened during the motion");
  assert.deepEqual(errors, []);
} finally {
  app.close();
  await app.closed;
}
