// <surface> (Windows, D3D11): a producer in this process (here D3D11 through bun:ffi, standing in
// for libmpv) presents into a composition swap chain the element shows, as a SwapChainPanel. Checks
// on the real screen that the picture shows under the UI drawn over it, through both hand-overs
// (ISwapChainPanelNative::SetSwapChain on the `ready` handle, and app.surface(id).attach), that
// detaching or removing it leaves no hole, and that resize is reported. The window comes to the front.
// bun scripts/smoke-surface.tsx
import { createApp, Window, View, type SurfaceEvent } from "@tarve/core";
import { strict as assert } from "node:assert";
import { spawnSync } from "node:child_process";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { CFunction, dlopen, ptr, read, type FFITypeOrString, type Pointer } from "bun:ffi";
import { readPng } from "./video-layers/png";

if (process.platform !== "win32") throw new Error("<surface> composes swap chains on Windows (D3D11).");
const work = join(import.meta.dirname, "..", "work", "smoke-surface");
mkdirSync(work, { recursive: true });

// ---- A minimal D3D11 producer: device, composition swap chain, clear, present. ----
const d3d11 = dlopen("d3d11.dll", { D3D11CreateDevice: { args: ["ptr", "u32", "ptr", "u32", "ptr", "u32", "u32", "ptr", "ptr", "ptr"], returns: "i32" } });
const dxgi = dlopen("dxgi.dll", { CreateDXGIFactory2: { args: ["u32", "ptr", "ptr"], returns: "i32" } });
const guid = (text: string) => {
  const hex = text.replace(/-/g, "");
  const bytes = new Uint8Array(16);
  const view = new DataView(bytes.buffer);
  view.setUint32(0, parseInt(hex.slice(0, 8), 16), true);
  view.setUint16(4, parseInt(hex.slice(8, 12), 16), true);
  view.setUint16(6, parseInt(hex.slice(12, 16), 16), true);
  for (let i = 0; i < 8; i++) bytes[8 + i] = parseInt(hex.slice(16 + i * 2, 18 + i * 2), 16);
  return bytes;
};
const ok = (hr: number, what: string) => { if (hr < 0) throw new Error(`${what}: HRESULT 0x${(hr >>> 0).toString(16)}`); };
const call = (object: number, index: number, args: FFITypeOrString[], returns: FFITypeOrString = "i32") =>
  CFunction({ ptr: read.ptr(read.ptr(object as unknown as Pointer, 0) as unknown as Pointer, index * 8) as unknown as Pointer, args: ["ptr", ...args], returns }) as unknown as (...values: unknown[]) => number;
const out = () => new BigUint64Array(1);
const value = (slot: BigUint64Array) => Number(slot[0]);

const deviceOut = out(), contextOut = out();
ok(d3d11.symbols.D3D11CreateDevice(null, 1 /* hardware */, null, 0x20 /* BGRA */, null, 0, 7, ptr(deviceOut), null, ptr(contextOut)), "D3D11CreateDevice");
const device = value(deviceOut), context = value(contextOut);
const factoryOut = out();
ok(dxgi.symbols.CreateDXGIFactory2(0, ptr(guid("50c83a1c-e072-4c48-87b0-3630fa36a6d0")), ptr(factoryOut)), "CreateDXGIFactory2");
const factory = value(factoryOut);

/** A composition swap chain of `width`×`height` showing `rgb`. */
function producerChain(width: number, height: number, rgb: [number, number, number]): number {
  // DXGI_SWAP_CHAIN_DESC1: B8G8R8A8, 1 sample, render target, 2 buffers, stretch, flip-sequential, alpha ignored.
  const desc = new Uint32Array([width, height, 87, 0, 1, 0, 0x20, 2, 0, 3, 3, 0]);
  const chainOut = out();
  ok(call(factory, 24, ["ptr", "ptr", "ptr", "ptr"])(factory, device, ptr(desc), null, ptr(chainOut)), "CreateSwapChainForComposition");
  const chain = value(chainOut);
  const backOut = out();
  ok(call(chain, 9, ["u32", "ptr", "ptr"])(chain, 0, ptr(guid("6f15aaf2-d208-4e89-9ab4-489535d34f9c")), ptr(backOut)), "GetBuffer");
  const back = value(backOut);
  const viewOut = out();
  ok(call(device, 9, ["ptr", "ptr", "ptr"])(device, back, null, ptr(viewOut)), "CreateRenderTargetView");
  const view = value(viewOut);
  call(context, 50, ["ptr", "ptr"], "void")(context, view, ptr(new Float32Array([rgb[0] / 255, rgb[1] / 255, rgb[2] / 255, 1])));
  ok(call(chain, 8, ["u32", "u32"])(chain, 0, 0), "Present");
  for (const object of [view, back]) call(object, 2, [], "u32")(object);
  return chain;
}

// ---- The app ----
let left = 40;
let showSurface = true;
const events: SurfaceEvent[] = [];
const errors: string[] = [];
const app = createApp(() => (
  <Window title="Surface smoke" width={520} height={380} style={{ background: "#ffffff" }}>
    <View style={{ margin: { left, top: 40 } }}>
      {showSurface ? (
        <surface id="player" style={{ position: "relative", width: 320, height: 240 }} onSurface={event => events.push(event)}>
          {/* Half-transparent black over the picture: the UI draws on top of the surface. */}
          <View id="badge" style={{ position: "absolute", left: 40, top: 40, width: 60, height: 40, background: "rgba(0, 0, 0, 0.5)" }} />
        </surface>
      ) : null}
    </View>
  </Window>
), { debug: true, onError: event => errors.push(event.error.message) });
let destroyed = false;
app.onEvent(event => {
  if (process.env.SMOKE_DEBUG && event.type !== "pointer" && event.type !== "frame") console.log(JSON.stringify(event).slice(0, 200));
  if (event.type === "surface" && event.event === "destroyed") destroyed = true;
});
await app.ready;

async function until(what: string, predicate: () => boolean, timeout = 8000) {
  const end = Date.now() + timeout;
  while (!predicate()) {
    if (errors.length) throw new Error(`${what}: ${errors.join(" | ")}`);
    if (Date.now() > end) throw new Error(`${what} timed out`);
    await new Promise(resolve => setTimeout(resolve, 50));
  }
}
const settle = () => new Promise(resolve => setTimeout(resolve, 600));

await until("surface ready", () => events.some(event => event.type === "ready"));
const ready = events.find(event => event.type === "ready")!;
assert.ok(ready.handle, "ready carries an ISwapChainPanelNative handle");
const scale = (await app.inspect()).scale;
assert.equal(ready.width, Math.round(320 * scale));
assert.equal(ready.height, Math.round(240 * scale));

function screen(name: string) {
  const path = join(work, `${name}.png`);
  const shot = spawnSync("powershell", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", join(import.meta.dirname, "video-layers", "screen.ps1"), "-ProcessId", String(process.pid), "-Out", path], { encoding: "utf8" });
  assert.equal(shot.status, 0, shot.stderr);
  const png = readPng(path);
  return (x: number, y: number) => png.pixel(Math.round((left + x) * scale), Math.round((40 + y) * scale));
}
const near = (actual: number[], expected: number[], tolerance = 45) => actual.every((v, i) => Math.abs(v - expected[i]!) <= tolerance);
function checkShows(name: string, rgb: [number, number, number]) {
  const at = screen(name);
  for (const [x, y] of [[160, 120], [300, 220], [10, 200]] as const) assert.ok(near(at(x, y), rgb), `${name}: ${x},${y} is ${at(x, y)}, expected ${rgb}`);
  const half = rgb.map(c => c / 2);
  assert.ok(near(at(70, 60), half), `${name}: the badge blends over the surface (${at(70, 60)}, expected ${half})`);
  assert.ok(near(at(-20, 120), [255, 255, 255]), `${name}: outside the box shows the window (${at(-20, 120)})`);
}
function checkEmpty(name: string) {
  const at = screen(name);
  for (const [x, y] of [[160, 120], [300, 220]] as const) assert.ok(near(at(x, y), [255, 255, 255]), `${name}: ${x},${y} shows the window (${at(x, y)})`);
}

// 1. A XAML-style producer: ISwapChainPanelNative::SetSwapChain on the handle.
const magenta = producerChain(ready.width, ready.height, [255, 0, 255]);
const panel = Number(ready.handle);
ok(call(panel, 3, ["ptr"])(panel, magenta), "SetSwapChain");
await settle();
checkShows("panel", [255, 0, 255]);

// 2. Taken away: the box shows the window again (no hole left).
ok(call(panel, 3, ["ptr"])(panel, null), "SetSwapChain(null)");
await settle();
checkEmpty("detached");

// 3. An exposed IDXGISwapChain* (libmpv's display-swapchain): the app attaches it.
const cyan = producerChain(ready.width, ready.height, [0, 255, 255]);
app.surface("player").attach(BigInt(cyan));
await settle();
checkShows("attached", [0, 255, 255]);

// 4. Layout moves the layer with the UI.
left = 140;
app.update();
await settle();
checkShows("moved", [0, 255, 255]);

// 5. Removed: `destroyed`, and no hole.
showSurface = false;
app.update();
// The element's handlers went with it: `destroyed` reaches app.onEvent listeners.
await until("surface destroyed", () => destroyed);
await settle();
checkEmpty("removed");

for (const chain of [magenta, cyan]) call(chain, 2, [], "u32")(chain);
app.close();
await app.closed;
console.log("[tarve smoke:surface] PASS");
process.exit(0);
