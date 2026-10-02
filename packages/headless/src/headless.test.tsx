import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { Button, Card, Column, Input, Row, Spinner, Text, View, Window, darkTheme, readPngRgba, type RgbaImage } from "@tarve/core";
import { createHeadlessApp, createHeadlessTestRenderer, matchImageSnapshot, renderToPng, renderToRgba } from "./index";

const snapshots = resolve(import.meta.dir, "../__snapshots__");

function pixel(image: RgbaImage, x: number, y: number): [number, number, number] {
  const i = (Math.round(y) * image.width + Math.round(x)) * 4;
  return [image.rgba[i]!, image.rgba[i + 1]!, image.rgba[i + 2]!];
}

function inkWithin(image: RgbaImage, x0: number, y0: number, x1: number, y1: number): number {
  const background = pixel(image, 0, 0);
  let ink = 0;
  for (let y = Math.max(0, y0); y < Math.min(image.height, y1); y++) {
    for (let x = Math.max(0, x0); x < Math.min(image.width, x1); x++) {
      const [r, g, b] = pixel(image, x, y);
      if (Math.abs(r - background[0]) + Math.abs(g - background[1]) + Math.abs(b - background[2]) > 48) ink++;
    }
  }
  return ink;
}

function settingsCard() {
  return (
    <Window title="Settings" width={360} height={220} theme={darkTheme}>
      <Column flex={1} align="center" justify="center" padding={24}>
        <Card style={{ width: 300 }}>
          <Column gap={12} padding={16}>
            <Text size={16} weight={600}>Workspace</Text>
            <Text size={13}>Rendered by Tarve without a window.</Text>
            <Row gap={8} justify="end">
              <Button variant="outline">Cancel</Button>
              <Button>Save</Button>
            </Row>
          </Column>
        </Card>
      </Column>
    </Window>
  );
}

describe("@tarve/headless", () => {
  test("renders a component tree to pixels at the requested size and scale", async () => {
    const image = await renderToRgba(<Button>Save</Button>, { width: 200, height: 100, scale: 2 });
    expect(image.width).toBe(400);
    expect(image.height).toBe(200);
    expect(inkWithin(image, 0, 0, 400, 200)).toBeGreaterThan(200);
  });

  test("the same view renders to the same bytes every time", async () => {
    const first = await renderToPng(settingsCard);
    const second = await renderToPng(settingsCard);
    expect(Buffer.from(first).equals(Buffer.from(second))).toBe(true);
  });

  test("matches its stored image snapshot", async () => {
    await matchImageSnapshot(await renderToRgba(settingsCard, { scale: 2 }), join(snapshots, "settings-card.png"));
  });

  test("clicks, typing and inspect drive the real native tree", async () => {
    let clicks = 0;
    let value = "";
    const renderer = await createHeadlessTestRenderer(() => (
      <Window width={320} height={200}>
        <Column gap={8} padding={16}>
          <Button id="add" onClick={() => clicks++}>Clicked {String(clicks)}</Button>
          <Input id="name" value={value} placeholder="Name" onChange={(next) => (value = next)} />
        </Column>
      </Window>
    ));
    try {
      await renderer.getById("add").click();
      await renderer.getById("add").click();
      await renderer.getByRole("button", { name: "Clicked 2" }).waitFor();
      await renderer.getById("name").click();
      renderer.app.debug({ type: "input", action: "text", text: "Ada" });
      await renderer.getByText("Ada").waitFor();
      expect(clicks).toBe(2);
      expect(value).toBe("Ada");
      const snapshot = await renderer.inspect();
      expect(snapshot.focused).toBe("name");
      expect(snapshot.width).toBe(320);
    } finally {
      renderer.close();
    }
  });

  test("time only moves with advanceMotion: transitions are reproducible", async () => {
    let wide = false;
    const app = await createHeadlessApp(() => (
      <Window width={400} height={100}>
        <View
          id="bar"
          style={{ width: wide ? 300 : 100, height: 20, background: "#7c5cff", transition: { width: { duration: 200, easing: "linear" } } }}
        />
      </Window>
    ));
    try {
      wide = true;
      app.update();
      await app.settle();
      const width = async () => (await app.inspect()).nodes.find((node) => node.id === "bar")!.width;
      expect(await width()).toBe(100);
      await app.advanceMotion(100);
      expect(await width()).toBeCloseTo(200, 0);
      await app.advanceMotion(100);
      expect(await width()).toBe(300);
    } finally {
      app.close();
    }
  });

  test("spin rotates on the motion clock", async () => {
    const app = await createHeadlessApp(() => (
      <Window width={80} height={80}>
        <Column flex={1} align="center" justify="center">
          <Spinner size={48} />
        </Column>
      </Window>
    ));
    try {
      const before = app.png();
      expect(Buffer.from(app.png()).equals(Buffer.from(before))).toBe(true);
      await app.advanceMotion(200);
      expect(Buffer.from(app.png()).equals(Buffer.from(before))).toBe(false);
    } finally {
      app.close();
    }
  });

  test("capture writes a PNG through the AppHandle API", async () => {
    const dir = mkdtempSync(join(tmpdir(), "tarve-headless-"));
    const app = await createHeadlessApp(settingsCard);
    try {
      const path = join(dir, "nested", "capture.png");
      await app.capture(path);
      expect(existsSync(path)).toBe(true);
      const image = await readPngRgba(path);
      expect([image.width, image.height]).toEqual([360, 220]);
    } finally {
      app.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
