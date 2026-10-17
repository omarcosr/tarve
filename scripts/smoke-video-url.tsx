// <video src="http://…">: the platform decoder streams over HTTP with range requests
// (seeking fetches only the bytes it needs), with both renderers. A local server
// serves the test clip, so no internet is needed.
// bun scripts/smoke-video-url.tsx
import { createTestRenderer, Window } from "@tarve/core";
import { strict as assert } from "node:assert";
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

process.env.TARVE_AUDIO ??= "silent";
const clip = join(import.meta.dirname, "..", "work", "smoke-video", "clip.mp4");
if (!existsSync(clip)) {
  const made = spawnSync(process.execPath, [join(import.meta.dirname, "smoke-video.tsx"), "--renderer", "cpu"], { stdio: "inherit" });
  if (made.status !== 0) throw new Error("smoke-video.tsx could not make the test clip");
}
// One native app per process: each renderer runs in its own.
const flag = process.argv.indexOf("--renderer");
if (flag < 0) {
  for (const renderer of ["auto", "cpu"]) {
    const run = spawnSync(process.execPath, [import.meta.filename, "--renderer", renderer], { stdio: "inherit" });
    if (run.status !== 0) process.exit(run.status ?? 1);
  }
  process.exit(0);
}
const renderer = process.argv[flag + 1] as "auto" | "cpu";
const bytes = readFileSync(clip);
let ranged = 0;
const server = Bun.serve({ port: 0, fetch(request) {
  if (new URL(request.url).pathname !== "/clip.mp4") return new Response("missing", { status: 404 });
  const range = /bytes=(\d*)-(\d*)/.exec(request.headers.get("range") ?? "");
  if (!range) return new Response(bytes, { headers: { "content-type": "video/mp4", "accept-ranges": "bytes" } });
  ranged++;
  const start = Number(range[1] || 0), end = range[2] ? Math.min(Number(range[2]), bytes.length - 1) : bytes.length - 1;
  return new Response(bytes.subarray(start, end + 1), { status: 206, headers: {
    "content-type": "video/mp4", "accept-ranges": "bytes",
    "content-range": `bytes ${start}-${end}/${bytes.length}`, "content-length": String(end - start + 1),
  } });
} });
const base = `http://127.0.0.1:${server.port}`;

{
  const events: string[] = [];
  const errors: string[] = [];
  let time = 0;
  let size = [0, 0];
  const app = await createTestRenderer(() => (
    <Window width={400} height={560}>
      <video id="remote" src={`${base}/clip.mp4`} autoPlay muted style={{ width: 320, height: 240 }}
        onLoadedMetadata={info => { events.push("loadedmetadata"); size = [info.videoWidth, info.videoHeight]; }}
        onTimeUpdate={info => { time = info.currentTime; }}
        onSeeked={() => events.push("seeked")} onError={message => errors.push(message)} />
      <video id="missing" src={`${base}/nope.mp4`} muted style={{ width: 80, height: 60 }}
        onError={message => events.push(`missing: ${message}`)} />
    </Window>
  ), { headless: true, renderer, onError: event => errors.push(event.error.message) });
  const until = async (label: string, predicate: () => boolean) => {
    const end = Date.now() + 10_000;
    while (!predicate()) {
      if (errors.length) throw new Error(`${renderer} ${label}: ${errors.join(" | ")}`);
      if (Date.now() > end) throw new Error(`${renderer} ${label}: timed out (${events.join(", ")})`);
      await new Promise(resolve => setTimeout(resolve, 20));
    }
  };
  await until("loadedmetadata", () => events.includes("loadedmetadata"));
  assert.deepEqual(size, [320, 240], `${renderer}: videoWidth/videoHeight over HTTP`);
  await until("playing", () => time > 0.5);
  app.app.media("remote").seek(1.5);
  await until("seeked", () => events.includes("seeked") && time >= 1.4);
  await until("missing error", () => events.some(event => event.startsWith("missing: ")));
  const missing = events.find(event => event.startsWith("missing: "))!;
  assert.match(missing, /not found|404/i, `${renderer}: a missing URL says so (${missing})`);
  app.app.close();
  console.log(`[tarve smoke:video-url] ${renderer} PASS (${missing})`);
}
assert.ok(ranged > 0, `${renderer}: the decoder streams with range requests`);
console.log(`[tarve smoke:video-url] ${renderer}: ${ranged} range requests`);
server.stop(true);
process.exit(0);
