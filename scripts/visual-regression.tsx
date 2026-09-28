import { mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { strict as assert } from "node:assert";
import { lucideReactAdapter, phosphorReactAdapter, reactSvgAdapter } from "@tarve/react-icons";
import { App as ShowcaseApp } from "../examples/components-view";

// Runtime must use the freshly packed package installed into examples/node_modules.
// Resolve through Bun's package resolver from the consumer project instead of knowing
// Tarve's node_modules or dist layout.
const installedTarveModule = Bun.resolveSync("@tarve/core", resolve(import.meta.dir, "../examples"));
const { createApp, readPngRgba } = await import(installedTarveModule) as typeof import("../packages/core/src/index");

const app = createApp(ShowcaseApp, {
  debug: true,
  componentAdapters: [reactSvgAdapter, lucideReactAdapter, phosphorReactAdapter],
});
const out = resolve("dist");
mkdirSync(out, { recursive: true });

function map(snapshot: Awaited<ReturnType<typeof app.inspect>>) {
  return new Map(snapshot.nodes.map(node => [node.id, node]));
}

function assertVisibleInk(
  png: Awaited<ReturnType<typeof readPngRgba>>,
  snapshot: Awaited<ReturnType<typeof app.inspect>>,
  node: NonNullable<Awaited<ReturnType<typeof app.inspect>>["nodes"][number]>,
  label: string,
) {
  const sx = png.width / snapshot.width;
  const sy = png.height / snapshot.height;
  const x0 = Math.max(0, Math.floor(node.x * sx));
  const y0 = Math.max(0, Math.floor(node.y * sy));
  const x1 = Math.min(png.width, Math.ceil((node.x + node.width) * sx));
  const y1 = Math.min(png.height, Math.ceil((node.y + node.height) * sy));
  let ink = 0;
  for (let y = y0; y < y1; y++) {
    for (let x = x0; x < x1; x++) {
      const index = (y * png.width + x) * 4;
      const r = png.rgba[index];
      const g = png.rgba[index + 1];
      const b = png.rgba[index + 2];
      // External icon cards use the default light muted surface (#f4f4f5).
      if (Math.abs(r - 244) + Math.abs(g - 244) + Math.abs(b - 245) > 45) ink++;
    }
  }
  assert(ink >= 12, `${label} occupies a native SVG node but paints no visible icon pixels (ink=${ink})`);
}

try {
  await app.ready;
  await Bun.sleep(100);

  const initial = await app.inspect();
  let byId = map(initial);

  const chart = byId.get("demo-chart");
  const empty = byId.get("demo-empty");
  const svgImage = byId.get("demo-svg-image");
  const inlineSvg = byId.get("demo-inline-svg");
  const lucideReactCamera = byId.get("demo-lucide-react-camera");
  const heroiconsCamera = byId.get("demo-heroicons-camera");
  const phosphorCamera = byId.get("demo-phosphor-camera");
  const tablerCamera = byId.get("demo-tabler-camera");
  const lucideIcons = byId.get("demo-lucide-icons");
  const lucideIconNames = ["house", "user", "bell", "heart", "download", "mail"];
  assert(chart && empty, "Showcase chart/next-section nodes are missing");
  assert(svgImage && inlineSvg && lucideReactCamera && heroiconsCamera && phosphorCamera && tablerCamera && lucideIcons,
    "Showcase SVG/external icon library nodes are missing");
  assert.equal(svgImage.kind, "image");
  assert.equal(inlineSvg.kind, "svg");
  assert.equal(lucideReactCamera.kind, "svg", "Direct lucide-react component must compile to native SVG");
  assert.equal(heroiconsCamera.kind, "svg", "Direct Heroicons component must compile to native SVG");
  assert.equal(phosphorCamera.kind, "svg", "Direct Phosphor component must compile to native SVG");
  assert.equal(tablerCamera.kind, "svg", "Direct Tabler component must compile to native SVG");
  assert(Math.abs(svgImage.width - 220) < 0.5 && Math.abs(svgImage.height - 124) < 0.5,
    `SVG image has unexpected layout: ${svgImage.width}x${svgImage.height}`);
  for (const name of lucideIconNames) {
    const icon = byId.get(`demo-icon-${name}`);
    assert(icon && icon.kind === "svg", `Missing Lucide-style icon: ${name}`);
  }

  const rootScrollerForIcons = byId.get("components-scroll");
  assert(rootScrollerForIcons, "Showcase root Scroll is missing before icon paint check");
  app.debug({ type: "input", action: "move",
    x: rootScrollerForIcons.x + rootScrollerForIcons.width / 2,
    y: rootScrollerForIcons.y + rootScrollerForIcons.height / 2 });
  app.debug({ type: "input", action: "wheel", delta: Math.max(0, lucideReactCamera.y - 300) });
  await Bun.sleep(50);
  const iconsSnapshot = await app.inspect();
  const iconsById = map(iconsSnapshot);
  const visibleExternalIcons = [
    ["demo-lucide-react-camera", "Lucide"],
    ["demo-heroicons-camera", "Heroicons"],
    ["demo-phosphor-camera", "Phosphor"],
    ["demo-tabler-camera", "Tabler"],
  ] as const;
  const iconCapture = resolve(out, "components-external-icons-real.png");
  await app.capture(iconCapture);
  const png = await readPngRgba(iconCapture);
  for (const [id, label] of visibleExternalIcons) {
    const icon = iconsById.get(id);
    assert(icon && icon.y >= 0 && icon.y + icon.height <= iconsSnapshot.height,
      `${label} icon was not made visible for paint validation`);
    assertVisibleInk(png, iconsSnapshot, icon, label);
  }
  app.debug({ type: "input", action: "move",
    x: rootScrollerForIcons.x + rootScrollerForIcons.width / 2,
    y: rootScrollerForIcons.y + rootScrollerForIcons.height / 2 });
  app.debug({ type: "input", action: "wheel", delta: -1_000_000 });
  await Bun.sleep(50);
  byId = map(await app.inspect());

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

  const composedButton = byId.get("demo-composed-button");
  const horizontalBefore = byId.get("demo-horizontal-scroll");
  const horizontalTargetBefore = byId.get("demo-horizontal-target");
  assert(composedButton && horizontalBefore && horizontalTargetBefore,
    "Composed Button / horizontal ScrollArea showcase nodes are missing");
  assert.equal(composedButton.kind, "pressable");
  assert.equal(composedButton.control?.role, "button");
  assert.equal(composedButton.control?.label, "Create project");

  const rootScroller = byId.get("components-scroll");
  assert(rootScroller, "Showcase root Scroll is missing");
  app.debug({ type: "input", action: "move",
    x: rootScroller.x + rootScroller.width / 2, y: rootScroller.y + rootScroller.height / 2 });
  app.debug({ type: "input", action: "wheel", delta: Math.max(0, horizontalBefore.y - 260) });
  await Bun.sleep(50);
  byId = map(await app.inspect());
  const horizontal = byId.get("demo-horizontal-scroll");
  const horizontalTarget = byId.get("demo-horizontal-target");
  assert(horizontal && horizontalTarget, "Horizontal ScrollArea disappeared after root scroll");
  const targetXBefore = horizontalTarget.x;
  app.debug({ type: "input", action: "move",
    x: horizontal.x + horizontal.width / 2, y: horizontal.y + horizontal.height / 2 });
  app.debug({ type: "input", action: "wheel", deltaX: 180, deltaY: 0 });
  await Bun.sleep(50);
  byId = map(await app.inspect());
  const horizontalAfter = byId.get("demo-horizontal-scroll");
  const horizontalTargetAfter = byId.get("demo-horizontal-target");
  assert(horizontalAfter && horizontalTargetAfter);
  assert((horizontalAfter.scrollX ?? 0) > 0, "Horizontal ScrollArea did not change scrollX");
  assert(horizontalTargetAfter.x < targetXBefore, "Horizontal content did not move left after scrolling");
  await app.capture(resolve(out, "components-horizontal-scroll-real.png"));

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
  const visibleSlots = Array.from({ length: 6 }, (_, index) => byId.get("demo-otp-slot-" + index));
  assert(visibleSlots.every(Boolean));
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
  const afterResizable = map(hovered);
  const treeBefore = afterResizable.get("demo-tree");
  assert(treeBefore, "Showcase TreeView is missing");
  app.debug({ type: "input", action: "move", x: scroller.x + scroller.width / 2, y: scroller.y + scroller.height / 2 });
  app.debug({ type: "input", action: "wheel", delta: Math.max(0, treeBefore.y - 240) });
  await Bun.sleep(50);
  byId = map(await app.inspect());
  const tree = byId.get("demo-tree");
  const treeSelected = byId.get("demo-tree-node-components");
  const grid = byId.get("demo-grid");
  const gridHeader = byId.get("demo-grid-header");
  const gridRow = byId.get("demo-grid-row-2");
  assert(tree && treeSelected && grid && gridHeader && gridRow, "Showcase TreeView/DataGrid nodes are missing");
  assert.equal(tree.control?.role, "tree");
  assert.equal(treeSelected.control?.role, "treeitem");
  assert.equal(treeSelected.control?.selected, true);
  assert.equal(grid.control?.role, "grid");
  assert.equal(gridRow.control?.role, "option");
  assert.equal(gridRow.control?.selected, true);
  assert(gridHeader.height >= 37 && gridHeader.height <= 39,
    "DataGrid header height changed unexpectedly: " + gridHeader.height);
  await app.capture(resolve(out, "components-desktop-real.png"));
  const finalScroll = byId.get("components-scroll");
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
      rects: visibleSlots.map(slot => ({ x: slot!.x, y: slot!.y, width: slot!.width, height: slot!.height })),
    },
    resizable: {
      kind: splitter.kind,
      width: splitter.width,
      x: Number(splitter.x.toFixed(1)),
      y: Number(splitter.y.toFixed(1)),
      hovered: hovered.hovered,
    },
    composedButton: {
      kind: composedButton.kind,
      role: composedButton.control?.role,
      label: composedButton.control?.label,
    },
    svgIcons: {
      svg: `${svgImage.width}x${svgImage.height}`,
      externalLibraries: {
        lucide: `${lucideReactCamera.width}x${lucideReactCamera.height}`,
        heroicons: `${heroiconsCamera.width}x${heroiconsCamera.height}`,
        phosphor: `${phosphorCamera.width}x${phosphorCamera.height}`,
        tabler: `${tablerCamera.width}x${tablerCamera.height}`,
      },
      icons: lucideIconNames,
    },
    horizontalScroll: {
      offsetX: Number((horizontalAfter.scrollX ?? 0).toFixed(1)),
      maxX: Number((horizontalAfter.scrollMaxX ?? 0).toFixed(1)),
      targetMoved: Number((targetXBefore - horizontalTargetAfter.x).toFixed(1)),
    },
    desktop: {
      treeRole: tree.control?.role,
      selectedTreeItem: treeSelected.id,
      gridRole: grid.control?.role,
      selectedGridRow: gridRow.id,
      gridHeaderHeight: gridHeader.height,
    },
    scroll: Number(finalScroll.scroll.toFixed(1)),
    captures: [
      resolve(out, "components-chart-real.png"),
      resolve(out, "components-horizontal-scroll-real.png"),
      resolve(out, "components-otp-real.png"),
      resolve(out, "components-resizable-real.png"),
      resolve(out, "components-desktop-real.png"),
    ],
  }, null, 2));
} finally {
  app.close();
  await app.closed;
}
