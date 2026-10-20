// Prototype: a Tarve app on an embedded QuickJS (rquickjs) host, no Bun/Node/txiki.
import { createApp, Text, Window } from "@tarve/core";
import { lucideReactAdapter, phosphorReactAdapter, reactSvgAdapter } from "@tarve/react-icons";
import { App as ComponentsApp } from "../components/components-view";
declare const __tarveStart: (json: string) => void;
declare const __tarveSend: (json: string) => void;
declare const __scene: string;
declare const __busy: boolean;
function Empty() { return <Window title="bench" width={800} height={600}><Text>hi</Text></Window>; }
const View = __scene === "components" ? ComponentsApp : Empty;
const app = createApp(View, {
  renderer: "cpu",
  debug: __busy,
  componentAdapters: [reactSvgAdapter, lucideReactAdapter, phosphorReactAdapter],
  onError: event => console.error("[app]", event.error),
  bridge: {
    start(document, onEvent) {
      (globalThis as Record<string, unknown>).__tarveEvent = (json: string) => onEvent(JSON.parse(json));
      __tarveStart(JSON.stringify(document));
    },
    send(command) { __tarveSend(JSON.stringify(command)); },
    join() {},
  },
});
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
// The bench's busy phase: 240 wheel turns and pointer moves, 16 ms apart.
if (__busy) void (async () => {
  await app.ready;
  let s = await app.inspect();
  while (s.frames === 0) { await sleep(5); s = await app.inspect(); }
  await sleep(1000);
  const f0 = (await app.inspect()).frames;
  const cx = s.width / 2, cy = s.height / 2;
  const t0 = Date.now();
  for (let i = 0; i < 240; i++) {
    app.debug({ type: "input", action: "wheel", delta: i % 80 < 40 ? 60 : -60 });
    app.debug({ type: "input", action: "move", x: cx + Math.sin(i / 7) * cx * 0.8, y: cy + Math.cos(i / 9) * cy * 0.6 });
    await sleep(16);
  }
  const frames = (await app.inspect()).frames - f0;
  console.log("[busy]", JSON.stringify({ frames, seconds: (Date.now() - t0) / 1000 }));
})().catch(error => console.error("[busy] failed", error));
