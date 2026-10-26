import { strict as assert } from "node:assert";
import { resolve } from "node:path";
import { Button, Column, Row, Scroll, Text, Window, createApp } from "@tarve/core-internal";
import { smokeRendererModes } from "./smoke-renderer-modes";

/**
 * An idle window must not draw or keep the event loop spinning: no frames and
 * near-zero process CPU once input, hover and memory trims settle. A regression
 * (a redraw per vsync, a `WaitUntil` deadline that never clears) shows up as
 * frames or as CPU time here even when nothing visibly changes.
 * TARVE_IDLE_SECONDS sets the measured window; TARVE_IDLE_CPU_MAX the allowed
 * share of one core (default 0.02 = 2%).
 */
const requestedRenderer = process.env.TARVE_SMOKE_RENDERER;

if (!requestedRenderer) {
  const script = resolve(import.meta.dir, "smoke-idle.tsx");
  for (const mode of smokeRendererModes()) {
    const env: NodeJS.ProcessEnv = { ...process.env, TARVE_SMOKE_RENDERER: mode.renderer, TARVE_SMOKE_LABEL: mode.label };
    if (mode.wgpuBackend) env.WGPU_BACKEND = mode.wgpuBackend;
    else delete env.WGPU_BACKEND;
    const child = Bun.spawn([process.execPath, script], { cwd: resolve(import.meta.dir, ".."), env, stdout: "inherit", stderr: "inherit" });
    assert.equal(await child.exited, 0, `Idle ${mode.label} smoke failed.`);
  }
} else {
  const renderer = requestedRenderer === "gpu" ? "gpu" : "cpu";
  const label = process.env.TARVE_SMOKE_LABEL ?? renderer;
  const idleMs = Number(process.env.TARVE_IDLE_SECONDS ?? 10) * 1000;
  const cpuMax = Number(process.env.TARVE_IDLE_CPU_MAX ?? 0.02);
  const errors: string[] = [];
  const app = createApp(() => (
    <Window title="Tarve idle smoke" width={640} height={480} style={{ background: "#ffffff" }}>
      <Column style={{ padding: 16, flex: 1, gap: 8 }}>
        <Row style={{ gap: 8 }}>
          <Button>Primary</Button>
          <Button variant="outline">Secondary</Button>
        </Row>
        <Scroll id="list" style={{ flex: 1 }}>
          <Column>
            {Array.from({ length: 200 }, (_, index) => (
              <Row key={index} style={{ height: 32, shrink: 0, gap: 12 }}>
                <Text style={{ flex: 1 }}>{`Record ${index}: idle content`}</Text>
                <Button size="sm">Open</Button>
              </Row>
            ))}
          </Column>
        </Scroll>
      </Column>
    </Window>
  ), { debug: true, renderer, onError: (event: { error: Error }) => errors.push(event.error.message) } as never) as any;

  /** Process CPU (all threads) and presented frames over `ms` of doing nothing. */
  const measure = async (ms: number) => {
    const frames0 = (await app.inspect()).frames;
    const cpu0 = process.cpuUsage();
    const t0 = performance.now();
    await Bun.sleep(ms);
    const cpu = process.cpuUsage(cpu0);
    const wallMs = performance.now() - t0;
    const frames = (await app.inspect()).frames - frames0;
    const cpuMs = (cpu.user + cpu.system) / 1000;
    return { frames, cpuMs: Math.round(cpuMs * 10) / 10, cpuShare: cpuMs / wallMs };
  };

  const check = (phase: string, result: Awaited<ReturnType<typeof measure>>) => {
    assert.equal(result.frames, 0, `${label} ${phase}: an idle window presented ${result.frames} frames`);
    assert.ok(
      result.cpuShare <= cpuMax,
      `${label} ${phase}: idle CPU ${(result.cpuShare * 100).toFixed(2)}% of a core (${result.cpuMs} ms) exceeds ${(cpuMax * 100).toFixed(2)}%`,
    );
  };

  try {
    await app.ready;
    let snapshot = await app.inspect();
    for (let wait = 0; snapshot.frames === 0 && wait < 500; wait++) {
      await Bun.sleep(10);
      snapshot = await app.inspect();
    }
    assert.ok(snapshot.frames > 0, `${label}: no frame was presented`);
    // Startup work (shader warmup, the startup working-set trim) settles first.
    await Bun.sleep(3000);
    const startup = await measure(idleMs);
    check("after startup", startup);

    // Hover, scroll and click, then let hover fades, input holds and trims expire.
    const cx = snapshot.width / 2, cy = snapshot.height / 2;
    for (let step = 0; step < 60; step++) {
      app.debug({ type: "input", action: "move", x: cx + Math.sin(step / 5) * cx * 0.6, y: cy + Math.cos(step / 7) * cy * 0.5 });
      app.debug({ type: "input", action: "wheel", delta: step < 30 ? 60 : -60 });
      await Bun.sleep(16);
    }
    const busy = (await app.inspect()).frames;
    assert.ok(busy > snapshot.frames, `${label}: input presented no frames, so the idle check proves nothing`);
    await Bun.sleep(3000);
    const afterInput = await measure(idleMs);
    check("after input", afterInput);

    assert.deepEqual(errors, []);
    console.log(`[tarve smoke:idle] PASS ${label} ${JSON.stringify({ idleMs, startup, afterInput })}`);
  } finally {
    app.close();
  }
  process.exit(0);
}
