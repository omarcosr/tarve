// Idle <video> costs: a muted video decodes no sound (unmuting picks it up at
// the same time), and a video paused for 15 s lets go of its decoder, keeps its
// picture on screen, and plays on from where it was. Windows (D3D11 window).
// Needs ffmpeg on PATH; the window shows while it runs.
// bun scripts/smoke-video-idle.tsx
import { createApp, Window } from "@tarve/core";
import { strict as assert } from "node:assert";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { readPng } from "./video-layers/png";

process.env.TARVE_AUDIO ??= "silent";
const work = join(import.meta.dirname, "..", "work", "smoke-video-idle");
mkdirSync(work, { recursive: true });
const clip = join(work, "clip.mp4");
if (!existsSync(clip)) {
  const made = spawnSync("ffmpeg", ["-y", "-loglevel", "error", "-f", "lavfi", "-i", "testsrc2=size=1280x720:rate=30:duration=30",
    "-f", "lavfi", "-i", "sine=frequency=440:duration=30", "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac", "-shortest", clip], { stdio: "inherit" });
  if (made.status !== 0) throw new Error("ffmpeg could not make the clip (is it on PATH?)");
}

let time = 0;
let loaded = false;
const events: string[] = [];
const errors: string[] = [];
const app = createApp(() => (
  <Window width={680} height={400} style={{ background: "#ffffff" }}>
    <video id="clip" src={clip} muted style={{ width: 640, height: 360, margin: 20 }}
      onLoadedMetadata={() => { loaded = true; events.push("loadedmetadata"); }} onTimeUpdate={info => { time = info.currentTime; }}
      onError={message => errors.push(message)} />
  </Window>
), { debug: true, onError: event => errors.push(event.error.message) });
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
const privateMb = async () => (await app.stats()).native.memory?.current?.privateMb ?? 0;
/** A capture draws the last painted frame (the parked picture is painted); a
 * playing layered video reaches only the screen, so motion is read from there. */
async function screen(name: string, fromScreen = false) {
  const path = join(work, `${name}.png`);
  if (fromScreen) {
    const run = spawnSync("powershell", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", join(import.meta.dirname, "video-layers", "screen.ps1"), "-ProcessId", String(process.pid), "-Out", path], { encoding: "utf8" });
    assert.equal(run.status, 0, run.stderr);
  } else {
    await app.capture(path);
  }
  return readPng(path);
}
async function picture(name: string, fromScreen = false) {
  const png = await screen(name, fromScreen);
  const scale = (await app.inspect()).scale;
  const pixels: number[] = [];
  const colors = new Set<string>();
  for (let y = 0; y < 80; y++) for (let x = 0; x < 140; x++) {
    const [r, g, b] = png.pixel(Math.floor((40 + x * 4) * scale), Math.floor((60 + y * 3) * scale));
    pixels.push(r + g + b);
    colors.add(`${r >> 4},${g >> 4},${b >> 4}`);
  }
  return { pixels, colors: colors.size };
}
const differ = (a: number[], b: number[]) => a.filter((value, i) => Math.abs(value - b[i]!) > 30).length;

await until("loadedmetadata", () => loaded);
// Muted: the time runs on the wall clock.
app.media("clip").play();
await until("playing muted", () => time > 1.5);
// Unmuted: the sound picks up where the picture is, without a jump back.
const beforeUnmute = time;
app.media("clip").setMuted(false);
await sleep(1200);
assert.ok(time > beforeUnmute + 0.5 && time < beforeUnmute + 2.5, `unmuting keeps the time going (${beforeUnmute.toFixed(2)} → ${time.toFixed(2)} s)`);
app.media("clip").setMuted(true);
const beforeMute = time;
await sleep(800);
assert.ok(time > beforeMute + 0.3, `muting again keeps the time going (${beforeMute.toFixed(2)} → ${time.toFixed(2)} s)`);
// Paused: the decoder goes after 15 s; the picture stays.
app.media("clip").pause();
await sleep(1000);
const pausedAt = time;
const held = await picture("paused", true);
const memoryHeld = await privateMb();
await sleep(16_000);
const memoryParked = await privateMb();
const parked = await picture("parked", true);
const painted = await picture("parked-capture");
assert.ok(painted.colors > 12, `a paint draws the parked picture (${painted.colors} colours)`);
assert.ok(parked.colors > 12, `the paused picture stays on screen (${parked.colors} colours)`);
assert.ok(differ(held.pixels, parked.pixels) < held.pixels.length / 50, `it is the same picture (${differ(held.pixels, parked.pixels)} pixels differ)`);
assert.ok(memoryHeld - memoryParked > 20, `a parked video lets go of its decoder (${memoryHeld} → ${memoryParked} MB private)`);
// Play: opens again from where it was, and moves.
app.media("clip").play();
await sleep(1500);
assert.ok(time > pausedAt + 0.5 && time < pausedAt + 3, `play goes on from the paused time (${pausedAt.toFixed(2)} → ${time.toFixed(2)} s)`);
const first = await picture("resumed", true);
await sleep(400);
const second = await picture("resumed-later", true);
assert.ok(differ(first.pixels, second.pixels) > 50, "the picture moves again");
assert.equal(events.filter(event => event === "loadedmetadata").length, 1, "reopening fires no second loadedmetadata");
assert.deepEqual(errors, []);
app.close();
await app.closed;
console.log(`[tarve smoke:video-idle] PASS (unmute ${beforeUnmute.toFixed(2)} s; parked ${memoryHeld} → ${memoryParked} MB private; resumed from ${pausedAt.toFixed(2)} s)`);
process.exit(0);
