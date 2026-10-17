// <video> in its own composition layer (Windows, D3D11): checks on the real
// screen that the picture shows through the UI, under what the UI draws over it
// and inside its rounded clip; that new pictures repaint no UI frame; that the
// layer follows layout; and that captures still contain the video. Then the same
// with layers off (TARVE_VIDEO_LAYERS=0), the in-frame path. Needs ffmpeg; the
// window comes to the front while it runs.
// bun scripts/smoke-video-layers.tsx
import { createApp, Window, View } from "@tarve/core";
import { strict as assert } from "node:assert";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { readPng } from "./video-layers/png";

if (process.platform !== "win32") throw new Error("Video layers are a Windows (D3D11) feature.");
process.env.TARVE_AUDIO ??= "silent";
const work = join(import.meta.dirname, "..", "work", "smoke-video-layers");
mkdirSync(work, { recursive: true });
// Four coloured quadrants, 4 s: red, green / blue, white.
const quad = join(work, "quad.mp4");
if (!existsSync(quad)) {
  const made = spawnSync("ffmpeg", ["-y", "-loglevel", "error",
    "-f", "lavfi", "-i", "color=c=red:s=320x240:d=4", "-f", "lavfi", "-i", "color=c=lime:s=320x240:d=4",
    "-f", "lavfi", "-i", "color=c=blue:s=320x240:d=4", "-f", "lavfi", "-i", "color=c=white:s=320x240:d=4",
    "-filter_complex", "[0][1][2][3]xstack=inputs=4:layout=0_0|w0_0|0_h0|w0_h0", "-c:v", "libx264", "-pix_fmt", "yuv420p", quad], { stdio: "inherit" });
  if (made.status !== 0) throw new Error("ffmpeg could not make the clip (is it on PATH?)");
}

if (!process.argv.includes("--run")) {
  for (const layers of ["1", "0"]) {
    const run = spawnSync(process.execPath, [import.meta.filename, "--run"], { stdio: "inherit", env: { ...process.env, TARVE_VIDEO_LAYERS: layers } });
    if (run.status !== 0) process.exit(run.status ?? 1);
  }
  process.exit(0);
}
const layered = process.env.TARVE_VIDEO_LAYERS !== "0";
const label = layered ? "layers" : "in frame";

let left = 40;
let showVideo = true;
let metadata = false;
const errors: string[] = [];
const app = createApp(() => (
  <Window title="Video layers smoke" width={520} height={380} style={{ background: "#ffffff" }}>
    <View id="stage" style={{ position: "relative", margin: { left, top: 40 }, width: 320, height: 240 }}>
      {showVideo ? <video id="clip" src={quad} autoPlay muted loop style={{ width: 320, height: 240, radius: 24 }}
        onLoadedMetadata={() => { metadata = true; }} onError={message => errors.push(message)} /> : null}
      {/* Half-transparent black over the red quadrant: the UI draws on top of the video. */}
      <View id="badge" style={{ position: "absolute", left: 40, top: 40, width: 60, height: 40, background: "rgba(0, 0, 0, 0.5)" }} />
    </View>
  </Window>
), { debug: true, onError: event => errors.push(event.error.message) });
await app.ready;

async function until(what: string, predicate: () => boolean | Promise<boolean>, timeout = 8000) {
  const end = Date.now() + timeout;
  while (!(await predicate())) {
    if (errors.length) throw new Error(`${what}: ${errors.join(" | ")}`);
    if (Date.now() > end) throw new Error(`${label}: ${what} timed out`);
    await new Promise(resolve => setTimeout(resolve, 50));
  }
}

type Snapshot = Awaited<ReturnType<typeof app.inspect>> & { videoLayers?: number; videoLayerError?: string | null };
await until("loadedmetadata", () => metadata);
await new Promise(resolve => setTimeout(resolve, 800));
const snapshot = await app.inspect() as Snapshot;
if (layered) assert.equal(snapshot.videoLayers, 1, `the video is in its own layer (${snapshot.videoLayerError})`);
else assert.equal(snapshot.videoLayers ?? 0, 0, "layers off: drawn in the frame");

// New pictures: no UI frame while layered, one per picture in the frame.
const before = snapshot.paints;
await new Promise(resolve => setTimeout(resolve, 1000));
const paints = (await app.inspect()).paints - before;
if (layered) assert.ok(paints <= 2, `a playing layered video repaints no UI (${paints} paints in 1 s)`);
else assert.ok(paints >= 10, `in the frame, pictures repaint the UI (${paints} paints in 1 s)`);

/** The screen inside the window, and the colour at a point of the stage (logical px). */
function screen(name: string) {
  const path = join(work, `${layered ? "layers" : "frame"}-${name}.png`);
  const shot = spawnSync("powershell", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", join(import.meta.dirname, "video-layers", "screen.ps1"), "-ProcessId", String(process.pid), "-Out", path], { encoding: "utf8" });
  assert.equal(shot.status, 0, shot.stderr);
  const png = readPng(path);
  return (x: number, y: number) => png.pixel(Math.round((left + x) * snapshot.scale), Math.round((40 + y) * snapshot.scale));
}
const near = (actual: number[], expected: number[], tolerance = 45) => actual.every((value, i) => Math.abs(value - expected[i]!) <= tolerance);
function checkPicture(at: (x: number, y: number) => [number, number, number], where: string) {
  for (const [x, y, color, what] of [
    [80, 160, [0, 0, 255], "blue quadrant"], [240, 60, [0, 255, 0], "green quadrant"], [240, 180, [255, 255, 255], "white quadrant"],
    [140, 30, [255, 0, 0], "red quadrant"],
    [70, 60, [128, 0, 0], "the badge blends over the video"],
    [3, 3, [255, 255, 255], "the rounded corner shows the window"],
  ] as const) {
    assert.ok(near(at(x, y), [...color]), `${label} ${where}: ${what} at ${x},${y} is ${at(x, y)}, expected ${color}`);
  }
}
checkPicture(screen("first"), "on screen");

// Layout moves the layer with the UI.
left = 140;
app.update();
await new Promise(resolve => setTimeout(resolve, 600));
checkPicture(screen("moved"), "after moving");

// A capture draws the video into the frame (a capture has no layers).
const capturePath = join(work, `${layered ? "layers" : "frame"}-capture.png`);
await app.capture(capturePath);
const capture = readPng(capturePath);
const captured = (x: number, y: number) => capture.pixel(Math.round((left + x) * snapshot.scale), Math.round((40 + y) * snapshot.scale));
checkPicture(captured, "in a capture");

// The video goes away: no hole is left behind (the UI stays opaque).
showVideo = false;
app.update();
await new Promise(resolve => setTimeout(resolve, 600));
const gone = screen("gone");
for (const [x, y] of [[140, 30], [240, 180], [80, 160]] as const) {
  assert.ok(near(gone(x, y), [255, 255, 255]), `${label}: after the video is removed, ${x},${y} shows the window (${gone(x, y)})`);
}
assert.ok(near(gone(70, 60), [128, 128, 128]), `${label}: the badge over the window (${gone(70, 60)})`);
assert.equal((await app.inspect() as Snapshot).videoLayers ?? 0, 0, "no layer left");

app.close();
await app.closed;
console.log(`[tarve smoke:video-layers] ${label} PASS (${paints} UI paints in 1 s of playback)`);
process.exit(0);
