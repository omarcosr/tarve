// Frame rate meter and control. app.setMaxFps(n) sets the animation frame rate
// (null = the display's refresh rate); the meter shows the frames the window
// presented in the last second, which app.inspect() reports as `fps`.
import { createApp } from "@tarve/core";
import { FpsView, state } from "./fps-view";

const app = createApp(() => <FpsView />, { maxFps: state.cap, renderer: "gpu" });
state.setCap = cap => {
  state.cap = cap;
  app.setMaxFps(cap);
  app.update();
};

await app.ready;
const timer = setInterval(async () => {
  const snapshot = await app.inspect().catch(() => undefined);
  if (!snapshot) return;
  state.fps = snapshot.fps;
  state.history = [...state.history.slice(-59), state.fps];
  app.update();
}, 500);
await app.closed;
clearInterval(timer);
