import { strict as assert } from "node:assert";
import { resolve } from "node:path";
import { Button, Column, Row, Scroll, Text, Window, createApp } from "@tarve/core-internal";
import { smokeRendererModes } from "./smoke-renderer-modes";

/**
 * Steady redraws of text that is already on screen must not rasterize glyphs
 * again. A regression here (e.g. blank glyphs skipping the D3D11 glyph cache)
 * turned scrolling a long list from ~1 ms into ~14 ms of CPU per frame.
 */
const requestedRenderer = process.env.TARVE_SMOKE_RENDERER;

if (!requestedRenderer) {
  const script = resolve(import.meta.dir, "smoke-steady-frames.tsx");
  for (const mode of smokeRendererModes()) {
    const env: NodeJS.ProcessEnv = { ...process.env, TARVE_SMOKE_RENDERER: mode.renderer, TARVE_SMOKE_LABEL: mode.label };
    if (mode.wgpuBackend) env.WGPU_BACKEND = mode.wgpuBackend;
    else delete env.WGPU_BACKEND;
    const child = Bun.spawn([process.execPath, script], { cwd: resolve(import.meta.dir, ".."), env, stdout: "inherit", stderr: "inherit" });
    assert.equal(await child.exited, 0, `Steady-frame ${mode.label} smoke failed.`);
  }
} else {
  const renderer = requestedRenderer === "gpu" ? "gpu" : "cpu";
  const label = process.env.TARVE_SMOKE_LABEL ?? renderer;
  const rows = 400;
  const app = createApp(() => (
    <Window title="Tarve steady-frame smoke" width={640} height={480} style={{ background: "#ffffff" }}>
      <Column style={{ padding: 16, flex: 1 }}>
        <Scroll id="list" style={{ flex: 1 }}>
          <Column>
            {Array.from({ length: rows }, (_, index) => (
              <Row key={index} style={{ height: 32, shrink: 0, gap: 12 }}>
                <Text style={{ flex: 1 }}>{`Record ${index % 20}: the same words with spaces`}</Text>
                <Button size="sm">Open</Button>
              </Row>
            ))}
          </Column>
        </Scroll>
      </Column>
    </Window>
  ), { debug: true, renderer } as never) as any;
  try {
    await app.ready;
    let snapshot = await app.inspect();
    for (let wait = 0; snapshot.frames === 0 && wait < 500; wait++) {
      await Bun.sleep(10);
      snapshot = await app.inspect();
    }
    assert.ok(snapshot.frames > 0, `${label}: no frame was presented`);
    const x = snapshot.width / 2, y = snapshot.height / 2;
    app.debug({ type: "input", action: "move", x, y });
    await Bun.sleep(50);
    const scroll = async (steps: number) => {
      for (let step = 0; step < steps; step++) {
        app.debug({ type: "input", action: "wheel", delta: 60 });
        await Bun.sleep(16);
      }
      await Bun.sleep(150);
      return app.inspect();
    };
    const warm = await scroll(40);
    const steady = await scroll(80);
    const offset = (s: any) => s.nodes.find((node: any) => node.id === "list")?.scrollY ?? 0;
    assert.ok(offset(steady) > offset(warm) && offset(warm) > 0, `${label}: the list did not scroll (${offset(warm)} → ${offset(steady)})`);
    assert.ok(steady.frames - warm.frames >= 10, `${label}: scrolling presented only ${steady.frames - warm.frames} frames`);
    if (typeof warm.glyphRasterizations === "number") {
      assert.ok(warm.glyphRasterizations > 0, `${label}: the glyph counter never moved`);
      assert.equal(
        steady.glyphRasterizations,
        warm.glyphRasterizations,
        `${label}: redrawing already-seen text rasterized ${steady.glyphRasterizations - warm.glyphRasterizations} glyphs over ${steady.frames - warm.frames} frames`,
      );
    }
    console.log(`steady-frame ${label}: ${steady.frames - warm.frames} frames, glyph rasterizations ${warm.glyphRasterizations ?? "n/a"} → ${steady.glyphRasterizations ?? "n/a"}`);
    // Dragging the scrollbar lands on fractional offsets: text already seen must not be
    // rasterized again at each quarter-pixel baseline (that cost ~35 ms frames while dragging).
    const list = steady.nodes.find((node: any) => node.id === "list");
    assert.ok(list, `${label}: the list node is missing from the snapshot`);
    app.debug({ type: "input", action: "move", x: list.x + list.width - 5, y: list.y + 12 });
    await Bun.sleep(30);
    app.debug({ type: "input", action: "down" });
    await Bun.sleep(30);
    for (let step = 1; step <= 40; step++) {
      app.debug({ type: "input", action: "move", x: list.x + list.width - 5, y: list.y + 12 + step * 1.5 });
      await Bun.sleep(8);
    }
    app.debug({ type: "input", action: "up" });
    await Bun.sleep(150);
    const dragged = await app.inspect();
    const draggedOffset = offset(dragged);
    assert.ok(draggedOffset > 0 && draggedOffset < offset(steady), `${label}: the scrollbar drag did not move the list (${offset(steady)} → ${draggedOffset})`);
    assert.ok(dragged.frames - steady.frames >= 10, `${label}: the scrollbar drag presented only ${dragged.frames - steady.frames} frames`);
    if (typeof steady.glyphRasterizations === "number") {
      assert.equal(
        dragged.glyphRasterizations,
        steady.glyphRasterizations,
        `${label}: dragging the scrollbar over seen text rasterized ${dragged.glyphRasterizations - steady.glyphRasterizations} glyphs over ${dragged.frames - steady.frames} frames`,
      );
    }
    console.log(`steady-frame ${label}: scrollbar drag ${dragged.frames - steady.frames} frames, offset ${offset(steady)} → ${draggedOffset}, glyph rasterizations ${steady.glyphRasterizations ?? "n/a"} → ${dragged.glyphRasterizations ?? "n/a"}`);
  } finally {
    app.close();
  }
  process.exit(0);
}
