/**
 * CSS parity with Chrome: each case of `css-parity/cases.ts` is laid out by Tarve's native
 * renderer and every box (relative to `#case`) is compared with Chrome's, recorded in
 * `css-parity/baseline.json` (`bun scripts/css-parity-baseline.ts`). Known differences are listed
 * in `DIVERGENCES` and asserted too, so fixing one fails the test until the entry is removed.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createApp, View, Window, type AppHandle } from "@tarve/core";
import { BASE_CSS, CASES, slug, VISUAL_CASES, VISUAL_CSS } from "../css-parity/cases";
import { decodePng, encodePng } from "../../core/src/png";
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import baseline from "../css-parity/baseline.json";
import { parseCss, registerCss, resetCss } from "./css";
import { beginRender, documentInstance, endRender, setScheduler, windowInstance } from "./dom";
import { canvasBackground, canvasText, rootChildren } from "./render";
import { connectNativeEvents } from "./events";
import { nativePath } from "../../core/src/bridge/runtime";

/** It opens a native window: skipped where the library is not built (unit tests before build:native). */
const nativeBuilt = (() => { try { return existsSync(nativePath()); } catch { return false; } })();

/** Case name → the boxes Tarve still lays out differently from Chrome, and why. */
const DIVERGENCES: Record<string, { boxes: string[]; reason: string }> = {
  "calc, min, max and clamp": {
    boxes: ["a", "b"],
    reason: "math mixing a percentage with lengths (calc(100% - 2rem), max(50px, 20%)) needs the box's size; the native layout takes plain lengths and percentages only",
  },
  "percentage padding and margin": {
    boxes: ["a", "case"],
    reason: "#case is a flex item of the window here (a new block formatting context), so its first child's margin cannot collapse through it as it does under Chrome's <body>",
  },
  "@media max-width switches layout": {
    boxes: ["a", "b", "case"],
    reason: "a flex: 1 item in an auto-height column keeps its specified height as its minimum; CSS's automatic minimum is the (empty) content",
  },
};

type Box = [number, number, number, number];

/** The viewport Chrome laid the cases out in (its window size minus the frame): vw, vh and @media. */
const [viewportWidth, viewportHeight] = (Object.values(baseline)[0] as Record<string, number[]>).__viewport ?? [600, 400];
const VIEWPORT = { width: viewportWidth!, height: viewportHeight! };

// One native app per process: every case renders in the same window, one after another.
let app: AppHandle;
let target = documentInstance.createElement("tarve-root");

async function layout(item: { css: string; html: string; name: string }, extraCss = ""): Promise<Record<string, Box>> {
  resetCss();
  registerCss(parseCss(`${BASE_CSS}\n${extraCss}\n${item.css}`));
  target.remove();
  target = documentInstance.createElement("tarve-root");
  documentInstance.body.appendChild(target);
  target.innerHTML = `<div id="case">${item.html}</div>`;
  app.update();
  // Two idle frames: the layout of the new case has settled.
  let previous = -1;
  for (let tries = 0; tries < 100; tries++) {
    const snapshot = await app.inspect();
    const root = snapshot.nodes.find(node => node.id === "case");
    if (root && snapshot.layouts === previous) {
      const out: Record<string, Box> = {};
      out.case = [0, 0, root.width, root.height];
      out.__origin = [root.x, root.y, 0, 0];
      const windowNode = snapshot.nodes.find(node => node.kind === "window");
      out.__window = [windowNode?.width ?? VIEWPORT.width, windowNode?.height ?? VIEWPORT.height, 0, 0];
      for (const id of Object.keys(baseline[item.name as keyof typeof baseline] ?? {}).filter(id => !id.startsWith("__"))) {
        const node = snapshot.nodes.find(candidate => candidate.id === id);
        if (node) out[id] = [node.x - root.x, node.y - root.y, node.width, node.height];
      }
      return out;
    }
    previous = snapshot.layouts;
    await new Promise(resolve => setTimeout(resolve, 16));
  }
  throw new Error("the case never settled");
}

/** Visual-case difference: decodes both PNGs, brings Tarve's capture to 1× and compares the case box. */
interface Rgba { width: number; height: number; rgba: Uint8Array }
const toRgba = (bytes: Uint8Array): Rgba => {
  const image = decodePng(bytes) as unknown as { width: number; height: number; rgba?: Uint8Array; pixels?: Uint8Array; data?: Uint8Array };
  return { width: image.width, height: image.height, rgba: (image.rgba ?? image.pixels ?? image.data)! };
};
function downsample(image: Rgba, scale: number, width: number, height: number): Rgba {
  if (Math.abs(scale - 1) < 1e-3) return image;
  const out = new Uint8Array(width * height * 4);
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    const x0 = x * scale, x1 = (x + 1) * scale, y0 = y * scale, y1 = (y + 1) * scale;
    const sum = [0, 0, 0, 0]; let weight = 0;
    for (let sy = Math.floor(y0); sy < Math.ceil(y1) && sy < image.height; sy++) for (let sx = Math.floor(x0); sx < Math.ceil(x1) && sx < image.width; sx++) {
      const w = (Math.min(x1, sx + 1) - Math.max(x0, sx)) * (Math.min(y1, sy + 1) - Math.max(y0, sy));
      const i = (sy * image.width + sx) * 4;
      for (let c = 0; c < 4; c++) sum[c]! += image.rgba[i + c]! * w;
      weight += w;
    }
    for (let c = 0; c < 4; c++) out[(y * width + x) * 4 + c] = Math.round(sum[c]! / (weight || 1));
  }
  return { width, height, rgba: out };
}

const mismatches = (expected: Record<string, number[]>, actual: Record<string, Box>, tolerance: number) =>
  Object.entries(expected).filter(([id]) => !id.startsWith("__")).filter(([id, box]) => {
    const got = actual[id];
    return !got || box.some((value, index) => Math.abs(value - got[index]!) > tolerance);
  }).map(([id, box]) => `${id}: chrome [${box.join(", ")}] tarve [${actual[id]?.map(value => Math.round(value * 100) / 100).join(", ") ?? "missing"}]`);

/** Side of the tiles whose mean difference is checked, and the largest mean allowed in one. */
const TILE = 6;
const MAX_TILE_DELTA = 25;

/** Known paint differences: case name → why (asserted to still exceed its threshold). */
const VISUAL_DIVERGENCES: Record<string, string> = {};

describe.skipIf(!nativeBuilt)("CSS layout parity with Chrome", () => {
  beforeAll(async () => {
    windowInstance.innerWidth = VIEWPORT.width;
    windowInstance.innerHeight = VIEWPORT.height;
    app = createApp(() => {
      beginRender();
      try {
        return Window({ title: "CSS parity", ...VIEWPORT, style: { ...canvasText(), background: canvasBackground() ?? "#ffffff" } as never, children: View({ style: { display: "block", width: "100%" }, children: rootChildren(target) }) });
      } finally { endRender(); }
    }, { debug: true, headless: true, pointerEvents: true } as never);
    await app.ready;
  });
  afterAll(() => { app?.close(); target.remove(); resetCss(); });
  for (const item of CASES) {
    test(item.name, async () => {
      const expected = baseline[item.name as keyof typeof baseline] as Record<string, number[]> | undefined;
      if (!expected) throw new Error(`no Chrome baseline for "${item.name}": run bun scripts/css-parity-baseline.ts`);
      const differences = mismatches(expected, await layout(item), item.tolerance ?? 1);
      const known = DIVERGENCES[item.name];
      if (known) expect(differences.map(line => line.split(":")[0])).toEqual(known.boxes);
      else expect(differences).toEqual([]);
    });
  }
  for (const item of VISUAL_CASES) {
    test(`paint: ${item.name}`, async () => {
      const reference = join(import.meta.dirname, "../css-parity/visual", `${slug(item.name)}.png`);
      if (!existsSync(reference)) throw new Error(`no Chrome screenshot for "${item.name}": run bun scripts/css-parity-baseline.ts`);
      const boxes = await layout(item, VISUAL_CSS);
      // A fixed-position UI (a player's control bar) is compared over the whole viewport.
      const [originX, originY] = item.wholeViewport ? [0, 0] : boxes.__origin!;
      const [, , caseWidth, caseHeight] = item.wholeViewport ? [0, 0, boxes.__window![0]!, boxes.__window![1]!] : boxes.case!;
      const capture = join(tmpdir(), `tarve-parity-${slug(item.name)}.png`);
      await app.capture(capture);
      const shot = toRgba(new Uint8Array(readFileSync(capture)));
      const [windowWidth, windowHeight] = boxes.__window!;
      const scale = shot.width / windowWidth!;
      const tarve = downsample(shot, scale, Math.round(windowWidth!), Math.round(windowHeight!));
      const chrome = toRgba(new Uint8Array(readFileSync(reference)));
      const width = Math.min(Math.round(caseWidth), chrome.width), height = Math.min(Math.round(caseHeight), chrome.height);
      let total = 0, far = 0;
      const diff = new Uint8Array(width * 3 * height * 4);
      const deltas = new Float32Array(width * height);
      for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
        const c = (y * chrome.width + x) * 4, t = ((y + Math.round(originY)) * tarve.width + x + Math.round(originX)) * 4;
        let delta = 0;
        for (let k = 0; k < 3; k++) delta += Math.abs(chrome.rgba[c + k]! - tarve.rgba[t + k]!);
        total += delta / 3;
        // Luminance: Chrome's subpixel (ClearType) text fringes are colour, not shape.
        const luma = (image: Uint8Array, i: number) => 0.2126 * image[i]! + 0.7152 * image[i + 1]! + 0.0722 * image[i + 2]!;
        deltas[y * width + x] = luma(chrome.rgba, c) - luma(tarve.rgba, t);
        if (delta / 3 > 48) far++;
        for (let k = 0; k < 4; k++) {
          diff[(y * width * 3 + x) * 4 + k] = chrome.rgba[c + k]!;
          diff[(y * width * 3 + x + width) * 4 + k] = tarve.rgba[t + k]!;
        }
        const d = Math.min(255, delta * 2);
        diff.set([d, d, d, 255], (y * width * 3 + x + 2 * width) * 4);
      }
      const mean = total / (width * height);
      // A small wrong detail (a stray edge, a missing corner) barely moves the mean over the whole
      // case: the worst 6×6 tile catches it.
      let worstTile = 0, worstAt = "";
      for (let ty = 0; ty + TILE <= height; ty += TILE / 2) for (let tx = 0; tx + TILE <= width; tx += TILE / 2) {
        let sum = 0;
        for (let y = ty; y < ty + TILE; y++) for (let x = tx; x < tx + TILE; x++) sum += deltas[y * width + x]!;
        if (Math.abs(sum) / (TILE * TILE) > worstTile) { worstTile = Math.abs(sum) / (TILE * TILE); worstAt = `${tx},${ty}`; }
      }
      if (process.env.PARITY_REPORT) console.log(`PARITY ${item.name}: mean ${mean.toFixed(2)} far ${(far / (width * height) * 100).toFixed(2)}% tile ${worstTile.toFixed(1)} at ${worstAt}`);
      const out = join(tmpdir(), "tarve-css-parity");
      mkdirSync(out, { recursive: true });
      // chrome | tarve | difference, for a look when it fails.
      writeFileSync(join(out, `${slug(item.name)}.png`), encodePng(diff, width * 3, height));
      const limit = item.maxMeanDelta ?? 3;
      if (VISUAL_DIVERGENCES[item.name]) expect(mean).toBeGreaterThan(limit);
      else {
        expect(Math.round(mean * 100) / 100).toBeLessThanOrEqual(limit);
        // Besides the mean, few pixels may differ much: a box in the wrong place does.
        expect(Math.round(far / (width * height) * 10000) / 100).toBeLessThanOrEqual(item.maxFarPercent ?? 1);
        expect(Math.round(worstTile * 10) / 10).toBeLessThanOrEqual(item.maxTileDelta ?? MAX_TILE_DELTA);
      }
    });
  }
  // A CSS spinner (`@keyframes spin { to { transform: rotate(360deg) } }`): the missing `from` is
  // implicit (no rotation), so the ring turns; two captures a moment apart differ.
  test("animation: a to-only @keyframes spinner turns", async () => {
    // As mount() does: DOM changes (an animation frame) re-render the app.
    setScheduler(() => app.update());
    await layout({ name: "spinner", css: `@keyframes spin { to { transform: rotate(360deg); } } #s { width: 48px; height: 48px; border: 4px solid #333; border-top-color: #e11; border-radius: 50%; animation: spin 0.8s linear infinite; }`, html: `<div id="s"></div>` }, VISUAL_CSS);
    const shot = async (name: string) => {
      const path = join(tmpdir(), `tarve-parity-spin-${name}.png`);
      await app.capture(path);
      return toRgba(new Uint8Array(readFileSync(path)));
    };
    await new Promise(resolve => setTimeout(resolve, 100));
    const first = await shot("a");
    await new Promise(resolve => setTimeout(resolve, 230));
    const second = await shot("b");
    let changed = 0;
    for (let i = 0; i < first.rgba.length; i += 4) if (Math.abs(first.rgba[i]! - second.rgba[i]!) > 40) changed++;
    setScheduler(undefined as never);
    expect(changed).toBeGreaterThan(50);
  });
  // Pointer events through the real runtime (hit testing, per-element reports), on the same app:
  // a seek bar under a full-window click layer, as Pobretube's player has. Its hover tooltip needs
  // clientX in the viewport (clientX - rect.left is the hovered offset) and a pointerleave when the
  // pointer goes, though native's single hovered node is the click layer above it.
  test("pointer: a seek bar under a click layer gets viewport clientX and its pointerleave", async () => {
    const disconnect = connectNativeEvents(app);
    try {
      const log: string[] = [];
      const html = `<div id="layer" style="position: absolute; left: 0; top: 0; width: 600px; height: 400px"></div><div id="bar" style="position: absolute; left: 100px; top: 200px; width: 300px; height: 20px"></div>`;
      resetCss();
      target.remove();
      target = documentInstance.createElement("tarve-root");
      documentInstance.body.appendChild(target);
      target.innerHTML = html;
      target.querySelector("#layer")!.addEventListener("click", () => log.push("layer click"));
      const bar = target.querySelector("#bar")!;
      // What Controls.svelte does: the offset from the box's client rect, and hide on leave.
      bar.addEventListener("pointermove", event => log.push(`move ${Math.round((event as unknown as { clientX: number }).clientX - bar.getBoundingClientRect().left)}`));
      bar.addEventListener("pointerleave", () => log.push("leave"));
      app.update();
      const settle = async () => {
        let previous = -1;
        for (let tries = 0; tries < 100; tries++) {
          const { frames, layouts } = await app.inspect();
          if (frames + layouts === previous) return;
          previous = frames + layouts;
          await new Promise(resolve => setTimeout(resolve, 32));
        }
      };
      await settle();
      const box = (await app.inspect()).nodes.find(node => node.id === "bar")!;
      const move = async (dx: number, dy: number) => { app.debug({ type: "input", action: "move", x: box.x + dx, y: box.y + dy } as never); await settle(); };
      // The first move asks native for the bar's box; the next ones read it.
      await move(50, 10);
      await move(60, 10);
      await move(150, 10);
      expect(log.filter(line => line.startsWith("move")).slice(-2)).toEqual(["move 60", "move 150"]);
      await move(150, -100);
      expect(log.filter(line => line === "leave")).toEqual(["leave"]);
      expect(log.at(-1)).toBe("leave");
      // Dragging the seek bar: pointerdown captures the pointer, so moves keep coming outside the
      // box (offsets past its width) and pointerup lands on it, then capture ends by itself.
      bar.addEventListener("pointerdown", event => { bar.setPointerCapture((event as unknown as { pointerId: number }).pointerId); log.push("down"); });
      bar.addEventListener("pointerup", () => log.push(`up ${bar.hasPointerCapture(1)}`));
      bar.addEventListener("lostpointercapture", () => log.push("lost"));
      await move(100, 10);
      app.debug({ type: "input", action: "down" } as never);
      await settle();
      await move(200, -80);
      await move(400, -80);
      expect(log.filter(line => line.startsWith("move")).slice(-2)).toEqual(["move 200", "move 400"]);
      app.debug({ type: "input", action: "up" } as never);
      await settle();
      await move(410, -80);
      expect(log.slice(log.lastIndexOf("down"))).toEqual(["down", "move 200", "move 400", "up true", "lost", "leave"]);
      expect(log).not.toContain("layer click");
    } finally { disconnect(); }
  });
});
