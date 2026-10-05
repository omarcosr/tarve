// Paints examples/text-view.tsx in a hidden window and checks the pixels CSS
// text features must produce: the <mark> background, the ellipsis ink at the
// end of a cut line, the two-line clamp and overflow clipping.
import { createTestRenderer, readPngRgba } from "@tarve/core";
import { strict as assert } from "node:assert";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { App } from "../examples/text-view";

const out = join(import.meta.dirname, "..", "work");
mkdirSync(out, { recursive: true });
const renderer = await createTestRenderer(App, { headless: true });
// Tall enough that every demo is on screen without scrolling.
renderer.app.debug({ type: "resize", width: 760, height: 1500 });
await new Promise(resolve => setTimeout(resolve, 500));
const snapshot = await renderer.app.inspect();
const box = (id: string) => {
  const node = snapshot.nodes.find(candidate => candidate.id === id);
  assert.ok(node, `missing ${id}`);
  return node!;
};
const path = join(out, "smoke-text.png");
await renderer.app.capture(path);
const image = await readPngRgba(path);
const scale = image.width / snapshot.width;
const pixel = (x: number, y: number) => {
  const i = (Math.floor(y * scale) * image.width + Math.floor(x * scale)) * 4;
  return [image.rgba[i]!, image.rgba[i + 1]!, image.rgba[i + 2]!];
};
const count = (x0: number, y0: number, x1: number, y1: number, test: (rgb: number[]) => boolean) => {
  let hits = 0;
  for (let y = y0; y < y1; y += 1 / scale) for (let x = x0; x < x1; x += 1 / scale) if (test(pixel(x, y))) hits++;
  return hits;
};
const dark = (rgb: number[]) => rgb[0]! + rgb[1]! + rgb[2]! < 300;

const inline = box("inline");
const yellow = count(inline.x, inline.y, inline.x + inline.width, inline.y + inline.height, ([r, g, b]) => r! > 230 && g! > 230 && b! < 60);
assert.ok(yellow > 40, `<mark> paints its yellow background (${yellow} px)`);

const ellipsis = box("ellipsis");
assert.equal(Math.round(ellipsis.height), 21, "a nowrap ellipsis line keeps one line box");
const tail = count(ellipsis.x + ellipsis.width - 14, ellipsis.y, ellipsis.x + ellipsis.width, ellipsis.y + ellipsis.height, dark);
assert.ok(tail > 2, `the ellipsis is drawn at the end of the cut line (${tail} px)`);
const beyond = count(ellipsis.x + ellipsis.width + 1, ellipsis.y, ellipsis.x + ellipsis.width + 60, ellipsis.y + ellipsis.height, dark);
assert.equal(beyond, 0, "no text paints past the box");

const clamp = box("clamp");
assert.equal(Math.round(clamp.height), 42, "line-clamp: 2 keeps two 21px lines");
const below = count(clamp.x, clamp.y + clamp.height + 1, clamp.x + clamp.width, clamp.y + clamp.height + 18, dark);
assert.equal(below, 0, "clamped lines are not painted");

const clip = box("clip");
const blue = (rgb: number[]) => rgb[2]! > 180 && rgb[0]! < 120;
assert.ok(count(clip.x + 4, clip.y + 4, clip.x + clip.width - 4, clip.y + clip.height - 4, blue) > 100, "the child paints inside the clip");
assert.equal(count(clip.x + clip.width + 1, clip.y, clip.x + clip.width + 60, clip.y + clip.height, blue), 0, "overflow: hidden clips the right edge");
assert.equal(count(clip.x, clip.y + clip.height + 1, clip.x + clip.width, clip.y + clip.height + 30, blue), 0, "overflow: hidden clips the bottom edge");

renderer.app.close();
console.log("[tarve smoke:text] PASS");
