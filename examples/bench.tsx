// Benchmark app for `bun run bench:compare`. Compile it per version with
// `tarve build bench.tsx` from that checkout's examples/ directory; SCENE picks empty,
// fixed (2,000-row list) or components, R picks the renderer.
const t0 = performance.now();
import { Button, Column, Row, Scroll, Text, Window, createApp } from "@tarve/core";
import { App as ComponentsApp } from "./components-view";
import { lucideReactAdapter, phosphorReactAdapter, reactSvgAdapter } from "@tarve/react-icons";
const tImport = performance.now();
const scene = process.env.SCENE ?? "empty";
const renderer = (process.env.R ?? "auto") as never;
function Empty() { return <Window title="bench" width={800} height={600}><Text>hi</Text></Window>; }
function Fixed() {
  return <Window title="bench" width={1024} height={760}><Column padding={16} gap={12} flex={1}><Scroll id="list" flex={1}><Column>
    {Array.from({ length: 2000 }, (_, i) => <Row key={i} style={{ height: 36, shrink: 0 }} gap={12}><Text style={{ flex: 1 }}>Record {i}: native layout and text</Text><Button size="sm">Open</Button></Row>)}
  </Column></Scroll></Column></Window>;
}
const View = scene === "fixed" ? Fixed : scene === "components" ? ComponentsApp : Empty;
const app = createApp(View, { debug: true, renderer, componentAdapters: [reactSvgAdapter, lucideReactAdapter, phosphorReactAdapter] } as never) as any;
await app.ready;
let s = await app.inspect();
while (s.frames === 0) { await Bun.sleep(1); s = await app.inspect(); }
const tFrame = performance.now();
const r = Math.round;
const mb = (x: number) => r(x / 1048576);
const ps = async (cmd: string) => (await new Response(Bun.spawn(["powershell", "-NoProfile", "-Command", cmd], { stdout: "pipe", stderr: "ignore" }).stdout).text()).trim();
const cpu = () => { const u = process.cpuUsage(); return (u.user + u.system) / 1000; };
const out: Record<string, unknown> = { scene, renderer, importsMs: r(tImport - t0), firstFrameMs: r(tFrame) };
await Bun.sleep(3000);
out.privateMb = mb(Number(await ps(`(Get-Process -Id ${process.pid}).PrivateMemorySize64`)));
out.wsMb = mb(process.memoryUsage().rss);
let f0 = (await app.inspect()).frames, c0 = cpu(), w0 = performance.now();
await Bun.sleep(4000);
out.idleCpuPct = +((cpu() - c0) / (performance.now() - w0) * 100).toFixed(2);
out.idleFrames = (await app.inspect()).frames - f0;
const cx = s.width / 2, cy = s.height / 2;
f0 = (await app.inspect()).frames; c0 = cpu(); w0 = performance.now();
let peak = 0;
for (let i = 0; i < 240; i++) {
  app.debug({ type: "input", action: "wheel", delta: i % 80 < 40 ? 60 : -60 });
  app.debug({ type: "input", action: "move", x: cx + Math.sin(i / 7) * cx * 0.8, y: cy + Math.cos(i / 9) * cy * 0.6 });
  await Bun.sleep(16);
  if (i % 20 === 0) peak = Math.max(peak, process.memoryUsage().rss);
}
out.busyCpuPct = +((cpu() - c0) / (performance.now() - w0) * 100).toFixed(1);
out.busyFrames = (await app.inspect()).frames - f0;
out.wsPeakMb = mb(peak);
out.gpuDedicatedMb = Number(await ps(`[math]::Round(((Get-Counter '\\GPU Process Memory(pid_${process.pid}_*)\\Dedicated Usage' -ErrorAction SilentlyContinue).CounterSamples | Measure-Object CookedValue -Sum).Sum / 1MB)`)) || 0;
console.log(JSON.stringify(out));
app.close();
process.exit(0);
