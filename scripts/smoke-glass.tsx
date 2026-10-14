// Liquid glass: a Glass box over sharp stripes shows them blurred (the D3D11 renderer),
// while a plain translucent box the same size shows them sharp. On renderers without a
// backdrop (wgpu, CPU) the glass box paints its tint only, and this smoke reports that.
import { createApp, Glass, readPngRgba, View, Window } from "@tarve/core";
import { strict as assert } from "node:assert";
import { mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";

const errors: string[] = [];
const app = createApp(() => (
  <Window title="Glass smoke" width={400} height={300} style={{ background: "#ffffff" }}>
    <View id="stage" style={{ position: "relative", flex: 1 }}>
      {Array.from({ length: 50 }, (_, i) => (
        <View key={i} style={{ position: "absolute", left: i * 8, top: 0, width: 4, height: 300, background: i % 2 ? "#ff0000" : "#0000ff" }} />
      ))}
      <Glass id="glass" tint="#ffffff10" radius={20} shadow={false} material={{ blur: 16, refraction: 12, highlight: 1 }}
        style={{ position: "absolute", left: 20, top: 40, width: 160, height: 100 }} />
      <View id="plain" style={{ position: "absolute", left: 220, top: 40, width: 160, height: 100, radius: 20, background: "#ffffff10" }} />
    </View>
  </Window>
), { debug: true, onError: event => errors.push(event.error.message) });

try {
  await app.ready;
  await sleep(600);
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
  const stripes = roughness(50, 200, 150, 260);
  assert.ok(stripes > 30, `stripes are sharp outside both boxes (${stripes.toFixed(1)})`);
  assert.ok(plain > 30, `a plain translucent box keeps the stripes sharp (${plain.toFixed(1)})`);
  // D3D11 (Windows GPU) has a glyph atlas and the backdrop; wgpu and the CPU renderer paint the tint only.
  const backdrop = process.platform === "win32" && typeof (await app.inspect()).glyphRasterizations === "number" && process.env.TARVE_RENDERER !== "cpu";
  if (backdrop) {
    assert.ok(glass < 4, `the glass box blurs the stripes (${glass.toFixed(1)})`);
    console.log(`[smoke-glass] PASS: blurred backdrop ${glass.toFixed(1)} vs sharp ${plain.toFixed(1)}`);
  } else {
    console.log(`[smoke-glass] PASS (no backdrop on this renderer: tint only, roughness ${glass.toFixed(1)})`);
  }
  assert.deepEqual(errors, []);
} finally {
  app.close();
  await app.closed;
}
