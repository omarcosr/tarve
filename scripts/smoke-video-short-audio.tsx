// A <video> whose sound ends before its pictures: the clock hands over from the
// sound to the wall, so the pictures play to the end, `ended` fires, and with
// `loop` playback starts over. Needs ffmpeg on PATH.
// bun scripts/smoke-video-short-audio.tsx
import { createTestRenderer, Window } from "@tarve/core";
import { strict as assert } from "node:assert";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";

process.env.TARVE_AUDIO ??= "silent";
const work = join(import.meta.dirname, "..", "work", "smoke-video-short-audio");
mkdirSync(work, { recursive: true });
const clip = join(work, "clip.mp4");
if (!existsSync(clip)) {
  const made = spawnSync("ffmpeg", ["-y", "-loglevel", "error", "-f", "lavfi", "-i", "testsrc2=size=320x240:rate=30:duration=2.5",
    "-f", "lavfi", "-i", "sine=frequency=440:duration=0.8", "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac", clip], { stdio: "inherit" });
  if (made.status !== 0) throw new Error("ffmpeg could not make the clip (is it on PATH?)");
}

// One native app per process: each mode runs in its own.
const index = process.argv.indexOf("--mode");
if (index < 0) {
  for (const mode of ["once", "loop"]) {
    const run = spawnSync(process.execPath, [import.meta.filename, "--mode", mode], { stdio: "inherit" });
    if (run.status !== 0) process.exit(run.status ?? 1);
  }
  process.exit(0);
}
const mode = process.argv[index + 1];

async function run(loop: boolean) {
  const times: number[] = [];
  const events: string[] = [];
  const errors: string[] = [];
  const app = await createTestRenderer(() => (
    <Window width={400} height={300}>
      <video id="v" src={clip} loop={loop} style={{ width: 320, height: 240 }}
        onLoadedMetadata={() => events.push("loadedmetadata")}
        onTimeUpdate={info => times.push(info.currentTime)}
        onEnded={() => events.push("ended")}
        onError={message => errors.push(message)} />
    </Window>
  ), { headless: true });
  const end = Date.now() + 8000;
  while (!events.includes("loadedmetadata") && Date.now() < end) await new Promise(resolve => setTimeout(resolve, 20));
  app.app.media("v").play();
  await new Promise(resolve => setTimeout(resolve, 4000));
  app.app.close();
  assert.deepEqual(errors, []);
  return { times, events };
}

if (mode === "once") {
  const once = await run(false);
  const max = Math.max(...once.times);
  assert.ok(once.events.includes("ended"), `ended fires after the sound ran out (times ${once.times.map(t => t.toFixed(1))})`);
  assert.ok(max > 2.0, `the pictures play past the sound (max ${max.toFixed(2)} s)`);
  console.log(`[tarve smoke:video-short-audio] once PASS (ended at ${max.toFixed(2)} s, sound ends at 0.8 s)`);
} else {
  const looped = await run(true);
  const wrap = looped.times.findIndex((time, i) => i > 0 && time < looped.times[i - 1]! - 1);
  assert.ok(wrap > 0, `loop starts over (times ${looped.times.map(t => t.toFixed(1))})`);
  const after = Math.max(...looped.times.slice(wrap));
  assert.ok(after > 1.2, `after the loop the pictures play past the sound again (max ${after.toFixed(2)} s)`);
  assert.ok(!looped.events.includes("ended"), "a looped video does not end");
  console.log(`[tarve smoke:video-short-audio] loop PASS (wrapped, then reached ${after.toFixed(2)} s)`);
}
