// Frame rate meter and control. app.setMaxFps(n) sets the animation frame rate
// (null = the display's refresh rate); the meter reads the native frame counter
// from app.inspect() twice per second.
import { createApp } from "@tarve/core";
import { FpsView, state } from "./fps-view";

const app = createApp(() => <FpsView />, { maxFps: state.cap, renderer: "gpu" });
state.setCap = cap => {
  state.cap = cap;
  app.setMaxFps(cap);
  app.update();
};

await app.ready;
let last = { frames: (await app.inspect()).frames, at: performance.now() };
const timer = setInterval(async () => {
  const snapshot = await app.inspect().catch(() => undefined);
  if (!snapshot) return;
  const now = performance.now();
  // The meter's own update draws a frame; leave it out of the count.
  const frames = Math.max(0, snapshot.frames - last.frames - 1);
  state.fps = frames / ((now - last.at) / 1000);
  state.history = [...state.history.slice(-59), state.fps];
  app.update();
  last = { frames: (await app.inspect()).frames, at: performance.now() };
}, 500);
await app.closed;
clearInterval(timer);
