import { describe, expect, test } from "bun:test";
import type { NativeCommand, NativeEvent, SceneDocument } from "./protocol";
import { createApp } from "./app";
import type { NativeBridge } from "./bridge";
import { Text, Window } from "./components";
import { onStoreChange, store, toRaw } from "./store";

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
    // Data the view never read (a session's lines, the tags) renders nothing.
    state.sessions.get("s1")!.lines.push("ls");
    await tick();
    expect(renders).toBe(base + 2);
    expect([...state.sessions.values()][0]!.lines).toEqual(["ls"]);
    state.tags.add("x");
    state.tags.add("x");
    await tick();
    expect(renders).toBe(base + 2);
    state.title = "b";
    state.tags.delete("missing");
    state.sessions.clear();
    await tick();
    expect(renders).toBe(base + 3);
    app.close();
  });

  test("only the windows whose renders read the changed data render again", async () => {
    const state = store({ main: 1, popup: 1, keys: {} as Record<string, number> });
    let mainRenders = 0, popupRenders = 0;
    let emit!: (event: NativeEvent & { window?: string }) => void;
    const bridge = new FakeBridge();
    bridge.start = (_document, onEvent) => { emit = onEvent; onEvent({ type: "ready" }); };
    const app = createApp(() => { mainRenders++; return <Window><Text>{`${state.main} ${Object.keys(state.keys).length}`}</Text></Window>; }, { bridge });
    await app.ready;
    const popup = app.openWindow(() => { popupRenders++; return <Window><Text>{String(state.popup)}</Text></Window>; }, { id: "popup" });
    emit({ type: "ready", window: "popup" });
    await popup.ready;
    await tick();
    const [main0, popup0] = [mainRenders, popupRenders];
    state.main = 2;
    await tick();
    expect([mainRenders - main0, popupRenders - popup0]).toEqual([1, 0]);
    state.popup = 2;
    await tick();
    expect([mainRenders - main0, popupRenders - popup0]).toEqual([1, 1]);
    // A key added changes Object.keys, which the main window read.
    state.keys.a = 1;
    await tick();
    expect([mainRenders - main0, popupRenders - popup0]).toEqual([2, 1]);
    state.keys.a = 2;
    await tick();
    expect([mainRenders - main0, popupRenders - popup0]).toEqual([2, 1]);
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

  test("writing the value already there notifies nobody", async () => {
    const tab = { name: "one" };
    const state = store({ count: 1, label: "a", missing: undefined as number | undefined, nan: NaN, tab, map: new Map([["k", 1]]) });
    let changes = 0;
    const stop = onStoreChange(() => { changes++; });
    state.count = 1;
    state.label = "a";
    state.missing = undefined;
    state.nan = NaN;
    state.tab = tab;
    state.tab = state.tab;
    state.map.set("k", 1);
    await tick();
    expect(changes).toBe(0);
    state.count = 2;
    await tick();
    expect(changes).toBe(1);
    stop();
  });

  test("shallow-equal arrays and plain objects notify nobody; any difference does", async () => {
    const item = { id: 1 };
    const state = store({ list: [1, 2] as number[], items: [item], options: { a: 1, b: "x" } as Record<string, unknown>, nested: { inner: { deep: 1 } } });
    let changes = 0;
    const stop = onStoreChange(() => { changes++; });
    state.list = [1, 2];
    state.items = [...state.items];
    state.options = { b: "x", a: 1 };
    await tick();
    expect(changes).toBe(0);
    // Deep equality is not checked: a new inner object is a change.
    state.nested = { inner: { deep: 1 } };
    await tick();
    expect(changes).toBe(1);
    for (const write of [
      () => { state.list = [1, 2, 3]; },
      () => { state.list = [2, 1, 3]; },
      () => { state.options = { a: 1 }; },
      () => { state.options = { a: 1, b: "x", c: undefined }; },
      () => { state.options = { a: 1, c: "x" }; },
      () => { state.items = [{ id: 1 }]; },
    ]) {
      const before = changes;
      write();
      await tick();
      expect(changes).toBe(before + 1);
    }
    stop();
  });

  test("a render that read a replaced shallow-equal array still hears its later changes", async () => {
    const state = store({ list: [1, 2] });
    let renders = 0;
    const app = createApp(() => { renders++; return <Window><Text>{state.list.join(",")}</Text></Window>; }, { bridge: new FakeBridge() });
    await app.ready;
    const base = renders;
    state.list = [1, 2];
    await tick();
    expect(renders).toBe(base);
    state.list.push(3);
    await tick();
    expect(renders).toBe(base + 1);
    app.close();
  });

  test("dev mode warns once about a store written on every render and keeps the event loop running", async () => {
    const state = store({ count: 0 });
    let looping = true;
    let renders = 0;
    const warnings: string[] = [];
    const warn = console.warn;
    console.warn = (...args: unknown[]) => { warnings.push(args.map(String).join(" ")); };
    try {
      const app = createApp(() => {
        renders++;
        const count = state.count;
        if (looping) queueMicrotask(() => { state.count = count + 1; });
        return <Window><Text>{String(count)}</Text></Window>;
      }, { bridge: new FakeBridge(), dev: true });
      await app.ready;
      state.count = 1;
      // A pure microtask chain would never let these timers fire.
      for (let index = 0; index < 5; index++) await tick();
      expect(renders).toBeGreaterThan(1000);
      expect(warnings).toHaveLength(1);
      expect(warnings[0]).toContain(".count on { count }");
      expect(warnings[0]).toContain("store.test.tsx");
      looping = false;
      await tick();
      await tick();
      const settled = renders;
      await tick();
      expect(renders).toBe(settled);
      app.close();
    } finally {
      console.warn = warn;
    }
  });

  test("without dev mode the guard stays off", async () => {
    const state = store({ count: 0 });
    let renders = 0;
    const warnings: unknown[] = [];
    const warn = console.warn;
    console.warn = (...args: unknown[]) => { warnings.push(args); };
    try {
      const app = createApp(() => {
        renders++;
        const count = state.count;
        if (count > 0 && count < 1200) queueMicrotask(() => { state.count = count + 1; });
        return <Window><Text>{String(count)}</Text></Window>;
      }, { bridge: new FakeBridge(), dev: false });
      await app.ready;
      state.count = 1;
      await tick();
      expect(state.count).toBe(1200);
      expect(renders).toBeGreaterThan(1000);
      expect(warnings).toHaveLength(0);
      app.close();
    } finally {
      console.warn = warn;
    }
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
