// A muted <video> playing off screen: its new pictures cause no UI paints, after
// a while it stops decoding pictures (time and events go on), and back on screen
// it shows moving pictures again from the current time. Once in a window (D3D11:
// the Source Reader path) and once headless (the Media Engine path, pictures read
// back). Needs ffmpeg on PATH; the window shows while it runs.
// bun scripts/smoke-video-offscreen.tsx
import { createApp, Window } from "@tarve/core";
import { strict as assert } from "node:assert";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { readPng } from "./video-layers/png";

process.env.TARVE_AUDIO ??= "silent";
const work = join(import.meta.dirname, "..", "work", "smoke-video-offscreen");
mkdirSync(work, { recursive: true });
const clip = join(work, "clip.mp4");
if (!existsSync(clip)) {
  const made = spawnSync("ffmpeg", ["-y", "-loglevel", "error", "-f", "lavfi", "-i", "testsrc2=size=320x240:rate=30:duration=12",
    "-f", "lavfi", "-i", "sine=frequency=440:duration=12", "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac", "-shortest", clip], { stdio: "inherit" });
  if (made.status !== 0) throw new Error("ffmpeg could not make the clip (is it on PATH?)");
}

const index = process.argv.indexOf("--mode");
if (index < 0) {
  for (const mode of ["window", "headless"]) {
    const run = spawnSync(process.execPath, [import.meta.filename, "--mode", mode], { stdio: "inherit" });
    if (run.status !== 0) process.exit(run.status ?? 1);
  }
  process.exit(0);
}
const mode = process.argv[index + 1]!;

let top = 2000;
let time = 0;
let ended = 0;
const errors: string[] = [];
const app = createApp(() => (
  <Window width={400} height={300} style={{ background: "#ffffff" }}>
    <video id="clip" src={clip} autoPlay muted style={{ position: "absolute", left: 0, top, width: 320, height: 240 }}
      onTimeUpdate={info => { time = info.currentTime; }} onEnded={() => { ended++; }} onError={message => errors.push(message)} />
  </Window>
), { debug: true, headless: mode === "headless", onError: event => errors.push(event.error.message) });
await app.ready;
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
async function until(label: string, predicate: () => boolean, timeout = 8000) {
  const end = Date.now() + timeout;
  while (!predicate()) {
    if (errors.length) throw new Error(`${label}: ${errors.join(" | ")}`);
    if (Date.now() > end) throw new Error(`${label}: timed out`);
    await sleep(20);
  }
}

await until("playing", () => time > 0.3);
// Off screen: new pictures paint nothing.
const before = (await app.inspect()).paints;
await sleep(1000);
const offPaints = (await app.inspect()).paints - before;
assert.ok(offPaints <= 1, `an off screen video paints the UI ${offPaints} times a second`);
// Long enough to stop decoding pictures; the time goes on.
await sleep(3000);
const hiddenTime = time;
await sleep(1000);
assert.ok(time > hiddenTime + 0.5, `the time goes on off screen (${hiddenTime.toFixed(2)} → ${time.toFixed(2)} s)`);
// Back on screen: moving pictures from the current time.
top = 0;
app.update();
const back = time;
await sleep(700);
/** The picture's area: from the screen in a window (a layered video reaches the
 * screen without a UI frame, so a capture would show the last frame's picture),
 * from a capture headless. */
async function shot(name: string) {
  const path = join(work, `${mode}-${name}.png`);
  if (mode === "window") {
    const run = spawnSync("powershell", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", join(import.meta.dirname, "video-layers", "screen.ps1"), "-ProcessId", String(process.pid), "-Out", path], { encoding: "utf8" });
    assert.equal(run.status, 0, run.stderr);
  } else {
    await app.capture(path);
  }
  const png = readPng(path);
  const scale = (await app.inspect()).scale;
  const pixels: number[] = [];
  const colors = new Set<string>();
  for (let y = 0; y < 110; y++) for (let x = 0; x < 150; x++) {
    const [r, g, b] = png.pixel(Math.floor((4 + x * 2) * scale), Math.floor((4 + y * 2) * scale));
    pixels.push(r + g + b);
    colors.add(`${r >> 4},${g >> 4},${b >> 4}`);
  }
  return { pixels, colors: colors.size };
}
const first = await shot("back");
await sleep(500);
const second = await shot("later");
const moved = first.pixels.filter((value, i) => Math.abs(value - second.pixels[i]!) > 30).length;
assert.ok(first.colors > 12, `the picture is drawn again (${first.colors} colours)`);
assert.ok(moved > 50, `the picture moves again (${moved} pixels changed)`);
assert.ok(time >= back, `the time does not jump back (${back.toFixed(2)} → ${time.toFixed(2)} s)`);
const after = time;
// Off screen again until it ends (no pictures decoded by then); back on screen,
// play() starts it over like any ended video.
top = 2000;
app.update();
await until("ended off screen", () => ended > 0, 15000);
top = 0;
app.update();
await sleep(500);
app.media("clip").play();
await sleep(1200);
assert.equal(ended, 1, "play() after an ended video plays it again, it does not end at once");
assert.ok(time > 0.3 && time < 3, `play() after the end starts over (time ${time.toFixed(2)} s)`);
assert.deepEqual(errors, []);
app.close();
await app.closed;
console.log(`[tarve smoke:video-offscreen] ${mode} PASS (${offPaints} UI paints/s off screen; time ${hiddenTime.toFixed(2)} → ${back.toFixed(2)} s hidden, ${after.toFixed(2)} s after; ${moved} pixels moved on screen; ended off screen, replayed to ${time.toFixed(2)} s)`);
process.exit(0);
