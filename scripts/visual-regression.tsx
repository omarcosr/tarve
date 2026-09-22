import { mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { strict as assert } from "node:assert";
import { createApp } from "tarve";
import { App as ShowcaseApp } from "../examples/components-view";

const app = createApp(ShowcaseApp, { debug: true });
const out = resolve("dist");
mkdirSync(out, { recursive: true });

function map(snapshot: Awaited<ReturnType<typeof app.inspect>>) {
  return new Map(snapshot.nodes.map(node => [node.id, node]));
}

try {
  await app.ready;
  await Bun.sleep(100);

  const initial = await app.inspect();
  let byId = map(initial);

  const chart = byId.get("demo-chart");
  const empty = byId.get("demo-empty");
  assert(chart && empty, "Showcase chart/next-section nodes are missing");
  assert(chart.height === 180, "Chart height changed unexpectedly: " + chart.height);
  assert(chart.y + chart.height <= empty.y + 0.5,
    "Chart overlaps the following section: chartBottom=" + (chart.y + chart.height) + ", emptyTop=" + empty.y);
  for (let index = 0; index < 5; index++) {
    const plot = byId.get("demo-chart-plot-" + index);
    const bar = byId.get("demo-chart-bar-" + index);
    assert(plot && bar, "Missing chart plot/bar " + index);
    assert(bar.y >= plot.y - 0.5, "Chart bar " + index + " starts above its plot");
    assert(bar.y + bar.height <= plot.y + plot.height + 0.5,
      "Chart bar " + index + " escapes plot: barBottom=" + (bar.y + bar.height) + ", plotBottom=" + (plot.y + plot.height));
  }
  await app.capture(resolve(out, "components-chart-real.png"));

  const otp = byId.get("demo-otp");
  const otpInput = byId.get("demo-otp-input");
  const slots = Array.from({ length: 6 }, (_, index) => byId.get("demo-otp-slot-" + index));
  assert(otp && otpInput && slots.every(Boolean), "Showcase OTP nodes are missing");
  const realSlots = slots as NonNullable<(typeof slots)[number]>[];
  assert(realSlots.length === 6);
  assert(realSlots.every(slot => Math.abs(slot.width - 36) < 0.5),
    "OTP slot widths are not independent 36px cells: " + realSlots.map(slot => slot.width).join(","));
  const gaps = realSlots.slice(1).map((slot, index) =>
    slot.x - (realSlots[index].x + realSlots[index].width));
  assert(gaps.every(gap => gap >= 7.5),
    "OTP slots are visually merged: gaps=" + gaps.join(","));
  assert(Math.abs(otp.width - 256) < 0.5,
    "OTP total width does not match six cells + five gaps: " + otp.width);

  const scroller = byId.get("components-scroll");
  assert(scroller, "Showcase root Scroll is missing");
  app.debug({ type: "input", action: "move", x: scroller.x + scroller.width / 2, y: scroller.y + scroller.height / 2 });
  app.debug({ type: "input", action: "wheel", delta: Math.max(0, otp.y - 260) });
  await Bun.sleep(50);
  app.focus("demo-otp-input");
  await Bun.sleep(50);
  byId = map(await app.inspect());
  const visibleOtp = byId.get("demo-otp");
  assert(visibleOtp && visibleOtp.y >= 0 && visibleOtp.y < initial.height,
    "OTP did not become visible after scroll: y=" + visibleOtp?.y);
  assert.equal((await app.inspect()).focused, "demo-otp-input");
  await app.capture(resolve(out, "components-otp-real.png"));

  byId = map(await app.inspect());
  const splitterBefore = byId.get("demo-resizable-handle");
  assert(splitterBefore, "Showcase Resizable splitter is missing");
  const scrollAgain = Math.max(0, splitterBefore.y - 340);
  app.debug({ type: "input", action: "move", x: scroller.x + scroller.width / 2, y: scroller.y + scroller.height / 2 });
  app.debug({ type: "input", action: "wheel", delta: scrollAgain });
  await Bun.sleep(50);
  byId = map(await app.inspect());
  const splitter = byId.get("demo-resizable-handle");
  assert(splitter, "Showcase Resizable splitter disappeared after scroll");
  assert.equal(splitter.kind, "splitter");
  assert(splitter.width >= 9 && splitter.width <= 11,
    "Horizontal splitter must be about 10px wide, got " + splitter.width);
  app.debug({ type: "input", action: "move",
    x: splitter.x + splitter.width / 2, y: splitter.y + splitter.height / 2 });
  await Bun.sleep(30);
  const hovered = await app.inspect();
  assert.equal(hovered.hovered, "demo-resizable-handle");
  await app.capture(resolve(out, "components-resizable-real.png"));
  const finalScroll = map(hovered).get("components-scroll");
  assert(finalScroll);

  console.log(JSON.stringify({
    result: "PASS",
    showcase: "examples/components-view.tsx",
    chart: {
      height: chart.height,
      bottom: Number((chart.y + chart.height).toFixed(1)),
      nextSectionTop: Number(empty.y.toFixed(1)),
    },
    otp: {
      slots: realSlots.length,
      totalWidth: otp.width,
      gaps: gaps.map(value => Number(value.toFixed(1))),
      focused: "demo-otp-input",
    },
    resizable: {
      kind: splitter.kind,
      width: splitter.width,
      x: Number(splitter.x.toFixed(1)),
      y: Number(splitter.y.toFixed(1)),
      hovered: hovered.hovered,
    },
    scroll: Number(finalScroll.scroll.toFixed(1)),
    captures: [
      resolve(out, "components-chart-real.png"),
      resolve(out, "components-otp-real.png"),
      resolve(out, "components-resizable-real.png"),
    ],
  }, null, 2));
} finally {
  app.close();
  await app.closed;
}
