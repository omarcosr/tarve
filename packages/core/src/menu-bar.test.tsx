import { describe, expect, test } from "bun:test";
import { Window, Text, TitleBar } from "./components";
import { createApp } from "./app";
import { accessKey, MenuBar } from "./menu-bar";
import { compileTree } from "./reconciler";
import type { NativeBridge } from "./bridge";
import type { NativeCommand, NativeEvent, SceneDocument } from "./protocol";

describe("MenuBar", () => {
  test("access keys", () => {
    expect(accessKey("&File")).toEqual({ text: "File", key: "F" });
    expect(accessKey("Save &As")).toEqual({ text: "Save As", key: "A" });
    expect(accessKey("R&&D")).toEqual({ text: "R&D" });
  });

  test("a closed bar is a navigation row of menu buttons in one roving group", () => {
    const tree = compileTree(<Window><MenuBar id="bar" items={[{ label: "&File", items: [{ id: "new", label: "New" }] }, { label: "Help", onSelect: () => {} }]} /></Window>);
    expect(tree.nodes.get("bar")?.control).toMatchObject({ role: "navigation", orientation: "horizontal" });
    expect(tree.nodes.get("bar-menu-0")?.control).toMatchObject({ role: "button", label: "File", expanded: false });
    expect(tree.nodes.get("bar-menu-1")?.control).toMatchObject({ role: "menuitem", label: "Help" });
    expect(tree.nodes.get("bar-menu-0")?.rovingGroup).toBe(tree.nodes.get("bar-menu-1")?.rovingGroup);
    expect(tree.nodes.has("bar-item-0-0")).toBe(false);
  });

  test("app.menuBar draws the bar after the TitleBar, opens menus and runs items", async () => {
    let onEvent!: (event: NativeEvent) => void;
    let document!: SceneDocument;
    const commands: NativeCommand[] = [];
    const bridge: NativeBridge = {
      start(initial, listener) { document = initial; onEvent = listener; listener({ type: "ready" }); },
      send(command) { commands.push(command); },
      join() {},
    };
    const View = () => <Window frameless><TitleBar title="App" /><Text>body</Text></Window>;
    // A component that returns the Window, as most apps render.
    const app = createApp(() => <View />, { bridge });
    await app.ready;
    const ran: string[] = [];
    const menus: string[] = [];
    app.onEvent(event => { if (event.type === "menu") menus.push(event.id); });
    app.menuBar([{ label: "&File", items: [{ id: "new", label: "&New", accelerator: "Ctrl+N", onSelect: () => ran.push("new") }, { type: "separator" }, { label: "Recent", items: [{ id: "a", label: "a.txt", onSelect: () => ran.push("a") }] }] }]);
    await Promise.resolve();
    const nodes = (): string[] => {
      const ids: string[] = [];
      const walk = (node: { id: string; children?: unknown[] }) => { ids.push(node.id); for (const child of node.children ?? []) walk(child as never); };
      walk(document.root as never);
      for (const command of commands) {
        if (command.type === "mutate") for (const mutation of command.mutations) if (mutation.type === "create") walk(mutation.node as never);
        if (command.type === "update") walk(command.root as never);
      }
      return ids;
    };
    const ids = nodes();
    expect(ids).toContain("tarve-menubar");
    onEvent({ type: "click", id: "tarve-menubar-menu-0" });
    await Promise.resolve();
    expect(nodes()).toContain("tarve-menubar-item-0-0");
    onEvent({ type: "click", id: "tarve-menubar-item-0-2" });
    await Promise.resolve();
    expect(nodes()).toContain("tarve-menubar-item-0-2-0");
    onEvent({ type: "click", id: "tarve-menubar-item-0-2-0" });
    onEvent({ type: "shortcut", shortcut: "Ctrl+N" });
    expect(ran).toEqual(["a", "new"]);
    expect(menus).toEqual(["a"]);
    app.close();
  });
});
