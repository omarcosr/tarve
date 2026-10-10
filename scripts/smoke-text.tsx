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

// text-decoration-style: a dotted underline (abbr[title]) alternates ink and gaps,
// a solid one does not.
const decorations = box("decorations");
const runs = (x0: number, x1: number) => {
  // Every row in the underline band: its inked pixels and the gaps between them.
  const rows: { gaps: number; ink: number }[] = [];
  for (let y = decorations.y + decorations.height * 0.6; y < decorations.y + decorations.height; y += 1 / scale) {
    let gaps = 0, ink = 0, previous = false;
    for (let x = x0; x < x1; x += 1 / scale) {
      const on = dark(pixel(x, y));
      if (on) ink++;
      if (previous && !on) gaps++;
      previous = on;
    }
    rows.push({ gaps, ink });
  }
  return rows;
};
const solidWord = { x0: decorations.x, x1: decorations.x + 40 };
// A solid underline is a row inked across the word in one stroke.
const span = (solidWord.x1 - solidWord.x0) * scale;
assert.ok(runs(solidWord.x0, solidWord.x1).some(row => row.ink >= span * 0.8 && row.gaps <= 1), "solid underline is one stroke");
// The paragraph is full width; the abbr is its last word, so end at the last ink.
let decorationsEnd = decorations.x;
for (let x = decorations.x; x < decorations.x + decorations.width; x += 1 / scale) {
  if (count(x, decorations.y, x + 1 / scale, decorations.y + decorations.height, dark) > 0) decorationsEnd = x;
}
// A dotted one alternates ink and gaps along a row (13+ in 40px), far more often
// than a row through glyphs does (7 at most).
const abbrGaps = Math.max(...runs(decorationsEnd - 40, decorationsEnd).map(row => row.gaps));
assert.ok(abbrGaps >= 10, `abbr underline is dotted (${abbrGaps} gaps)`);

const clip = box("clip");
const blue = (rgb: number[]) => rgb[2]! > 180 && rgb[0]! < 120;
assert.ok(count(clip.x + 4, clip.y + 4, clip.x + clip.width - 4, clip.y + clip.height - 4, blue) > 100, "the child paints inside the clip");
assert.equal(count(clip.x + clip.width + 1, clip.y, clip.x + clip.width + 60, clip.y + clip.height, blue), 0, "overflow: hidden clips the right edge");
assert.equal(count(clip.x, clip.y + clip.height + 1, clip.x + clip.width, clip.y + clip.height + 30, blue), 0, "overflow: hidden clips the bottom edge");

renderer.app.close();
console.log("[tarve smoke:text] PASS");
