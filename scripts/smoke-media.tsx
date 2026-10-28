// Plays a generated WAV through <audio controls autoPlay> in a hidden window and
// checks the HTMLMediaElement lifecycle: loadedmetadata, play, timeupdate,
// ended, seeking and replay after the end. TARVE_AUDIO=silent plays through a
// real-time clock, so it runs on CI machines without a sound card.
import { createTestRenderer, Window } from "@tarve/core";
import { strict as assert } from "node:assert";
import { spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

// Setting process.env does not reach the native library's getenv (Bun keeps its own copy):
// a child process gets TARVE_AUDIO in its real environment.
if (process.env.TARVE_AUDIO === undefined) {
  const run = spawnSync(process.execPath, process.argv.slice(1), { stdio: "inherit", env: { ...process.env, TARVE_AUDIO: "silent" } });
  process.exit(run.status ?? 1);
}
const work = join(import.meta.dirname, "..", "work");
mkdirSync(work, { recursive: true });
const file = join(work, "smoke-tone.wav");
const rate = 44100, seconds = 1.2, samples = Math.round(rate * seconds);
const wav = Buffer.alloc(44 + samples * 2);
wav.write("RIFF", 0); wav.writeUInt32LE(36 + samples * 2, 4); wav.write("WAVEfmt ", 8);
wav.writeUInt32LE(16, 16); wav.writeUInt16LE(1, 20); wav.writeUInt16LE(1, 22); wav.writeUInt32LE(rate, 24);
wav.writeUInt32LE(rate * 2, 28); wav.writeUInt16LE(2, 32); wav.writeUInt16LE(16, 34); wav.write("data", 36); wav.writeUInt32LE(samples * 2, 40);
for (let i = 0; i < samples; i++) wav.writeInt16LE(Math.round(Math.sin(i / rate * 2 * Math.PI * 440) * 8000), 44 + i * 2);
writeFileSync(file, wav);

const events: string[] = [];
let duration: number | null = null;
let lastTime = 0;
const errors: string[] = [];
const renderer = await createTestRenderer(() => (
  <Window width={400} height={200}>
    <audio id="tone" src={file} controls autoPlay
      onLoadedMetadata={info => { events.push("loadedmetadata"); duration = info.duration; }}
      onPlay={() => events.push("play")}
      onPause={() => events.push("pause")}
      onTimeUpdate={info => { events.push("timeupdate"); lastTime = info.currentTime; }}
      onSeeked={() => events.push("seeked")}
      onEnded={() => events.push("ended")}
      onError={message => errors.push(message)} />
  </Window>
), { headless: true, onError: event => errors.push(event.error.message) });

async function until(label: string, predicate: () => boolean, timeout = 6000) {
  const end = Date.now() + timeout;
  while (!predicate()) {
    if (errors.length) throw new Error(`${label}: ${errors.join(" | ")}`);
    if (Date.now() > end) throw new Error(`${label}: timed out; events ${events.join(",")}`);
    await new Promise(resolve => setTimeout(resolve, 25));
  }
}

await until("loadedmetadata", () => events.includes("loadedmetadata"));
assert.ok(duration !== null && Math.abs(duration - seconds) < 0.02, `duration ${duration}`);
await until("play", () => events.includes("play"));
const started = Date.now();
await until("timeupdate", () => events.filter(e => e === "timeupdate").length >= 2);
await until("ended", () => events.includes("ended"));
const elapsed = (Date.now() - started) / 1000;
assert.ok(elapsed > seconds - 0.4 && elapsed < seconds + 1, `plays in real time (${elapsed.toFixed(2)}s)`);
const timeText = (await renderer.app.inspect()).nodes.find(node => node.id === "tone-time")?.text;
assert.equal(timeText, "0:01 / 0:01", "the control bar shows the final time");
// Play after the end starts over, as HTMLMediaElement does; seek and pause work.
await renderer.getById("tone-play").click();
await until("replay", () => events.filter(e => e === "play").length === 2);
renderer.app.media("tone").seek(0.9);
await until("seeked", () => events.includes("seeked"));
renderer.app.media("tone").pause();
await until("pause", () => events.includes("pause"));
assert.ok(lastTime < seconds, "time stays inside the clip");
// playbackRate 2 plays the clip in half the time.
const endedBefore = events.filter(e => e === "ended").length;
renderer.app.media("tone").setPlaybackRate(2);
renderer.app.media("tone").seek(0);
renderer.app.media("tone").play();
const fastStart = Date.now();
await until("ended at rate 2", () => events.filter(e => e === "ended").length > endedBefore);
const fast = (Date.now() - fastStart) / 1000;
assert.ok(fast > seconds / 2 - 0.3 && fast < seconds / 2 + 0.5, `rate 2 plays in half the time (${fast.toFixed(2)}s)`);
renderer.app.close();
console.log(`[tarve smoke:media] PASS (${events.length} events)`);
