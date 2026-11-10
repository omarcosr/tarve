// Retained painting under a clipped Glass (D3D11): a rounded child clip that cannot join the
// card's rounded clip moves the card's clip to the stencil, from inside the child's recorded
// span. A later frame that reused that span pushed a stencil clip nothing popped, and every
// box painted after the card vanished (a Slider dragged next to a Text changing width blanked
// the glass-widgets demo). Every renderer must keep the box after the card.
import { createApp, Glass, readPngRgba, Text, View, Window } from "@tarve/core";
import { strict as assert } from "node:assert";
import { mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";

const errors: string[] = [];
let value = 9;
const app = createApp(() => (
  <Window title="Glass reuse smoke" width={400} height={300} style={{ background: "#ffffff", radius: 0, borderWidth: 0 }}>
    <View id="stage" style={{ position: "relative", flex: 1 }}>
      <Glass id="card" tint="#ffffff40" radius={24} shadow={false} material={{ blur: 12 }}
        style={{ position: "absolute", left: 20, top: 20, width: 160, height: 120, overflow: "hidden" }}>
        <View id="corner" style={{ position: "absolute", left: 0, top: 0, width: 70, height: 50, radius: 12, overflow: "hidden" }}>
          <View style={{ width: 70, height: 50, background: "#2050ff" }} />
        </View>
        <View style={{ position: "absolute", top: 0, left: 0, right: 0, height: 60, background: "linear-gradient(180deg, #ffffff66, #ffffff00)" }} />
        <Text size={15} weight={700} color="#000000" style={{ margin: { top: 60, left: 20 } }}>Lisbon</Text>
      </Glass>
      {/* Enough unchanged nodes that a frame changing a few reuses the rest. */}
      {Array.from({ length: 60 }, (_, i) => (
        <View key={`dot${i}`} style={{ position: "absolute", left: 4 + (i % 30) * 13, top: 260 + Math.floor(i / 30) * 13, width: 8, height: 8, background: "#c0c0c0" }} />
      ))}
      <View id="after" style={{ position: "absolute", left: 220, top: 20, width: 160, height: 120, background: "#00c000" }} />
      <View style={{ position: "absolute", left: 20, top: 200, direction: "row", gap: 8 }}>
        <Text id="label" size={16} color="#000000">{`${value}%`}</Text>
        <View style={{ width: 40, height: 20, background: "#ff8000" }} />
      </View>
    </View>
  </Window>
), { debug: true, onError: event => errors.push(event.error.message) });

try {
  await app.ready;
  await sleep(300);
  // Frames that relayout one small row reuse the rest of the tree, the card's child included.
  for (value = 10; value <= 85; value += 15) {
    app.update();
    await sleep(40);
  }
  mkdirSync(resolve("work"), { recursive: true });
  const path = resolve("work/smoke-glass-reuse.png");
  await app.capture(path);
  const image = await readPngRgba(path);
  const scale = image.width / 400;
  const pixel = (x: number, y: number) => {
    const i = (Math.round(y * scale) * image.width + Math.round(x * scale)) * 4;
    return [image.rgba[i]!, image.rgba[i + 1]!, image.rgba[i + 2]!];
  };
  const [r, g, b] = pixel(300, 80);
  assert.ok(g > 150 && r < 80 && b < 80, `the box painted after the clipped glass shows (${r},${g},${b})`);
  const [cr, , cb] = pixel(40, 40);
  assert.ok(cb > 150 && cr < 120, `the card's clipped child shows (${cr},${cb})`);
  assert.deepEqual(errors, []);
  console.log("[smoke-glass-reuse] PASS");
} finally {
  app.close();
  await app.closed;
}
