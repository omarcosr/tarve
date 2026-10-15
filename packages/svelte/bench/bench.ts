// Svelte vs Tarve JSX on the same list, against a fake bridge: JS cost per update
// (Svelte flush + view render + compile + diff), from the change to the command sent.
// bun packages/svelte/bench/bench.ts [rows]
import type { NativeCommand, NativeEvent, SceneDocument } from "@tarve/core/protocol";
import { createApp, memo, Window } from "@tarve/core";
import { jsx } from "@tarve/core/jsx-runtime";
import { registerSvelte } from "../src/bun";

registerSvelte({ onWarning: () => {} });
const { mount } = await import("../src/index");
const { flushSync } = await import("../src/svelte-client");
const { default: Bench } = await import("./Bench.svelte");

const size = Number(process.argv[2] ?? 1000);
const rounds = 60;

class Bridge {
  commands: NativeCommand[] = [];
  start(_document: SceneDocument, onEvent: (event: NativeEvent) => void) { onEvent({ type: "ready" }); }
  send(command: NativeCommand) { this.commands.push(command); }
  join() {}
}

const tick = async (bridge: Bridge) => {
  const before = bridge.commands.length;
  for (let index = 0; index < 20 && bridge.commands.length === before; index++) await Promise.resolve();
  await Promise.resolve();
};

async function measure(bridge: Bridge, step: (round: number) => void): Promise<number> {
  for (let round = 0; round < 5; round++) { step(round); await tick(bridge); }
  const times: number[] = [];
  for (let round = 0; round < rounds; round++) {
    const started = performance.now();
    step(round);
    await tick(bridge);
    times.push(performance.now() - started);
  }
  times.sort((a, b) => a - b);
  return times[Math.floor(times.length / 2)]!;
}

type Row = { id: number; label: string; done: boolean };
function jsxApp(memoized: boolean) {
  let rows: Row[] = Array.from({ length: size }, (_, index) => ({ id: index, label: `row ${index}`, done: false }));
  let next = size;
  const bridge = new Bridge();
  const plainRow = ({ row, toggle }: { row: Row; toggle: (id: number) => void }) => jsx("div", { style: { direction: "row", gap: 8, padding: 4 }, children: [
    jsx("span", { style: { width: 40 }, children: String(row.id) }),
    jsx("span", { children: row.label }),
    jsx("button", { onClick: () => toggle(row.id), children: row.done ? "Undo" : "Done" }),
  ] });
  const Row = memoized ? memo(plainRow) : plainRow;
  const toggle = (id: number) => { rows = rows.map(row => row.id === id ? { ...row, done: !row.done } : row); app.update(); };
  const app = createApp(() => Window({ title: "bench", children: jsx("div", { style: { gap: 2 }, children: rows.map(row => jsx(Row, { row, toggle }, row.id)) }) }), { bridge: bridge as never });
  return {
    app, bridge,
    update(index: number) { rows = rows.slice(); rows[index] = { ...rows[index]!, label: rows[index]!.label + "!" }; app.update(); },
    updateAll() { rows = rows.map(row => ({ ...row, label: row.label + "." })); app.update(); },
    append() { rows = [...rows, { id: next, label: `row ${next++}`, done: false }]; app.update(); },
    removeFirst() { rows = rows.slice(1); app.update(); },
    swap() { rows = rows.slice(); const a = rows[1]!; rows[1] = rows[rows.length - 2]!; rows[rows.length - 2] = a; app.update(); },
  };
}

type Api = { update(index: number): void; updateAll(): void; append(): void; removeFirst(): void; swap(): void };
const scenarios: [string, (api: Api, round: number) => void][] = [
  ["update 1 row", (api, round) => api.update((round * 37) % size)],
  ["update all rows", api => api.updateAll()],
  ["append 1 row", api => api.append()],
  ["remove first row", api => api.removeFirst()],
  ["swap 2 rows", api => api.swap()],
];

const results: Record<string, Record<string, string>> = {};
async function run(label: string, create: () => { app: { ready: Promise<void>; close(): void }; bridge: Bridge; api: Api; dispose(): Promise<void> }) {
  for (const [name, step] of scenarios) {
    const started = performance.now();
    const { app, bridge, api, dispose } = create();
    if (name === scenarios[0]![0]) (results["mount"] ??= {})[label] = (performance.now() - started).toFixed(3);
    await app.ready;
    const time = await measure(bridge, round => step(api, round));
    (results[name] ??= {})[label] = time.toFixed(3);
    await dispose();
  }
}

await run("svelte", () => {
  const bridge = new Bridge();
  const mounted = mount<Record<string, never>, Api>(Bench as never, { bridge: bridge as never, props: { size } as never });
  return { app: mounted.app, bridge, api: mounted.component, dispose: () => mounted.unmount() };
});
{
  // Svelte's own share: the flush that updates the DOM shim, before Tarve renders.
  for (const [name, step] of scenarios) {
    const bridge = new Bridge();
    const mounted = mount<Record<string, never>, Api>(Bench as never, { bridge: bridge as never, props: { size } as never });
    await mounted.app.ready;
    const times: number[] = [];
    for (let round = 0; round < rounds + 5; round++) {
      const started = performance.now();
      step(mounted.component, round);
      flushSync();
      if (round >= 5) times.push(performance.now() - started);
      await tick(bridge);
    }
    times.sort((a, b) => a - b);
    (results[name] ??= {})["svelte flush"] = times[Math.floor(times.length / 2)]!.toFixed(3);
    await mounted.unmount();
  }
}
await run("jsx memo", () => { const made = jsxApp(true); return { app: made.app, bridge: made.bridge, api: made, dispose: async () => made.app.close() }; });
await run("jsx", () => { const made = jsxApp(false); return { app: made.app, bridge: made.bridge, api: made, dispose: async () => made.app.close() }; });

console.log(`rows: ${size}, median ms per update (${rounds} rounds)`);
console.table(results);
