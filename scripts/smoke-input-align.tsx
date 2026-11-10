// A single-line Input honours `textAlign` on every renderer (CPU, D3D11, Vello): left, center
// and right ink sit at the edges and the middle of the content box, a right-to-left `start`
// value at the right, a placeholder centres, and a focused line wider than the field scrolls to
// its end inside the content box (the padding stays clear). Each mode's capture is checked by
// pixel, then compared with the CPU's.
//   bun scripts/smoke-input-align.tsx        (TARVE_SMOKE_FORCED_WGPU=0 skips forced Vello)
import { strict as assert } from "node:assert";
import { spawnSync } from "node:child_process";
import { mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { createApp, Input, readPngRgba, View, Window } from "@tarve/core";
import { smokeRendererModes } from "./smoke-renderer-modes";

const WIDTH = 320;
const label = process.env.TARVE_SMOKE_LABEL;
const capturePath = (name: string) => resolve(`work/smoke-input-align-${name}.png`);
type Png = Awaited<ReturnType<typeof readPngRgba>>;

/** Field boxes: left 20, width 240, 8px padding, so the content box is x 28..252. */
const LEFT = 28, RIGHT = 252, CENTRE = (LEFT + RIGHT) / 2;
const LONG = "The quick brown fox jumps over the lazy dog 0123456789";
const rows = [
  { id: "left", top: 10, value: "MMMM", textAlign: "left" },
  { id: "center", top: 52, value: "MMMM", textAlign: "center" },
  { id: "right", top: 94, value: "MMMM", textAlign: "right" },
  { id: "rtl", top: 136, value: "שלום עולם", textAlign: "start" },
  { id: "placeholder", top: 178, value: "", textAlign: "center", placeholder: "Search" },
  { id: "overflow", top: 220, value: LONG, textAlign: "center" },
] as const;

/** Leftmost and rightmost CSS x in a row's band whose pixel passes `ink`. */
function inkSpan(png: Png, top: number, ink: (r: number, g: number, b: number) => boolean): [number, number] {
  const scale = png.width / WIDTH;
  let min = Infinity, max = -Infinity;
  for (let y = Math.round((top + 4) * scale); y < Math.round((top + 32) * scale); y++) {
    for (let x = 0; x < png.width; x++) {
      const i = (y * png.width + x) * 4;
      if (ink(png.rgba[i]!, png.rgba[i + 1]!, png.rgba[i + 2]!)) {
        min = Math.min(min, x / scale);
        max = Math.max(max, (x + 1) / scale);
      }
    }
  }
  return [min, max];
}
const black = (r: number, g: number, b: number) => r < 110 && g < 110 && b < 110;
const blue = (r: number, g: number, b: number) => b > 150 && r < 140 && g < 140;

if (!label) {
  const script = fileURLToPath(import.meta.url);
  const modes = smokeRendererModes();
  for (const mode of modes) {
    const env: NodeJS.ProcessEnv = { ...process.env, TARVE_SMOKE_LABEL: mode.label, TARVE_RENDERER: mode.renderer };
    if (mode.wgpuBackend) env.WGPU_BACKEND = mode.wgpuBackend;
    else delete env.WGPU_BACKEND;
    const child = spawnSync(process.execPath, [script], { cwd: resolve(import.meta.dirname, ".."), env, stdio: "inherit" });
    assert.equal(child.status, 0, `input-align smoke failed on ${mode.label}`);
  }
  // Parity: every renderer's capture matches the CPU's but for glyph antialiasing. GPU glyph
  // rasterizers place edges up to a device pixel apart, so a pixel differs only when nothing in
  // the other capture's 3x3 neighbourhood matches it: text one pixel off passes, text aligned
  // elsewhere does not.
  const reference = await readPngRgba(capturePath("cpu"));
  const close = (a: Png, i: number, b: Png, j: number) =>
    Math.abs(a.rgba[i]! - b.rgba[j]!) + Math.abs(a.rgba[i + 1]! - b.rgba[j + 1]!) + Math.abs(a.rgba[i + 2]! - b.rgba[j + 2]!) <= 48;
  const unmatched = (a: Png, b: Png) => {
    let count = 0;
    for (let y = 0; y < a.height; y++) {
      for (let x = 0; x < a.width; x++) {
        const i = (y * a.width + x) * 4;
        let found = false;
        for (let dy = -1; dy <= 1 && !found; dy++) {
          for (let dx = -1; dx <= 1 && !found; dx++) {
            const nx = x + dx, ny = y + dy;
            if (nx >= 0 && ny >= 0 && nx < b.width && ny < b.height) found = close(a, i, b, (ny * b.width + nx) * 4);
          }
        }
        if (!found) count++;
      }
    }
    return count;
  };
  for (const mode of modes.filter(mode => mode.label !== "cpu")) {
    const other = await readPngRgba(capturePath(mode.label));
    assert.equal(other.width, reference.width, `${mode.label} capture size`);
    assert.equal(other.height, reference.height, `${mode.label} capture size`);
    const different = Math.max(unmatched(reference, other), unmatched(other, reference));
    const percent = (100 * different) / (reference.width * reference.height);
    // Hinted GPU glyphs differ in shape (stem weights), never in place: a gross bound on the
    // pixels, and each field's ink must start and end where the CPU's does.
    assert.ok(percent < 2, `${mode.label} differs from cpu on ${percent.toFixed(2)}% of pixels`);
    for (const row of rows) {
      const ink = row.value ? black : blue;
      const [cpuMin, cpuMax] = inkSpan(reference, row.top, ink);
      const [min, max] = inkSpan(other, row.top, ink);
      assert.ok(Math.abs(min - cpuMin) <= 1.5 && Math.abs(max - cpuMax) <= 1.5,
        `${mode.label}: ${row.id} ink spans ${min}..${max}, cpu ${cpuMin}..${cpuMax}`);
    }
    console.log(`[smoke-input-align] ${mode.label} matches cpu (${percent.toFixed(3)}% differ)`);
  }
  console.log(`[smoke-input-align] PASS on ${modes.map(mode => mode.label).join(", ")}`);
} else {
  const errors: string[] = [];
  const app = createApp(() => (
    <Window title="Input textAlign smoke" width={WIDTH} height={266} resizable={false} style={{ background: "#d4d4d8" }}>
      <View style={{ position: "relative", flex: 1 }}>
        {rows.map(row => (
          <Input id={row.id} value={row.value} placeholder={"placeholder" in row ? row.placeholder : undefined}
            style={{ position: "absolute", left: 20, top: row.top, width: 240, height: 36, padding: { left: 8, right: 8 },
              borderWidth: 0, radius: 0, background: "#ffffff", foreground: "#000000", placeholderColor: "#0000ff",
              // The caret blinks: white keeps it out of the captures the renderers are compared on.
              caretColor: "#ffffff", outlineWidth: 0, fontSize: 18, textAlign: row.textAlign }} />
        ))}
      </View>
    </Window>
  ), { debug: true, onError: event => errors.push(event.error.message) });
  try {
    await app.ready;
    await sleep(300);
    // Focus the overflowing field and put the caret at its end: the line scrolls left.
    const overflow = rows.find(row => row.id === "overflow")!;
    app.debug({ type: "input", action: "move", x: 140, y: overflow.top + 18 });
    app.debug({ type: "input", action: "down" });
    app.debug({ type: "input", action: "up" });
    app.debug({ type: "input", action: "key", text: "End" });
    await sleep(400);
    mkdirSync(resolve("work"), { recursive: true });
    const path = capturePath(label);
    await app.capture(path);
    const png = await readPngRgba(path);
    const span = (id: string, ink = black) => inkSpan(png, rows.find(row => row.id === id)!.top, ink);
    const checks: [string, boolean, string][] = [];
    const check = (what: string, ok: boolean, detail: string) => checks.push([what, ok, detail]);
    const [leftMin] = span("left");
    check("left ink starts at the content box's left edge", Math.abs(leftMin - LEFT) <= 3, `${leftMin}`);
    const [centreMin, centreMax] = span("center");
    check("center ink is centred", Math.abs((centreMin + centreMax) / 2 - CENTRE) <= 2, `${centreMin}..${centreMax}`);
    const [, rightMax] = span("right");
    check("right ink ends at the content box's right edge", Math.abs(rightMax - RIGHT) <= 3, `${rightMax}`);
    const [rtlMin, rtlMax] = span("rtl");
    check("right-to-left start ink ends at the right edge", Math.abs(rtlMax - RIGHT) <= 3 && rtlMin > CENTRE, `${rtlMin}..${rtlMax}`);
    const [placeholderMin, placeholderMax] = span("placeholder", blue);
    check("placeholder is centred", Math.abs((placeholderMin + placeholderMax) / 2 - CENTRE) <= 2, `${placeholderMin}..${placeholderMax}`);
    const [overflowMin, overflowMax] = span("overflow");
    check("overflowing line fills the content box from its left edge", overflowMin >= LEFT - 1 && overflowMin <= LEFT + 4, `${overflowMin}`);
    check("overflowing line is scrolled to its end, clipped at the right edge", overflowMax <= RIGHT + 1 && overflowMax >= RIGHT - 16, `${overflowMax}`);
    const failed = checks.filter(([, ok]) => !ok);
    assert.deepEqual(failed.map(([what, , detail]) => `${label}: ${what} (${detail})`), []);
    assert.deepEqual(errors, []);
    console.log(`[smoke-input-align] ${label}: ${checks.length} pixel checks pass`);
  } finally {
    app.close();
    await app.closed;
  }
}
