import { strict as assert } from "node:assert";
import { mkdir, readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { Column, Window, createTestRenderer, readPngRgba } from "@tarve/core-internal";
import { smokeRendererModes } from "./smoke-renderer-modes";

const requestedRenderer = process.env.TARVE_SMOKE_RENDERER;

if (!requestedRenderer) {
  const script = resolve(import.meta.dir, "smoke-motion.tsx");
  const modes = smokeRendererModes();

  for (const mode of modes) {
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      TARVE_SMOKE_RENDERER: mode.renderer,
      TARVE_SMOKE_LABEL: mode.label,
    };
    if (mode.wgpuBackend) env.WGPU_BACKEND = mode.wgpuBackend;
    else delete env.WGPU_BACKEND;
    const child = Bun.spawn([process.execPath, script], {
      cwd: resolve(import.meta.dir, ".."),
      env,
      stdout: "inherit",
      stderr: "inherit",
    });
    assert.equal(await child.exited, 0, `Native motion ${mode.label} smoke failed.`);
  }
} else {
  const renderer = requestedRenderer === "gpu" ? "gpu" : "cpu";
  const label = process.env.TARVE_SMOKE_LABEL ?? renderer;
  let width = 100;
  let opacity = 1;
  let duration = 400;
  const completed: string[] = [];

  const test = await createTestRenderer(() => (
    <Window title="Tarve native motion smoke" width={420} height={180} style={{ background: "#ffffff" }}>
      <Column style={{ padding: 24 }}>
        <Column
          id="motion-panel"
          onTransitionEnd={({ property }) => completed.push(property)}
          style={{
            width,
            height: 56,
            opacity,
            radius: 12,
            background: "#2563eb",
            transition: {
              width: { duration, easing: "linear" },
              opacity: { duration, easing: "linear" },
            },
          }}
        />
      </Column>
    </Window>
  ), { renderer });

  try {
    const initial = await test.inspect();
    const initialPanel = initial.nodes.find(node => node.id === "motion-panel")!;
    assert(Math.abs(initialPanel.width - 100) < 0.5);
    assert.equal(initial.activeMotions, 0);

    width = 200;
    test.app.update();
    await Bun.sleep(90);
    const live = await test.inspect();
    const livePanel = live.nodes.find(node => node.id === "motion-panel")!;
    assert(livePanel.width > 105 && livePanel.width < 195,
      `live scheduler did not produce an intermediate width: ${livePanel.width}`);
    assert(live.frames > initial.frames,
      `live scheduler did not present frames while motion was active: ${initial.frames} -> ${live.frames}`);
    assert.equal(live.activeMotions, 1);

    const settled = await test.waitFor(
      snapshot => snapshot.activeMotions === 0 ? snapshot : false,
      { timeout: 1_500, interval: 20 },
    );
    const settledPanel = settled.nodes.find(node => node.id === "motion-panel")!;
    assert(Math.abs(settledPanel.width - 200) < 0.5);
    await test.waitForIdle({ timeout: 1_000, interval: 20, stableSamples: 2 });
    const idle = await test.inspect();
    await Bun.sleep(80);
    const stillIdle = await test.inspect();
    assert.equal(stillIdle.frames, idle.frames, "renderer kept presenting frames after native motion completed");

    duration = 100;
    width = 300;
    opacity = 0.5;
    completed.length = 0;
    test.app.update();
    await test.advanceMotion(50);
    const midpoint = await test.inspect();
    const midpointPanel = midpoint.nodes.find(node => node.id === "motion-panel")!;
    assert(Math.abs(midpointPanel.width - 250) < 0.75,
      `deterministic 50ms step leaked wall-clock time: ${midpointPanel.width}`);
    assert.equal(midpoint.activeMotions, 2);
    assert.deepEqual(completed, []);

    await mkdir(resolve("work"), { recursive: true });
    const midpointPath = resolve(`work/motion-${label}-50ms.png`);
    const completePath = resolve(`work/motion-${label}-100ms.png`);
    await test.capture(midpointPath);
    const midpointPng = await readPngRgba(midpointPath);

    await test.advanceMotion(50);
    const finished = await test.inspect();
    const finishedPanel = finished.nodes.find(node => node.id === "motion-panel")!;
    assert(Math.abs(finishedPanel.width - 300) < 0.5);
    assert.equal(finished.activeMotions, 0);
    assert.deepEqual([...completed].sort(), ["opacity", "width"]);
    await test.capture(completePath);
    const completePng = await readPngRgba(completePath);
    assert.notDeepEqual(await readFile(midpointPath), await readFile(completePath),
      "deterministic motion captures should differ between midpoint and completion");

    const samplePixel = (png: Awaited<ReturnType<typeof readPngRgba>>, x: number, y: number) => {
      const px = Math.min(png.width - 1, Math.max(0, Math.round(x * midpoint.scale)));
      const py = Math.min(png.height - 1, Math.max(0, Math.round(y * midpoint.scale)));
      const offset = (py * png.width + px) * 4;
      return [png.rgba[offset]!, png.rgba[offset + 1]!, png.rgba[offset + 2]!, png.rgba[offset + 3]!] as const;
    };
    const sampleX = midpointPanel.x + 20;
    const sampleY = midpointPanel.y + midpointPanel.height / 2;
    const midPixel = samplePixel(midpointPng, sampleX, sampleY);
    const endPixel = samplePixel(completePng, sampleX, sampleY);
    assert(endPixel[0] > midPixel[0] + 20 && endPixel[1] > midPixel[1] + 15,
      `opacity did not visibly interpolate over the window background: ${midPixel.join(",")} -> ${endPixel.join(",")}`);

    console.log(`Native motion ${label} smoke passed: live frames ${initial.frames}->${live.frames}, deterministic width ${midpointPanel.width}->${finishedPanel.width}.`);
  } finally {
    test.close();
    await test.app.closed;
  }
}
