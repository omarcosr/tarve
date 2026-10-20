// The CPU renderer and the GPU one (D3D11, or wgpu) must draw the same scene alike: one
// window per renderer captures it and the frames are compared pixel by pixel. Edges and
// glyph anti-aliasing may differ a little; shapes, colors, shadows and text placement may not.
//   bun run test:renderer-parity          # KEEP=1 keeps work/renderer-parity-*.png
import { Column, Row, Text, View, Window, compareRgbaImages, createApp, readPngRgba, type Renderer } from "@tarve/core";
import { mkdirSync, rmSync } from "node:fs";
import { resolve } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";

/** A channel may differ by this much before the pixel counts as different. */
const THRESHOLD = Number(process.env.THRESHOLD ?? 40);
/** Share of pixels allowed to differ beyond THRESHOLD (anti-aliased edges). */
const MAX_RATIO = Number(process.env.MAX_RATIO ?? 0.01);

function Scene() {
  return (
    <Window title="Renderer parity" width={480} height={320} resizable={false} style={{ background: "#f4f4f5" }}>
      <Column padding={16} gap={12}>
        <Row gap={12}>
          <View style={{ width: 80, height: 56, background: "#2563eb" }} />
          <View style={{ width: 80, height: 56, radius: 14, background: "#16a34a" }} />
          <View style={{ width: 80, height: 56, radius: 28, borderWidth: 4, borderColor: "#dc2626", background: "#ffffff" }} />
          <View style={{ width: 80, height: 56, radius: 10, background: "#f59e0b", boxShadow: { y: 6, blur: 14, color: "#00000059" } }} />
        </Row>
        <Row gap={12}>
          <View style={{ width: 172, height: 56, radius: 8, background: "linear-gradient(90deg, #7c3aed, #06b6d4)" }} />
          <View style={{ width: 172, height: 56, radius: 8, background: "#0f172a80", borderWidth: 1, borderColor: "#0f172a" }} />
        </Row>
        <Text style={{ fontSize: 22, fontWeight: 700, foreground: "#111827" }}>Tarve renders this twice</Text>
        <Text style={{ fontSize: 14, foreground: "#374151" }}>Regular text, numbers 0123456789 and punctuation: ,.;!?</Text>
      </Column>
    </Window>
  );
}

async function capture(renderer: Renderer, path: string): Promise<void> {
  const app = createApp(Scene, { debug: true, renderer });
  try {
    await app.ready;
    let previous = await app.inspect();
    for (let stable = 0; stable < 3;) {
      await sleep(50);
      const current = await app.inspect();
      stable = current.frames > 0 && current.frames === previous.frames ? stable + 1 : 0;
      previous = current;
    }
    await app.capture(path);
  } finally {
    app.close();
  }
}

// One native app per process: each renderer captures in a child of this script.
if (process.env.PARITY_RENDERER) {
  await capture(process.env.PARITY_RENDERER as Renderer, process.env.PARITY_OUT!);
  process.exit(0);
}
function captureIn(renderer: Renderer, path: string): void {
  const child = Bun.spawnSync([process.execPath, import.meta.path], { env: { ...process.env, PARITY_RENDERER: renderer, PARITY_OUT: path }, stdout: "inherit", stderr: "inherit" });
  if (child.exitCode !== 0) throw new Error(`${renderer} capture failed (exit ${child.exitCode})`);
}

const out = resolve("work");
mkdirSync(out, { recursive: true });
const cpuPath = resolve(out, "renderer-parity-cpu.png");
const gpuPath = resolve(out, "renderer-parity-gpu.png");
captureIn("cpu", cpuPath);
captureIn("gpu", gpuPath);
const [cpu, gpu] = await Promise.all([readPngRgba(cpuPath), readPngRgba(gpuPath)]);
const result = compareRgbaImages(gpu, cpu, { threshold: THRESHOLD });
console.log(JSON.stringify({ ...result, threshold: THRESHOLD, maxRatio: MAX_RATIO }));
if (result.differenceRatio > MAX_RATIO) {
  console.error(`renderer parity: ${(result.differenceRatio * 100).toFixed(2)}% of pixels differ beyond ${THRESHOLD} (allowed ${(MAX_RATIO * 100).toFixed(2)}%); see ${cpuPath} and ${gpuPath}`);
  process.exit(1);
}
if (process.env.KEEP !== "1") for (const path of [cpuPath, gpuPath]) rmSync(path, { force: true });
console.log("renderer parity ok");
process.exit(0);
