// Plays a 1080p60 H.264 clip in a visible window and reports what it costs:
// process CPU, presented frames per second and frame phases. Needs ffmpeg.
// bun scripts/bench-video.tsx [--renderer auto|cpu]
import { createApp, Window } from "@tarve/core";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";

const work = join(import.meta.dirname, "..", "work", "bench-video");
mkdirSync(work, { recursive: true });
const clip = join(work, "1080p60.mp4");
if (!existsSync(clip)) {
  const made = spawnSync("ffmpeg", ["-y", "-loglevel", "error", "-f", "lavfi", "-i", "testsrc2=size=1920x1080:rate=60:duration=8",
    "-c:v", "libx264", "-preset", "veryfast", "-pix_fmt", "yuv420p", clip], { stdio: "inherit" });
  if (made.status !== 0) throw new Error("ffmpeg could not make the clip");
}
const index = process.argv.indexOf("--renderer");
const renderer = (index >= 0 ? process.argv[index + 1] : "auto") as "auto" | "cpu";
let playing = false;
const app = createApp(() => (
  <Window title="bench video" width={1280} height={720} style={{ background: "#000000" }}>
    <video id="clip" src={clip} autoPlay muted style={{ flex: 1 }} onPlay={() => { playing = true; }} />
  </Window>
), { renderer, debug: true });
await app.ready;
while (!playing) await new Promise(resolve => setTimeout(resolve, 20));
await new Promise(resolve => setTimeout(resolve, 1000));
await app.stats({ reset: true });
const cpu = process.cpuUsage();
const started = performance.now();
const inspected = await app.inspect();
const before = inspected.frames;
const paintsBefore = inspected.paints;
await new Promise(resolve => setTimeout(resolve, 4000));
const seconds = (performance.now() - started) / 1000;
const used = process.cpuUsage(cpu);
const after = await app.inspect();
const frames = after.frames - before;
const uiPaints = after.paints - paintsBefore;
const stats = await app.stats();
const phase = (name: "frame" | "paint" | "present" | "gpu") => stats.native.phases ? `${stats.native.phases[name].p50.toFixed(2)}/${stats.native.phases[name].p95.toFixed(2)}` : "-";
console.log(JSON.stringify({
  renderer, clip: "1920x1080@60 H.264",
  cpuPercentOfOneCore: Math.round((used.user + used.system) / 1000 / (seconds * 1000) * 1000) / 10,
  presentedFps: Math.round(frames / seconds * 10) / 10,
  uiPaintsPerSecond: Math.round(uiPaints / seconds * 10) / 10,
  videoLayers: (after as { videoLayers?: number }).videoLayers, videoLayerError: (after as { videoLayerError?: string }).videoLayerError,
  "frame p50/p95 ms": phase("frame"), "paint p50/p95 ms": phase("paint"), "gpu p50/p95 ms": phase("gpu"),
  memoryMb: stats.native.memory?.current?.privateMb,
}));
app.close();
await app.closed;
