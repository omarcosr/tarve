// Plays a generated H.264/AAC clip through <video> with the platform decoder and
// checks the HTMLMediaElement lifecycle and the pictures on screen, once with the
// D3D11 renderer (decoded straight into its textures) and once with the CPU
// renderer (pictures read back). Needs ffmpeg on PATH to make the clip.
// bun scripts/smoke-video.tsx [--renderer auto|cpu]
import { createTestRenderer, Window } from "@tarve/core";
import { strict as assert } from "node:assert";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { readPng } from "./video-layers/png";

process.env.TARVE_AUDIO ??= "silent";
const work = join(import.meta.dirname, "..", "work", "smoke-video");
mkdirSync(work, { recursive: true });
const clip = join(work, "clip.mp4");
if (!existsSync(clip)) {
  const made = spawnSync("ffmpeg", ["-y", "-loglevel", "error", "-f", "lavfi", "-i", "testsrc2=size=320x240:rate=30:duration=2",
    "-f", "lavfi", "-i", "sine=frequency=440:duration=2", "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac", "-shortest", clip], { stdio: "inherit" });
  if (made.status !== 0) throw new Error("ffmpeg could not make the test clip (is it on PATH?)");
}

// Four coloured quadrants: the picture must be upright, with red and blue in place.
const quad = join(work, "quad.mp4");
if (!existsSync(quad)) {
  const made = spawnSync("ffmpeg", ["-y", "-loglevel", "error",
    "-f", "lavfi", "-i", "color=c=red:s=160x120:d=1", "-f", "lavfi", "-i", "color=c=lime:s=160x120:d=1",
    "-f", "lavfi", "-i", "color=c=blue:s=160x120:d=1", "-f", "lavfi", "-i", "color=c=white:s=160x120:d=1",
    "-filter_complex", "[0][1][2][3]xstack=inputs=4:layout=0_0|w0_0|0_h0|w0_h0", "-c:v", "libx264", "-pix_fmt", "yuv420p", quad], { stdio: "inherit" });
  if (made.status !== 0) throw new Error("ffmpeg could not make the quadrant clip");
}

const index = process.argv.indexOf("--renderer");
if (index < 0) {
  for (const renderer of ["auto", "cpu"]) {
    const run = spawnSync(process.execPath, [import.meta.filename, "--renderer", renderer], { stdio: "inherit" });
    if (run.status !== 0) process.exit(run.status ?? 1);
  }
  process.exit(0);
}
const renderer = process.argv[index + 1] as "auto" | "cpu";

const events: string[] = [];
const errors: string[] = [];
let size = [0, 0];
let lastTime = 0;
const app = await createTestRenderer(() => (
  <Window width={400} height={560} style={{ background: "#ffffff" }}>
    <video id="quad" src={quad} style={{ width: 320, height: 240 }} onError={message => errors.push(message)} />
    <video id="clip" src={clip} muted style={{ width: 320, height: 240 }}
      onLoadedMetadata={info => { events.push("loadedmetadata"); size = [info.videoWidth, info.videoHeight]; }}
      onPlay={() => events.push("play")}
      onTimeUpdate={info => { events.push("timeupdate"); lastTime = info.currentTime; }}
      onSeeked={() => events.push("seeked")}
      onEnded={() => events.push("ended")}
      onError={message => errors.push(message)} />
  </Window>
), { headless: true, renderer, onError: event => errors.push(event.error.message) });

async function until(label: string, predicate: () => boolean, timeout = 8000) {
  const end = Date.now() + timeout;
  while (!predicate()) {
    if (errors.length) throw new Error(`${label}: ${errors.join(" | ")}`);
    if (Date.now() > end) throw new Error(`${label}: timed out; events ${events.join(",")}`);
    await new Promise(resolve => setTimeout(resolve, 20));
  }
}

/** Distinct colours in the video's box, and its average colour. */
async function shot(name: string) {
  const path = join(work, `${renderer}-${name}.png`);
  await app.capture(path);
  const png = readPng(path);
  const box = (await app.app.inspect()).nodes.find(node => node.id === "clip")!;
  const scale = png.width / 400;
  const colors = new Set<string>();
  const pixels: number[] = [];
  for (let y = 0; y < 116; y++) for (let x = 0; x < 156; x++) {
    const [r, g, b] = png.pixel(Math.floor((box.x + 2 + x * 2) * scale), Math.floor((box.y + 2 + y * 2) * scale));
    colors.add(`${r >> 4},${g >> 4},${b >> 4}`);
    pixels.push(r + g + b);
  }
  return { colors: colors.size, pixels };
}

// A paused video shows its first picture: upright, colours in place.
await new Promise(resolve => setTimeout(resolve, 1500));
{
  const path = join(work, `${renderer}-quad.png`);
  await app.capture(path);
  const png = readPng(path);
  const box = (await app.app.inspect()).nodes.find(node => node.id === "quad")!;
  const scale = png.width / 400;
  const at = (fx: number, fy: number) => png.pixel(Math.floor((box.x + box.width * fx) * scale), Math.floor((box.y + box.height * fy) * scale));
  const near = (actual: number[], expected: number[]) => actual.every((value, i) => Math.abs(value - expected[i]!) < 40);
  for (const [fx, fy, color] of [[0.25, 0.25, [255, 0, 0]], [0.75, 0.25, [0, 255, 0]], [0.25, 0.75, [0, 0, 255]], [0.75, 0.75, [255, 255, 255]]] as const) {
    assert.ok(near(at(fx, fy), [...color]), `quadrant ${fx},${fy}: ${at(fx, fy)} should be ${color}`);
  }
}
await until("loadedmetadata", () => events.includes("loadedmetadata"));
assert.deepEqual(size, [320, 240], "videoWidth/videoHeight");
app.app.media("clip").play();
await until("play", () => events.includes("play"));
// Cost while playing: CPU time of the whole process (decoder, event loop, renderer),
// measured before any capture so no screenshot work lands in the window.
await new Promise(resolve => setTimeout(resolve, 150));
const cpuBefore = process.cpuUsage();
const wallBefore = performance.now();
await new Promise(resolve => setTimeout(resolve, 700));
const cpu = process.cpuUsage(cpuBefore);
const cpuPercent = ((cpu.user + cpu.system) / 1000) / (performance.now() - wallBefore) * 100;
await until("timeupdate", () => lastTime > 0.4);
const first = await shot("playing");
assert.ok(first.colors > 12, `the picture is drawn (${first.colors} colours)`);
const firstTime = lastTime;
await until("later", () => lastTime > firstTime + 0.6);
const second = await shot("later");
const moved = first.pixels.filter((value, i) => Math.abs(value - second.pixels[i]!) > 30).length;
assert.ok(moved > 50, `the picture moves (${moved} pixels changed)`);
const stats = await app.app.stats();
// Budgets well above the measured cost (CPU 4–16%, frame p50 under 1 ms) that a
// regression to per-frame copies at full size, or to busy polling, would cross.
const cpuBudget = Number(process.env.TARVE_VIDEO_CPU_BUDGET ?? 35);
assert.ok(cpuPercent < cpuBudget, `playing costs ${cpuPercent.toFixed(1)}% of one core (budget ${cpuBudget}%)`);
const frameP50 = stats.native.phases?.frame.p50 ?? 0;
assert.ok(frameP50 < 12, `frame p50 ${frameP50.toFixed(2)} ms (budget 12 ms)`);
await until("ended", () => events.includes("ended"));
// Seek while paused: the picture at that time is drawn (not the last one, not blank),
// and the same time shows the same picture again.
async function seekShot(time: number, name: string) {
  const before = events.filter(e => e === "seeked").length;
  app.app.media("clip").seek(time);
  await until(`seeked ${time}`, () => events.filter(e => e === "seeked").length > before);
  await new Promise(resolve => setTimeout(resolve, 400));
  return shot(name);
}
const atEnd = await shot("ended");
const early = await seekShot(0.5, "seek-early");
const late = await seekShot(1.5, "seek-late");
const again = await seekShot(0.5, "seek-again");
const differ = (a: number[], b: number[]) => a.filter((value, i) => Math.abs(value - b[i]!) > 30).length;
assert.ok(early.colors > 12, `the seeked picture is drawn (${early.colors} colours)`);
assert.ok(differ(early.pixels, atEnd.pixels) > 50, "seeking while paused replaces the last picture");
assert.ok(differ(early.pixels, late.pixels) > 50, "different times show different pictures");
assert.ok(differ(early.pixels, again.pixels) < early.pixels.length / 50, `the same time shows the same picture (${differ(early.pixels, again.pixels)} pixels differ)`);
app.app.close();
console.log(`[tarve smoke:video] ${renderer} PASS (${events.filter(e => e === "timeupdate").length} timeupdates, ${first.colors} colours; playing 320×240@30: ${cpuPercent.toFixed(1)}% of one core, frame p50 ${stats.native.phases?.frame.p50.toFixed(2)} ms, paint p50 ${stats.native.phases?.paint.p50.toFixed(2)} ms)`);
