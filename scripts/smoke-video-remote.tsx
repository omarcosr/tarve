// A <video> over HTTP read through the app's own download: a file whose index
// (moov) is at its end opens with a range request instead of downloading it all,
// a server without ranges still plays, a seek far ahead plays from there, and a
// long file is not held in memory whole. A local server stands in for the CDN.
// The window opens in the background (TARVE_BACKGROUND). Needs ffmpeg on PATH.
// bun scripts/smoke-video-remote.tsx
import { createApp, Window } from "@tarve/core";
import { strict as assert } from "node:assert";
import { spawnSync } from "node:child_process";
import { createReadStream, existsSync, mkdirSync, statSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";

process.env.TARVE_AUDIO ??= "silent";
process.env.TARVE_BACKGROUND ??= "1";
const work = join(import.meta.dirname, "..", "work", "smoke-video-remote");
mkdirSync(work, { recursive: true });
// 60 s at 4 Mb/s (about 30 MB), index at the end as ffmpeg writes it by default.
const clip = join(work, "clip.mp4");
if (!existsSync(clip)) {
  const made = spawnSync("ffmpeg", ["-y", "-loglevel", "error", "-f", "lavfi", "-i", "testsrc2=size=1280x720:rate=30:duration=60",
    "-f", "lavfi", "-i", "sine=frequency=440:duration=60", "-c:v", "libx264", "-b:v", "4M", "-maxrate", "4M", "-bufsize", "8M",
    "-pix_fmt", "yuv420p", "-c:a", "aac", "-shortest", clip], { stdio: "inherit" });
  if (made.status !== 0) throw new Error("ffmpeg could not make the clip (is it on PATH?)");
}
const size = statSync(clip).size;

const mode = process.argv[2] ?? "all";
if (mode === "all") {
  for (const next of ["ranges", "no-ranges"]) {
    const run = spawnSync(process.execPath, [import.meta.filename, next], { stdio: "inherit" });
    if (run.status !== 0) process.exit(run.status ?? 1);
  }
  process.exit(0);
}
const ranges = mode === "ranges";

let served = 0;
const requests: string[] = [];
// node:http, not Bun.serve: Bun answers a Range header itself, even when told not to.
const server = createServer((request, response) => {
  const range = ranges ? request.headers.range : undefined;
  let start = 0;
  let end = size - 1;
  if (range) {
    const match = /bytes=(\d*)-(\d*)/.exec(range)!;
    start = match[1] ? Number(match[1]) : size - Number(match[2]);
    end = match[1] && match[2] ? Math.min(Number(match[2]), size - 1) : size - 1;
  }
  requests.push(`${start}-${end}`);
  const headers: Record<string, string> = { "content-type": "video/mp4", "content-length": String(end - start + 1) };
  if (ranges) headers["accept-ranges"] = "bytes";
  if (range) headers["content-range"] = `bytes ${start}-${end}/${size}`;
  response.writeHead(range ? 206 : 200, headers);
  const body = createReadStream(clip, { start, end });
  // What actually went out: a client that stops reading closes the connection.
  body.on("data", chunk => { served += chunk.length; });
  response.on("close", () => body.destroy());
  body.pipe(response);
});
await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/clip.mp4`;

let time = 0;
let loadedAt = 0;
const events: string[] = [];
const errors: string[] = [];
const started = performance.now();
const app = createApp(() => (
  <Window width={660} height={380} style={{ background: "#000000" }}>
    <video id="clip" src={url} autoPlay muted style={{ width: 640, height: 360 }}
      onLoadedMetadata={() => { loadedAt = performance.now() - started; events.push("loadedmetadata"); }}
      onTimeUpdate={info => { time = info.currentTime; }} onSeeked={() => events.push("seeked")}
      onError={message => errors.push(message)} />
  </Window>
), { debug: true, onError: event => errors.push(event.error.message) });
await app.ready;
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
async function until(label: string, predicate: () => boolean, timeout = 10000) {
  const end = Date.now() + timeout;
  while (!predicate()) {
    if (errors.length) throw new Error(`${mode} ${label}: ${errors.join(" | ")}`);
    if (Date.now() > end) throw new Error(`${mode} ${label}: timed out (requests ${requests.join(", ")})`);
    await sleep(20);
  }
}

await until("loadedmetadata", () => events.includes("loadedmetadata"));
await until("playing", () => time > 1);
// The window ahead of playback (16 MB) and a little behind it, not the whole file.
await sleep(1000);
const servedWhilePlaying = served;
if (ranges) {
  assert.ok(requests.some(request => Number(request.split("-")[0]) > size / 2), `the index at the end is fetched by a range (${requests.join(", ")})`);
  assert.ok(servedWhilePlaying < size * 0.8, `only a window around playback downloads (${(servedWhilePlaying / 1e6).toFixed(1)} of ${(size / 1e6).toFixed(1)} MB: ${requests.join(", ")})`);
}
// A seek far ahead plays from there.
app.media("clip").seek(45);
await until("seeked", () => events.includes("seeked"));
await until("playing after the seek", () => time > 45.5);
assert.ok(time < 50, `the seek lands where asked (${time.toFixed(2)} s)`);
assert.deepEqual(errors, []);
app.close();
await app.closed;
server.closeAllConnections();
server.close();
console.log(`[tarve smoke:video-remote] ${mode} PASS (loadedmetadata at ${Math.round(loadedAt)} ms; ${(servedWhilePlaying / 1e6).toFixed(1)} of ${(size / 1e6).toFixed(1)} MB sent while playing; ${requests.length} requests; seeked to ${time.toFixed(2)} s)`);
process.exit(0);
