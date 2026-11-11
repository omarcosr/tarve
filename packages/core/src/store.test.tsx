import { describe, expect, test } from "bun:test";
import type { NativeCommand, NativeEvent, SceneDocument } from "./protocol";
import { createApp } from "./app";
import type { NativeBridge } from "./bridge";
import { Text, Window } from "./components";
import { store, toRaw } from "./store";

class FakeBridge implements NativeBridge {
  commands: NativeCommand[] = [];
  start(_document: SceneDocument, onEvent: (event: NativeEvent) => void): void { onEvent({ type: "ready" }); }
  send(command: NativeCommand): void { this.commands.push(command); }
  join(): void {}
}
const tick = () => new Promise(resolve => setTimeout(resolve, 0));

describe("store()", () => {
  test("changes to nested objects, arrays, Maps and Sets render the app again, once per task", async () => {
    const state = store({ title: "a", tabs: [{ name: "one" }], sessions: new Map<string, { lines: string[] }>(), tags: new Set<string>() });
    let renders = 0;
    const app = createApp(() => { renders++; return <Window><Text>{`${state.title} ${state.tabs.map(tab => tab.name).join(",")} ${state.sessions.size}`}</Text></Window>; }, { bridge: new FakeBridge() });
    await app.ready;
    const base = renders;
    state.title = "b";
    state.tabs.push({ name: "two" });
    state.tabs[0]!.name = "uno";
    await tick();
    expect(renders).toBe(base + 1);
    state.sessions.set("s1", { lines: [] });
    await tick();
    expect(renders).toBe(base + 2);
    state.sessions.get("s1")!.lines.push("ls");
    await tick();
    expect(renders).toBe(base + 3);
    expect([...state.sessions.values()][0]!.lines).toEqual(["ls"]);
    state.tags.add("x");
    state.tags.add("x");
    await tick();
    expect(renders).toBe(base + 4);
    state.title = "b";
    state.tags.delete("missing");
    state.sessions.clear();
    await tick();
    expect(renders).toBe(base + 5);
    app.close();
  });

  test("the data underneath stays plain and identity holds", () => {
    const data = { list: [1, 2], nested: { value: 1 } };
    const state = store(data);
    expect(toRaw(state)).toBe(data);
    expect(state.nested).toBe(state.nested);
    state.nested = store({ value: 2 });
    expect(Object.getPrototypeOf(toRaw(data.nested))).toBe(Object.prototype);
    expect(data.nested).toEqual({ value: 2 });
    expect(toRaw(data.nested)).toBe(data.nested);
    expect(JSON.stringify(state)).toBe(JSON.stringify(data));
    expect(() => store(new Date() as never)).toThrow(TypeError);
  });

  test("indexOf, lastIndexOf and includes find an element by its plain object or its tracking view", () => {
    const tab = { name: "one" };
    const other = { name: "two" };
    const ui = store({ tabs: [] as { name: string }[] });
    ui.tabs.push(tab, other, tab);
    expect(ui.tabs.indexOf(tab)).toBe(0);
    expect(ui.tabs.lastIndexOf(tab)).toBe(2);
    expect(ui.tabs.includes(other)).toBe(true);
    expect(ui.tabs.indexOf(ui.tabs[1]!)).toBe(1);
    expect(ui.tabs.includes({ name: "one" })).toBe(false);
    expect(ui.tabs.find(item => toRaw(item) === tab)).toBe(ui.tabs[0]);
  });
});

// QuickJS (txiki.js, Android) checks proxy invariants Bun's engine does not: the same operations there.
const tjs = Bun.which("tjs");
describe.skipIf(!tjs)("store() on QuickJS (txiki.js)", () => {
  test("push, splice, sparse index, length, Map and Set work and report changes", async () => {
    const dir = await import("node:fs").then(fs => fs.mkdtempSync(require("node:path").join(require("node:os").tmpdir(), "tarve-store-qjs-")));
    const entry = require("node:path").join(dir, "entry.ts");
    await Bun.write(entry, `import { store, onStoreChange } from ${JSON.stringify(require("node:path").join(import.meta.dir, "store.ts"))};
let changes = 0;
onStoreChange(() => { changes++; });
const ui = store({ tabs: [] as { name: string }[], map: new Map<string, number[]>(), tags: new Set<string>() });
const tab = { name: "a" };
ui.tabs.push(tab, { name: "b" }, { name: "c" });
ui.tabs.splice(1, 1);
ui.tabs[5] = { name: "f" };
ui.tabs.length = 2;
ui.tabs[0]!.name = "A";
ui.map.set("k", []);
ui.map.get("k")!.push(1);
ui.tags.add("x");
await Promise.resolve();
console.log(JSON.stringify({ names: ui.tabs.map(item => item.name), index: ui.tabs.indexOf(tab), map: [...ui.map.get("k")!], tags: [...ui.tags], changes }));`);
    const built = await Bun.build({ entrypoints: [entry], outdir: dir, target: "browser", format: "esm" });
    expect(built.success).toBe(true);
    const run = Bun.spawnSync([tjs!, "run", built.outputs[0]!.path]);
    expect(run.stderr.toString()).toBe("");
    expect(JSON.parse(run.stdout.toString())).toEqual({ names: ["A", "c"], index: 0, map: [1], tags: ["x"], changes: 1 });
  });
});
