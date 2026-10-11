// Pulse (https://pulse.egoist.dev), a system monitor, rebuilt with Tarve: live
// CPU, memory, GPU, disk, network, battery, temperatures and power, plus every
// process with its program icon and its share of the power. The data comes
// from pulse-sampler.cs on Windows (no administrator rights needed); elsewhere
// only CPU and memory from node:os. The app ships its font (Inter, fontFaces)
// and draws the category icons with Phosphor.
//
// Figures follow Task Manager: CPU usage as time busy (Windows 11 24H2 and
// later; Settings switches to the older utility figure) and speed, memory in use, available, committed and cached, every GPU
// (busiest engine, per engine type, dedicated and shared memory), every disk
// (active time, speeds, response time) and every network adapter, in Windows'
// units (1024-based sizes, network in bits). The overview's memory breakdown
// keeps Pulse's words: wired is the non-paged pool, compressed the Memory
// Compression store. Load averages are Unix's: runnable threads damped over 1,
// 5 and 15 minutes. Energy by app is the measured CPU package (RAPL) and GPU
// power above idle, split by CPU and GPU time.
import os from "node:os";
import { createApp } from "@tarve/core";
import { phosphorReactAdapter } from "@tarve/react-icons";
import inter from "./assets/fonts/InterVariable.ttf" with { type: "file" };
import { onIconReady, watch } from "./pulse-source";
import { PulseView, state } from "./pulse-view";

state.host = { name: os.hostname(), model: os.cpus()[0]?.model.trim() ?? os.arch(), uptime: os.uptime() };
const app = createApp(() => <PulseView />, { fontFaces: [inter], componentAdapters: [phosphorReactAdapter] });
onIconReady(() => { state.tick++; app.update(); });
const stop = watch(sample => {
  state.host.uptime = os.uptime();
  state.push(sample);
  app.update();
});
await app.closed;
stop();
