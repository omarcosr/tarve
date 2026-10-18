// <video> across formats and paths: VP8 (whose decoder hands the Source Reader
// no NV12 textures) plays through the Media Engine instead; VP9, HEVC, AV1 and
// H.264 in MKV play; and on the Media Engine path (CPU renderer) play() after
// the end starts over with a `play` event and ends again, and a loop wraps.
// Windows; needs ffmpeg on PATH. bun scripts/smoke-video-formats.tsx
import { createApp, Window } from "@tarve/core";
import { strict as assert } from "node:assert";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";

process.env.TARVE_AUDIO ??= "silent";
const work = join(import.meta.dirname, "..", "work", "smoke-video-formats");
mkdirSync(work, { recursive: true });
const make = (name: string, codec: string[]) => {
  const path = join(work, name);
  if (!existsSync(path)) {
    const made = spawnSync("ffmpeg", ["-y", "-loglevel", "error", "-f", "lavfi", "-i", "testsrc=size=320x240:rate=30:duration=2", ...codec, "-pix_fmt", "yuv420p", path], { stdio: "inherit" });
    if (made.status !== 0) throw new Error(`ffmpeg could not make ${name} (is it on PATH?)`);
  }
  return path;
};
const files = {
  vp8: make("vp8.webm", ["-c:v", "libvpx", "-b:v", "300k"]),
  vp9: make("vp9.webm", ["-c:v", "libvpx-vp9", "-b:v", "300k"]),
  mkv: make("h264.mkv", ["-c:v", "libx264"]),
  mp4: make("h264.mp4", ["-c:v", "libx264"]),
};

const flag = process.argv.indexOf("--renderer");
if (flag < 0) {
  for (const renderer of ["auto", "cpu"]) {
    const run = spawnSync(process.execPath, [import.meta.filename, "--renderer", renderer], { stdio: "inherit" });
    if (run.status !== 0) process.exit(run.status ?? 1);
  }
  process.exit(0);
}
const renderer = process.argv[flag + 1] as "auto" | "cpu";
const events: Record<string, string[]> = {};
const times: Record<string, number> = {};
const errors: string[] = [];
const record = (id: string, name: string) => () => (events[id] ??= []).push(name);
let loop = false;
const app = createApp(() => (
  <Window width={700} height={300}>
    {Object.entries(files).map(([id, src]) => <video key={id} id={id} src={src} loop={id === "mp4" && loop} style={{ width: 160, height: 120 }}
      onLoadedMetadata={record(id, "loadedmetadata")} onPlay={record(id, "play")} onEnded={record(id, "ended")}
      onTimeUpdate={info => { times[id] = info.currentTime; }} onError={message => errors.push(`${id}: ${message}`)} />)}
  </Window>
), { headless: true, renderer, onError: event => errors.push(event.error.message) });
await app.ready;
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
async function until(label: string, predicate: () => boolean, timeout = 8000) {
  const end = Date.now() + timeout;
  while (!predicate()) {
    if (errors.length) throw new Error(`${renderer} ${label}: ${errors.join(" | ")}`);
    if (Date.now() > end) throw new Error(`${renderer} ${label}: timed out (${JSON.stringify(events)})`);
    await sleep(20);
  }
}
const count = (id: string, name: string) => (events[id] ?? []).filter(event => event === name).length;
await until("loadedmetadata", () => Object.keys(files).every(id => count(id, "loadedmetadata") > 0));
for (const id of Object.keys(files)) app.media(id).play();
await until("every format plays", () => Object.keys(files).every(id => (times[id] ?? 0) > 0.5));
for (const id of Object.keys(files)) assert.equal(count(id, "loadedmetadata"), 1, `${renderer} ${id}: one loadedmetadata`);
// play() after the end: from the start, with a `play` event, and it ends again.
await until("ended", () => count("mp4", "ended") === 1);
app.media("mp4").play();
await until("replayed", () => count("mp4", "play") === 2 && (times.mp4 ?? 9) < 1);
await until("ended again", () => count("mp4", "ended") === 2, 5000);
// A loop wraps instead of ending (or running past the end).
loop = true;
app.update();
await sleep(50);
app.media("mp4").play();
await sleep(2600);
assert.equal(count("mp4", "ended"), 2, `${renderer}: a loop does not end`);
assert.ok((times.mp4 ?? 9) < 2.05, `${renderer}: a loop wraps (${times.mp4} s)`);
assert.deepEqual(errors, []);
app.close();
await app.closed;
console.log(`[tarve smoke:video-formats] ${renderer} PASS (vp8, vp9, h264 mkv/mp4 play; replay after the end; loop at ${times.mp4?.toFixed(2)} s)`);
process.exit(0);
