// Android end-to-end smoke for CI (an emulator): build with
//   bun packages/core/cli.ts build scripts/smoke-android-ci.tsx --target android-x64 --name CiSmoke --app-id dev.tarve.cismoke --outfile dist/CiSmoke.apk
// and run scripts/android-ci-smoke.sh, which installs and launches it and reads `adb logcat -s tarve`.
// The app checks render, layout, a click, a long press, timers, storage, <video> (metadata,
// playback, seek) and <audio> from bundled files (scripts/assets), device APIs that answer
// without a person (permission state, a notification, dictation's answer), and the Back key: it
// logs "tarve-ci-smoke-ready-back", the script sends a real `adb shell input keyevent 4`, and
// <Window onCloseRequest> must receive it (and keep the window). Then it logs one
// "tarve-ci-smoke <json>" line, each check `true` or an error string, and closes.
import { Button, Column, Input, Text, Window, createApp } from "@tarve/core";
import { readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
// ffmpeg testsrc2 320x240 15 fps, 2 s, H.264 baseline + AAC; a 1 s 660 Hz 8 kHz PCM tone.
import clip from "./assets/ci-clip.mp4" with { type: "file" };
import tone from "./assets/ci-tone.wav" with { type: "file" };

let clicks = 0, holdClicks = 0, longPresses = 0, closeRequests = 0;
const video = { metadata: false, width: 0, height: 0, time: 0, seeking: 0, seeked: 0, seekedAt: -1, error: "" };
const audio = { metadata: false, duration: null as number | null, error: "" };
const app = createApp(() => (
  <Window title="CI smoke" onCloseRequest={event => { closeRequests++; event.preventDefault(); console.log(`tarve-ci-smoke-back ${closeRequests}`); }}>
    <Column id="main" style={{ padding: 16, gap: 8 }}>
      <Text id="title">Tarve on Android</Text>
      <Button id="press" onClick={() => { clicks++; app.update(); }}>{`Clicks: ${clicks}`}</Button>
      <Input id="field" placeholder="Type" />
      <Column id="box" style={{ width: 120, height: 40, background: "#2563eb", transform: "translateX(10%)" }} />
      <div id="hold" style={{ width: 160, height: 48, background: "#16a34a" }}
        onClick={() => { holdClicks++; }} onLongPress={() => { longPresses++; }} />
      <video id="clip" src={clip} muted style={{ width: 160, height: 120 }}
        onLoadedMetadata={info => { video.metadata = true; video.width = info.videoWidth; video.height = info.videoHeight; }}
        onTimeUpdate={info => { video.time = info.currentTime; }}
        onSeeking={() => { video.seeking++; }}
        onSeeked={info => { video.seeked++; video.seekedAt = info.currentTime; video.time = info.currentTime; }}
        onError={message => { video.error = String(message); }} />
      <audio id="tone" src={tone}
        onLoadedMetadata={info => { audio.metadata = true; audio.duration = info.duration; }}
        onError={message => { audio.error = String(message); }} />
    </Column>
  </Window>
), { debug: true });

const results: Record<string, unknown> = { platform: process.platform };
/** What the checks saw, logged on its own line for diagnosis (not part of `ok`). */
const details: Record<string, unknown> = {};
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
/** Resolves once `condition` holds, or rejects naming `what` after `ms` (the CI emulator renders in software: be generous). */
async function until(what: string, condition: () => boolean, ms: number): Promise<void> {
  const deadline = Date.now() + ms;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error(`timed out after ${ms} ms waiting for ${what}`);
    await sleep(50);
  }
}
/** Runs one check: `true`, or the error as a string. No check may hang the smoke. */
async function check(name: string, run: () => unknown | Promise<unknown>, ms = 60_000): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const timeout = new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`timed out after ${ms} ms`)), ms); });
    const value = await Promise.race([Promise.resolve().then(run), timeout]);
    results[name] = value === true ? true : `FAILED ${typeof value === "string" ? value : JSON.stringify(value)}`;
  } catch (error) {
    results[name] = `ERROR ${(error as Error)?.message ?? error}`;
  } finally {
    clearTimeout(timer);
  }
}
async function center(id: string): Promise<{ x: number; y: number }> {
  const node = (await app.inspect()).nodes.find(candidate => candidate.id === id);
  if (!node) throw new Error(`no node #${id}`);
  return { x: node.x + node.width / 2, y: node.y + node.height / 2 };
}

await app.ready;
await check("timer", () => new Promise(resolve => setTimeout(() => resolve(true), 50)));
await check("storage", () => {
  const path = join(tmpdir(), "tarve-ci-smoke.txt");
  writeFileSync(path, "ok");
  return readFileSync(path, "utf8") === "ok";
});
await check("layout", async () => {
  const snapshot = await app.inspect();
  const box = snapshot.nodes.find(node => node.id === "box");
  return !!box && Math.round(box.width) === 120 && Math.round(box.height) === 40 && snapshot.width > 0 || `box ${JSON.stringify(box)}`;
});
await check("click", async () => {
  const { x, y } = await center("press");
  app.debug({ type: "input", action: "move", x, y });
  app.debug({ type: "input", action: "down" });
  app.debug({ type: "input", action: "up" });
  await until("the click", () => clicks === 1, 10_000);
  return clicks === 1 || `clicks ${clicks}`;
});
await check("longPress", async () => {
  const { x, y } = await center("hold");
  app.debug({ type: "input", action: "move", x, y });
  app.debug({ type: "input", action: "down" });
  // The runtime fires it 500 ms into a still press; hold until it did (a slow emulator may lag).
  await sleep(700);
  await until("onLongPress", () => longPresses > 0, 10_000);
  app.debug({ type: "input", action: "up" });
  await sleep(500);
  return longPresses === 1 && holdClicks === 0 || `longPress ${longPresses}, click ${holdClicks}`;
});
await check("videoMetadata", async () => {
  await until("video loadedmetadata", () => video.metadata || !!video.error, 30_000);
  if (video.error) return `error: ${video.error}`;
  return video.width === 320 && video.height === 240 || `videoWidth/Height ${video.width}x${video.height}`;
});
await check("videoPlay", async () => {
  if (!video.metadata) return "no metadata";
  app.media("clip").play();
  await until("currentTime to advance", () => video.time > 0.2 || !!video.error, 30_000);
  app.media("clip").pause();
  return !video.error || `error: ${video.error}`;
});
await check("videoSeek", async () => {
  if (!video.metadata) return "no metadata";
  const seeking = video.seeking, seeked = video.seeked;
  app.media("clip").seek(1.5);
  await until("seeked", () => video.seeked > seeked || !!video.error, 30_000);
  if (video.error) return `error: ${video.error}`;
  // Keyframes are 1 s apart: a sync-frame seek may land on 1.0.
  details.seekedAt = video.seekedAt;
  return video.seeking > seeking && video.seekedAt >= 0.9 && video.seekedAt <= 2.01 || `seeking ${video.seeking - seeking}, seeked at ${video.seekedAt}`;
});
await check("audio", async () => {
  await until("audio loadedmetadata", () => audio.metadata || !!audio.error, 30_000);
  if (audio.error) return `error: ${audio.error}`;
  return audio.duration !== null && Math.abs(audio.duration - 1) < 0.15 || `duration ${audio.duration}`;
});
await check("back", async () => {
  // scripts/android-ci-smoke.sh answers this line with `adb shell input keyevent 4` (again every few seconds until the app says so).
  console.log("tarve-ci-smoke-ready-back");
  await until("Back to reach onCloseRequest", () => closeRequests > 0, 90_000);
  console.log("tarve-ci-smoke-back-done");
  await sleep(300);
  return closeRequests > 0;
}, 120_000);
await check("permissions", async () => {
  // Not in the manifest and never asked: "prompt" (a later answer would read "denied").
  const states = await app.checkPermissions(["CAMERA"]);
  details.permissions = states;
  return states.CAMERA === "prompt" || states.CAMERA === "denied" || JSON.stringify(states);
});
await check("notify", () => {
  // The script grants POST_NOTIFICATIONS first, so no prompt covers the window.
  const answer = app.notify({ id: "ci-smoke", title: "Tarve CI smoke", body: "Posted by scripts/smoke-android-ci.tsx" });
  return answer.supported === true || JSON.stringify(answer);
});
await check("speech", async () => {
  // RECORD_AUDIO is not declared: the session must answer (denied, or the emulator's own code), not hang.
  const answer = await app.recognizeSpeech().result;
  details.speech = answer;
  return answer.supported === true && (typeof answer.code === "string" || typeof answer.text === "string") || JSON.stringify(answer);
}, 10_000);
details.audioDuration = audio.duration;
details.closeRequests = closeRequests;
console.log(`tarve-ci-smoke-details ${JSON.stringify(details)}`);
const ok = Object.entries(results).every(([key, value]) => key === "platform" ? value === "android" : value === true);
console.log(`tarve-ci-smoke ${JSON.stringify({ ok, ...results })}`);
app.close();
