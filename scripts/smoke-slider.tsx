// Styled sliders on every renderer (CPU, D3D11, Vello): a gradient brightness capsule
// (trackThickness "fill", no thumb), a pill thumb with a gradient, ring and shadow, a fill
// shorter than the capsule's round ends, and a vertical capsule. Each mode's capture is checked by pixel, then compared with the CPU's.
//   bun scripts/smoke-slider.tsx        (TARVE_SMOKE_FORCED_WGPU=0 skips forced Vello)
import { strict as assert } from "node:assert";
import { spawnSync } from "node:child_process";
import { mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { createApp, readPngRgba, Slider, View, Window } from "@tarve/core";
import { smokeRendererModes } from "./smoke-renderer-modes";

const label = process.env.TARVE_SMOKE_LABEL;
const capturePath = (name: string) => resolve(`work/smoke-slider-${name}.png`);
type Png = Awaited<ReturnType<typeof readPngRgba>>;
const pixel = (png: Png, x: number, y: number) => {
  const scale = png.width / 320;
  const i = (Math.round(y * scale) * png.width + Math.round(x * scale)) * 4;
  return [png.rgba[i]!, png.rgba[i + 1]!, png.rgba[i + 2]!] as const;
};
const near = (actual: readonly number[], expected: readonly number[], tolerance: number) =>
  actual.every((value, index) => Math.abs(value - expected[index]!) <= tolerance);

if (!label) {
  const script = fileURLToPath(import.meta.url);
  const modes = smokeRendererModes();
  for (const mode of modes) {
    const env: NodeJS.ProcessEnv = { ...process.env, TARVE_SMOKE_LABEL: mode.label, TARVE_RENDERER: mode.renderer };
    if (mode.wgpuBackend) env.WGPU_BACKEND = mode.wgpuBackend;
    else delete env.WGPU_BACKEND;
    const child = spawnSync(process.execPath, [script], { cwd: resolve(import.meta.dirname, ".."), env, stdio: "inherit" });
    assert.equal(child.status, 0, `slider smoke failed on ${mode.label}`);
  }
  // Parity: every renderer's capture matches the CPU's but for antialiasing.
  const reference = await readPngRgba(capturePath("cpu"));
  for (const mode of modes.filter(mode => mode.label !== "cpu")) {
    const other = await readPngRgba(capturePath(mode.label));
    assert.equal(other.width, reference.width, `${mode.label} capture size`);
    let different = 0;
    for (let i = 0; i < reference.rgba.length; i += 4) {
      const delta = Math.abs(reference.rgba[i]! - other.rgba[i]!) + Math.abs(reference.rgba[i + 1]! - other.rgba[i + 1]!) + Math.abs(reference.rgba[i + 2]! - other.rgba[i + 2]!);
      if (delta > 48) different++;
    }
    const percent = (100 * different) / (reference.width * reference.height);
    assert.ok(percent < 0.5, `${mode.label} differs from cpu on ${percent.toFixed(2)}% of pixels`);
    console.log(`[smoke-slider] ${mode.label} matches cpu (${percent.toFixed(3)}% differ)`);
  }
  console.log(`[smoke-slider] PASS on ${modes.map(mode => mode.label).join(", ")}`);
} else {
  const errors: string[] = [];
  const app = createApp(() => (
    <Window title="Slider smoke" width={320} height={240} style={{ background: "#000000" }}>
      <View style={{ position: "relative", flex: 1 }}>
        <Slider id="brightness" value={50} label="Brightness"
          style={{ position: "absolute", left: 20, top: 20, width: 200, height: 34, radius: 17,
            trackThickness: "fill", thumbSize: 0, trackBackground: "#00ff00",
            foreground: "linear-gradient(to right, #ff0000, #0000ff)" }} />
        <Slider id="pill" value={50} label="Pill"
          style={{ position: "absolute", left: 20, top: 80, width: 200, height: 40, trackThickness: 6,
            borderColor: "#333333", foreground: "#ffffff", thumbWidth: 36, thumbHeight: 24, thumbRadius: 4,
            thumbColor: "linear-gradient(#ff0000 50%, #0000ff 50%)", thumbBorderWidth: 2, thumbBorderColor: "#ffff00",
            thumbShadow: "0 10px #00ff00" }} />
        <Slider id="short" value={12} label="Short fill"
          style={{ position: "absolute", left: 20, top: 140, width: 200, height: 34, radius: 17,
            trackThickness: "fill", thumbSize: 0, trackBackground: "#00ff00", foreground: "#0000ff" }} />
        <Slider id="vertical" value={25} orientation="vertical" label="Volume"
          style={{ position: "absolute", left: 260, top: 20, width: 40, height: 160, radius: 12,
            trackThickness: "fill", thumbSize: 0, foreground: "#ffffff", trackBackground: "#ff0000" }} />
      </View>
    </Window>
  ), { debug: true, onError: event => errors.push(event.error.message) });
  try {
    await app.ready;
    await sleep(300);
    mkdirSync(resolve("work"), { recursive: true });
    const path = capturePath(label);
    await app.capture(path);
    const png = await readPngRgba(path);
    const checks: [string, number, number, readonly number[], number][] = [
      ["capsule gradient a quarter in", 70, 37, [191, 0, 64], 16],
      ["capsule fill reaches the top", 100, 22, [128, 0, 128], 40],
      ["capsule track past the value", 170, 37, [0, 255, 0], 4],
      ["capsule rounded corner", 21, 21, [0, 0, 0], 4],
      ["thumb gradient top", 120, 94, [255, 0, 0], 4],
      ["thumb gradient bottom", 120, 106, [0, 0, 255], 4],
      ["thumb shadow", 120, 117, [0, 255, 0], 4],
      // A fill shorter than both round ends: the track's capsule cuts it (overflow: hidden).
      ["short fill", 39, 157, [0, 0, 255], 4],
      ["short fill cut by the track's round end", 27, 141, [0, 0, 0], 24],
      ["vertical fill from the bottom", 280, 170, [255, 255, 255], 4],
      ["vertical track above", 280, 60, [255, 0, 0], 4],
    ];
    for (const [what, x, y, expected, tolerance] of checks) {
      const actual = pixel(png, x, y);
      assert.ok(near(actual, expected, tolerance), `${label}: ${what} at ${x},${y} is ${actual.join(",")}, expected ${expected.join(",")}`);
    }
    assert.deepEqual(errors, []);
    console.log(`[smoke-slider] ${label}: ${checks.length} pixel checks pass`);
  } finally {
    app.close();
    await app.closed;
  }
}
