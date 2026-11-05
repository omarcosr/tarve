// <surface> with a real libmpv, the way a player app embeds it, on the real screen:
// - Windows: mpv presents into its own composition swap chain (--d3d11-output-mode=composition),
//   the app attaches it (`display-swapchain`) and the UI — a custom TitleBar and a badge over the
//   picture — composes over it; mpv follows `resize` through --d3d11-composition-size.
// - Linux (X11 and Wayland), `TarveGL`: mpv's OpenGL render API (vo=libmpv) draws each picture into
//   GPU images the UI composes, badge on top; no copy through the CPU.
// - TARVE_SURFACE_GL=0, `TarveFrames`: mpv's software render API, pictures presented from memory.
// - Linux on X11 with SMOKE_SURFACE_NATIVE=1, `X11Window`: mpv draws into the child window (--wid).
// Then full screen (the TitleBar hidden, the surface fills the monitor) and back. On WSL, unset
// DISPLAY to run the window on Wayland.
// Needs libmpv (TARVE_LIBMPV; Windows default work/mpv/libmpv-2.dll, Linux libmpv.so.2) and ffmpeg.
// bun scripts/smoke-surface-mpv.tsx
import { createApp, TitleBar, Window, View, type SurfaceEvent } from "@tarve/core";
import { strict as assert } from "node:assert";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { dlopen, JSCallback, ptr, type Pointer } from "bun:ffi";
import { readPng } from "./video-layers/png";

const windows = process.platform === "win32";
/** Linux under WSLg (X11 windows shown through Windows). */
const wslg = !windows && !!process.env.WSL_DISTRO_NAME;
/** How the surface presents: Windows composition, X11 child window, or frames. */
const mode = windows ? "composition" : process.env.SMOKE_SURFACE_NATIVE ? "native" : process.env.TARVE_SURFACE_GL === "0" ? "frames" : "gl";
/** The screen shows the whole client area (title bar included), not only the surface's window. */
const wholeWindow = windows || wslg;
if (!windows && process.platform !== "linux") throw new Error("This smoke embeds mpv on Windows and Linux.");
const work = join(import.meta.dirname, "..", "work", "smoke-surface-mpv");
mkdirSync(work, { recursive: true });
const libmpvPath = process.env.TARVE_LIBMPV ?? (windows ? join(import.meta.dirname, "..", "work", "mpv", "libmpv-2.dll") : "libmpv.so.2");
if (windows && !existsSync(libmpvPath)) throw new Error(`libmpv not found at ${libmpvPath} (set TARVE_LIBMPV)`);
// Four coloured quadrants, 640×480: red, lime / blue, white.
const quad = join(work, "quad.mp4");
if (!existsSync(quad)) {
  const made = spawnSync("ffmpeg", ["-y", "-loglevel", "error",
    "-f", "lavfi", "-i", "color=c=red:s=320x240:d=60", "-f", "lavfi", "-i", "color=c=lime:s=320x240:d=60",
    "-f", "lavfi", "-i", "color=c=blue:s=320x240:d=60", "-f", "lavfi", "-i", "color=c=white:s=320x240:d=60",
    "-filter_complex", "[0][1][2][3]xstack=inputs=4:layout=0_0|w0_0|0_h0|w0_h0", "-c:v", "libx264", "-pix_fmt", "yuv420p", quad], { stdio: "inherit" });
  if (made.status !== 0) throw new Error("ffmpeg could not make the clip (is it on PATH?)");
}

const { symbols: mpv } = dlopen(libmpvPath, {
  mpv_create: { args: [], returns: "ptr" },
  mpv_set_option_string: { args: ["ptr", "cstring", "cstring"], returns: "i32" },
  mpv_set_property_string: { args: ["ptr", "cstring", "cstring"], returns: "i32" },
  mpv_initialize: { args: ["ptr"], returns: "i32" },
  mpv_command_string: { args: ["ptr", "cstring"], returns: "i32" },
  mpv_get_property: { args: ["ptr", "cstring", "i32", "ptr"], returns: "i32" },
  mpv_error_string: { args: ["i32"], returns: "cstring" },
  mpv_terminate_destroy: { args: ["ptr"], returns: "void" },
  mpv_render_context_create: { args: ["ptr", "ptr", "ptr"], returns: "i32" },
  mpv_render_context_set_update_callback: { args: ["ptr", "ptr", "ptr"], returns: "void" },
  mpv_render_context_update: { args: ["ptr"], returns: "u64" },
  mpv_render_context_render: { args: ["ptr", "ptr"], returns: "i32" },
  mpv_render_context_free: { args: ["ptr"], returns: "void" },
});
const c = (text: string) => Buffer.from(`${text}\0`);
const check = (code: number, what: string) => { if (code < 0) throw new Error(`${what}: ${mpv.mpv_error_string(code)}`); };
const player = mpv.mpv_create()!;
const platformOptions = mode === "composition"
  ? [["vo", "gpu-next"], ["gpu-context", "d3d11"], ["d3d11-output-mode", "composition"]]
  : mode === "frames" || mode === "gl" ? [["vo", "libmpv"]]
  // The app's window keeps the pointer and keys: mpv selects no input on its window.
  // WSLg's X server has no DRI3: mpv's GL output stays black even in its own top-level window
  // there, so the smoke uses mpv's X11 (XPutImage) output under WSL.
  : [["vo", process.env.SMOKE_MPV_VO ?? (wslg ? "x11" : "gpu")], ["gpu-context", process.env.SMOKE_MPV_CONTEXT ?? "x11egl"], ["input-cursor", "no"], ["input-vo-keyboard", "no"]];
for (const [name, value] of [...platformOptions, // WSL's GPUs are Mesa software ones, whose Vulkan video decode hands mpv black pictures now and then.
  ["hwdec", process.env.SMOKE_MPV_HWDEC ?? (wslg ? "no" : "auto-safe")], ["loop-file", "inf"], ["mute", "yes"], ["keepaspect", "yes"],
  ["background-color", "#000000"], ["osc", "no"], ["input-default-bindings", "no"],
  // WSL's OpenGL is llvmpipe, on which mpv's shader pipeline now and then draws only black (as
  // mpv's own vo=gpu window does there): its plain pipeline then.
  ...(wslg && mode === "gl" && process.env.SMOKE_MPV_DUMB !== "0" ? [["gpu-dumb-mode", "yes"]] : []),
  ...(process.env.SMOKE_MPV_LOG ? [["terminal", "yes"], ["msg-level", `all=${process.env.SMOKE_MPV_LOG}`], ["gpu-debug", "yes"]] : [])] as const) {
  check(mpv.mpv_set_option_string(player, c(name), c(value)), `option ${name}`);
}
/** Windows: the size mpv renders at, the surface's in device pixels. On X11 mpv follows its window. */
const setSize = (width: number, height: number) => {
  if (windows) check(mpv.mpv_set_property_string(player, c("d3d11-composition-size"), c(`${width}x${height}`)), "d3d11-composition-size");
};

let worker: Worker | undefined;
let fullscreen = false;
let badge: { left: number; top: number } | undefined;
const events: SurfaceEvent[] = [];
const errors: string[] = [];
const app = createApp(() => (
  <Window title="Surface mpv smoke" width={720} height={560} style={{ background: "#f4f4f5" }}>
    {/* The window's TitleBar stays for its life: full screen hides it (as a player does). */}
    <TitleBar title="mpv in a surface" style={fullscreen ? { display: "none" } : undefined} />
    <surface id="player" native={mode === "native"} style={{ flex: 1, position: "relative" }} onSurface={event => {
      events.push(event);
      if (event.type === "ready" || event.type === "resize") setSize(event.width, event.height);
      // A surface made again has a new handle: the render thread follows it.
      if (event.type === "ready" && event.handle) worker?.postMessage({ handle: event.handle });
    }}>
      {badge ? <View id="badge" style={{ position: "absolute", left: badge.left, top: badge.top, width: 24, height: 24, background: "rgba(0, 0, 0, 0.5)" }} /> : null}
    </surface>
  </Window>
), { debug: true, onError: event => errors.push(event.error.message) });
await app.ready;

async function until(what: string, predicate: () => boolean, timeout = 10000) {
  const end = Date.now() + timeout;
  while (!predicate()) {
    if (errors.length) throw new Error(`${what}: ${errors.join(" | ")}`);
    if (Date.now() > end) throw new Error(`${what} timed out`);
    await new Promise(resolve => setTimeout(resolve, 50));
  }
}
const settle = (ms = 800) => new Promise(resolve => setTimeout(resolve, ms));
const latest = () => events.filter(event => event.type === "ready" || event.type === "resize").at(-1)!;

await until("surface ready", () => events.some(event => event.type === "ready"));
const scale = latest().scale;
const ready = events.find(event => event.type === "ready")!;
assert.equal(ready.handleType, { composition: "ISwapChainPanelNative", native: "X11Window", frames: "TarveFrames", gl: "TarveGL" }[mode]);
// X11 child window: mpv draws into it.
if (mode === "native") check(mpv.mpv_set_option_string(player, c("wid"), c(ready.handle!)), "option wid");
check(mpv.mpv_initialize(player), "mpv_initialize");
// Frames: mpv's software renderer draws each picture at the surface's size; the app presents it.
const keep: unknown[] = [];
let presented = 0;
let freeRender = () => {};
const frameTimes: number[] = [];
if (mode === "gl") {
  // A render thread of its own, as a player runs one: neither mpv's rendering nor its pacing waits on this thread.
  const { nativePath } = await import("../packages/core/src/bridge/runtime");
  worker = new Worker(join(import.meta.dirname, "surface-mpv-gl-worker.ts"));
  worker.onmessage = (event: MessageEvent<{ presented?: number; times?: number[]; error?: string }>) => {
    if (event.data.error && !errors.includes(event.data.error)) errors.push(event.data.error);
    if (event.data.presented !== undefined) presented = event.data.presented;
    if (event.data.times) frameTimes.push(...event.data.times);
  };
  worker.onerror = event => { errors.push(`render thread: ${event.message}`); };
  const started = new Promise<void>(resolve => worker!.addEventListener("message", event => { if ((event as MessageEvent<{ started?: boolean }>).data.started) resolve(); }));
  worker.postMessage({ library: process.env.TARVE_NATIVE ?? nativePath(), libmpv: libmpvPath, player: Number(player), handle: ready.handle! });
  // vo=libmpv needs its render context before a file opens.
  await started;
}
if (mode === "frames") {
  /** `mpv_render_param` list: { int type; void *data } pairs, then a 0 terminator. */
  const params = (pairs: [number, number | bigint | null][]) => {
    const list = new BigUint64Array((pairs.length + 1) * 2);
    pairs.forEach(([type, data], i) => { list[i * 2] = BigInt(type); list[i * 2 + 1] = BigInt(data ?? 0); });
    keep.push(list);
    return list;
  };
  const cstr = (text: string) => { const buffer = c(text); keep.push(buffer); return ptr(buffer); };
  const out = new BigUint64Array(1);
  check(mpv.mpv_render_context_create(ptr(out), player, ptr(params([[1 /* API_TYPE */, cstr("sw")]]))), "mpv_render_context_create");
  const context = Number(out[0]) as Pointer;
  const size = new Int32Array(2);
  const stride = new BigUint64Array(1);
  const format = c("bgr0");
  let pixels = new Uint8Array(0);
  let scheduled = false;
  const render = () => {
    scheduled = false;
    if (!(Number(mpv.mpv_render_context_update(context)) & 1 /* UPDATE_FRAME */)) return;
    const started = performance.now();
    const { width, height } = latest();
    if (pixels.length !== width * height * 4) pixels = new Uint8Array(width * height * 4);
    size[0] = width; size[1] = height; stride[0] = BigInt(width * 4);
    // SW_SIZE, SW_FORMAT, SW_STRIDE, SW_POINTER.
    const list = new BigUint64Array([17n, BigInt(ptr(size)), 18n, BigInt(ptr(format)), 19n, BigInt(ptr(stride)), 20n, BigInt(ptr(pixels)), 0n, 0n]);
    check(mpv.mpv_render_context_render(context, ptr(list)), "mpv_render_context_render");
    if (app.surface("player").present(pixels, width, height, { format: "bgrx" })) presented++;
    frameTimes.push(performance.now() - started);
  };
  // mpv calls this from its own thread; the render runs on the JS thread.
  const update = new JSCallback(() => { if (!scheduled) { scheduled = true; setTimeout(render, 0); } }, { args: ["ptr"], returns: "void", threadsafe: true });
  keep.push(update);
  mpv.mpv_render_context_set_update_callback(context, update.ptr, null);
  freeRender = () => mpv.mpv_render_context_free(context);
}
check(mpv.mpv_command_string(player, c(`loadfile "${quad.replace(/\\/g, "/")}"`)), "loadfile");
if (windows) {
  const slot = new BigInt64Array(1);
  await until("mpv display-swapchain", () => mpv.mpv_get_property(player, c("display-swapchain"), 4 /* MPV_FORMAT_INT64 */, ptr(slot)) >= 0 && slot[0] !== 0n);
  app.surface("player").attach(slot[0]!);
}

/** Where each quadrant's centre is, in device pixels of the client area (the picture is contained). */
function quadrants(top: number) {
  const { width, height } = latest();
  const s = Math.min(width / 640, height / 480);
  const [vw, vh] = [640 * s, 480 * s];
  const [ox, oy] = [(width - vw) / 2, top + (height - vh) / 2];
  const at = (fx: number, fy: number) => [Math.round(ox + vw * fx), Math.round(oy + vh * fy)] as const;
  return { red: at(0.25, 0.25), lime: at(0.75, 0.25), blue: at(0.25, 0.75), white: at(0.75, 0.75), redEdge: at(0.1, 0.1), video: { ox, oy, vw, vh } };
}
// mpv converts BT.601 limited range with its own colour pipeline: lime arrives as ~(70, 249, 16).
const near = (actual: number[], expected: number[], tolerance = 80) => actual.every((v, i) => Math.abs(v - expected[i]!) <= tolerance);
/** Windows: the window's client area on screen. X11: the surface's window (what mpv drew). */
async function screen(name: string) {
  const path = join(work, `${name}.png`);
  if (wslg) {
    // WSLg shows X11 windows as Windows windows: the real screen, from the Windows side.
    const windowsPath = (path: string) => path.replace(/^\/mnt\/([a-z])\//, (_, drive: string) => `${drive.toUpperCase()}:\\`).replace(/\//g, "\\");
    const shot = spawnSync("/mnt/c/WINDOWS/System32/WindowsPowerShell/v1.0/powershell.exe", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File",
      windowsPath(join(import.meta.dirname, "video-layers", "screen.ps1")), "-Title", "Surface mpv smoke", "-Out", windowsPath(path)], { encoding: "utf8" });
    assert.equal(shot.status, 0, shot.stderr);
    // The Windows window has margins around the X11 one: its corner is where the title bar starts.
    const png = readPng(path);
    const bar = (x: number, y: number) => near(png.pixel(x, y), [244, 244, 245], 14);
    const middle = Math.floor(png.width / 2);
    let top = 0;
    while (top < png.height && !bar(middle, top)) top++;
    let left = middle;
    while (left > 0 && top < png.height && bar(left - 1, top + 2)) left--;
    // Full screen: no title bar and no margins.
    if (top >= png.height) [top, left] = [0, 0];
    return { width: png.width - left, height: png.height - top, pixel: (x: number, y: number) => png.pixel(x + left, y + top) };
  }
  if (mode === "frames" || mode === "gl") {
    // The composed frame (the video is part of the UI's own frame here).
    await app.capture(path);
    return readPng(path);
  }
  if (!windows) {
    // Native X11: what the surface's window holds (mpv's GL window inside it, same depth).
    const grab = spawnSync("ffmpeg", ["-y", "-loglevel", "error", "-f", "x11grab", "-window_id", ready.handle!, "-i", process.env.DISPLAY ?? ":0", "-frames:v", "1", "-update", "1", path], { encoding: "utf8" });
    assert.equal(grab.status, 0, grab.stderr);
    return readPng(path);
  }
  const shot = spawnSync("powershell", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", join(import.meta.dirname, "video-layers", "screen.ps1"), "-ProcessId", String(process.pid), "-Out", path], { encoding: "utf8" });
  assert.equal(shot.status, 0, shot.stderr);
  return readPng(path);
}
/** The four quadrants where they belong, once mpv has drawn at the current size (up to 10 s). */
async function checkVideo(name: string, top: number) {
  const end = Date.now() + 10000;
  for (;;) {
    const png = await screen(name);
    const q = quadrants(top);
    const wrong = ([["red", q.red, [255, 0, 0]], ["lime", q.lime, [0, 255, 0]], ["blue", q.blue, [0, 0, 255]], ["white", q.white, [255, 255, 255]]] as const)
      .filter(([, [x, y], rgb]) => !near(png.pixel(x, y), [...rgb]))
      .map(([what, [x, y]]) => `${what} quadrant at ${x},${y} is ${png.pixel(x, y)}`);
    if (!wrong.length) return { png, q };
    assert.ok(Date.now() < end, `${name}: ${wrong.join("; ")}${errors.length ? ` (errors: ${errors.join(" | ")})` : ""}`);
    await settle(300);
  }
}

// 1. Windowed, under the custom title bar.
await settle(1200);
const titlebar = 40 * scale;
const composedTop = wholeWindow || mode === "frames" || mode === "gl" ? titlebar : 0;
let { png, q } = await checkVideo("windowed", composedTop);
if (mode !== "native") {
  const barPixel = png.pixel(Math.round(200 * scale), Math.round(20 * scale));
  assert.ok(near(barPixel, [244, 244, 245], 30), `the title bar draws over nothing of the video (${barPixel})`);
  // The UI over the picture: a half-black badge over the red quadrant.
  badge = { left: q.redEdge[0] / scale, top: (q.redEdge[1] - titlebar) / scale };
  app.update();
  await settle();
  ({ png, q } = await checkVideo("badge", titlebar));
  const badgeAt = [Math.round(q.redEdge[0] + 12 * scale), Math.round(q.redEdge[1] + 12 * scale)] as const;
  assert.ok(near(png.pixel(...badgeAt), [128, 0, 0], 40), `the badge blends over the video (${png.pixel(...badgeAt)})`);
} else {
  // X11: the surface's window is the box under the title bar, at its size.
  if (!wslg) {
    assert.equal(png.width, latest().width, "the child window spans the surface");
    assert.equal(png.height, latest().height, "the child window spans the surface");
  }
  const ui = join(work, "ui.png");
  await app.capture(ui);
  const bar = readPng(ui).pixel(Math.round(200 * scale), Math.round(20 * scale));
  assert.ok(near(bar, [244, 244, 245], 30), `the title bar is drawn (${bar})`);
}
const windowed = { ...latest() };
// Cost of steady playback: the process's CPU time and the UI's frame time over 4 s.
const cpuBefore = process.cpuUsage();
const shownBefore = presented;
await app.stats({ reset: true });
await settle(4000);
const cpu = process.cpuUsage(cpuBefore);
const cpuPercent = (cpu.user + cpu.system) / 1000 / 4000 * 100;
const uiFrame = (await app.stats()).native?.phases?.frame ?? { p50: 0, p95: 0 };
const steadyFps = (presented - shownBefore) / 4;

// 2. Full screen: no title bar, the surface fills the monitor and mpv renders at its size.
fullscreen = true;
badge = undefined;
app.setFullscreen(true);
app.update();
await until("full-screen resize", () => latest().width > windowed.width && latest().height > windowed.height);
await settle(1200);
({ png } = await checkVideo("fullscreen", 0));
if (!wslg) assert.equal(png.width, latest().width, "the surface spans the full-screen client width");

// 3. Back to the window.
fullscreen = false;
app.setFullscreen(false);
app.update();
await until("windowed resize", () => latest().width === windowed.width && latest().height === windowed.height);
await settle(1200);
await checkVideo("restored", composedTop);

if (windows) app.surface("player").detach();
if (worker) {
  await new Promise<void>(resolve => {
    worker!.onmessage = (event: MessageEvent<{ presented: number; freed?: boolean }>) => { presented = event.data.presented; if (event.data.freed) resolve(); };
    worker!.postMessage("stop");
  });
  worker.terminate();
}
if (mode === "frames" || mode === "gl") {
  assert.ok(presented > 20, `mpv's pictures reached the surface (${presented})`);
  freeRender();
}
mpv.mpv_terminate_destroy(player);
app.close();
await app.closed;
console.log(`[tarve smoke:surface-mpv] ${mode} PASS (cpu ${cpuPercent.toFixed(0)}% of a core, UI frame p50 ${uiFrame.p50.toFixed(2)} ms p95 ${uiFrame.p95.toFixed(2)} ms, ${steadyFps.toFixed(1)} pictures/s, ${presented ? `${presented} pictures, producer ${(frameTimes.sort((a, b) => a - b)[Math.floor(frameTimes.length / 2)] ?? 0).toFixed(2)} ms p50, ` : ""}windowed ${windowed.width}x${windowed.height}, full screen ${events.filter(e => e.type === "resize").map(e => `${e.width}x${e.height}`).join(" → ")})`);
process.exit(0);
