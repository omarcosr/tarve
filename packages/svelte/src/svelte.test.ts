import { afterEach, describe, expect, test } from "bun:test";
import type { NativeCommand, NativeEvent, NativeNode, SceneDocument } from "@tarve/core/protocol";
import type { NativeBridge } from "@tarve/core/bridge";
import { registerSvelte } from "./bun";

registerSvelte({ onWarning: () => {} });
const { mount, TEvent } = await import("./index");
const { documentInstance } = await import("./dom");
const { default: Counter } = await import("./fixtures/Counter.svelte");
const { default: Todos } = await import("./fixtures/Todos.svelte");
const { default: TodoApp } = await import("../../../examples/svelte/App.svelte");
const { default: Bench } = await import("../bench/Bench.svelte");
const { default: Forms } = await import("./fixtures/Forms.svelte");
const { default: Events } = await import("./fixtures/Events.svelte");
const { default: Themed } = await import("./fixtures/Themed.svelte");
const { default: Transitions } = await import("./fixtures/Transitions.svelte");
const { default: Extras } = await import("./fixtures/Extras.svelte");
const { default: Titled } = await import("./fixtures/Titled.svelte");
const { default: HeadTitle } = await import("./fixtures/HeadTitle.svelte");
const { default: ComponentBar } = await import("./fixtures/ComponentBar.svelte");
const { default: Plain } = await import("./fixtures/Plain.svelte");
const { default: Visible } = await import("./fixtures/Visible.svelte");
const { default: Rich } = await import("./fixtures/Rich.svelte");

class FakeBridge implements NativeBridge {
  commands: NativeCommand[] = [];
  document?: SceneDocument;
  private listener?: (event: NativeEvent) => void;
  start(document: SceneDocument, onEvent: (event: NativeEvent) => void): void {
    this.document = document;
    this.listener = onEvent;
    onEvent({ type: "ready" });
  }
  send(command: NativeCommand): void { this.commands.push(command); }
  join(): void {}
  emit(event: NativeEvent): void { this.listener?.(event); }
}

/** A bridge that answers synchronous requests (layout reads, the selection) like native. */
class SyncBridge extends FakeBridge {
  boxes: Record<string, { width: number; height: number; x: number; y: number; borderWidth: number; borderHeight: number }> = {};
  selection = { target: null as string | null, anchor: 0, focus: 0 };
  requestSync(command: NativeCommand & { requestId: string }): NativeEvent | undefined {
    this.send(command);
    if (command.type === "layout") return { type: "layout", requestId: command.requestId, boxes: Object.fromEntries(command.ids.flatMap(id => this.boxes[id] ? [[id, this.boxes[id]!]] : [])) };
    if (command.type === "selection") return { type: "selection", requestId: command.requestId, ...this.selection };
    return undefined;
  }
}

function find(node: NativeNode, predicate: (node: NativeNode) => boolean): NativeNode | undefined {
  if (predicate(node)) return node;
  for (const child of node.children) {
    const found = find(child, predicate);
    if (found) return found;
  }
  return undefined;
}

function textOf(node: NativeNode): string {
  return (node.text ?? "") + node.children.map(textOf).join("");
}

const settle = async () => { for (let index = 0; index < 6; index++) await Promise.resolve(); };

let cleanup: (() => Promise<void>) | undefined;
afterEach(async () => { await cleanup?.(); cleanup = undefined; });

function start<T extends Record<string, any>>(component: any, props?: Record<string, unknown>) {
  const bridge = new FakeBridge();
  const mounted = mount<Record<string, any>, T>(component, { bridge, props, window: { title: "Svelte", width: 400, height: 300 } });
  cleanup = mounted.unmount;
  return { bridge, mounted };
}

describe("@tarve/svelte", () => {
  test("renders a component into the native document", async () => {
    const { bridge, mounted } = start(Counter, { start: 0 });
    await mounted.app.ready;
    const root = bridge.document!.root;
    expect(textOf(find(root, node => node.id.endsWith("increment"))!)).toBe("Clicked 0");
    expect(textOf(find(root, node => node.id.endsWith("doubled"))!)).toBe("Doubled: 0");
    expect(bridge.document!.window.title).toBe("Count 0");
  });

  test("a click updates only the elements Svelte changed", async () => {
    const { bridge, mounted } = start(Counter, { start: 0 });
    await mounted.app.ready;
    const button = find(bridge.document!.root, node => node.id.endsWith("increment"))!;
    bridge.emit({ type: "click", id: button.id } as NativeEvent);
    await settle();
    const commands = bridge.commands.filter(command => command.type === "patch" || command.type === "mutate" || command.type === "update");
    expect(commands.length).toBe(1);
    const command = commands[0]!;
    expect(command.type).toBe("patch");
    const texts = (command as { nodes: NativeNode[] }).nodes.map(node => node.text);
    expect(texts).toContain("Clicked 1");
    expect(texts).toContain("Doubled: 2");
  });

  test("blocks create and remove native nodes", async () => {
    const { bridge, mounted } = start(Counter, { start: 1 });
    await mounted.app.ready;
    expect(find(bridge.document!.root, node => node.id.endsWith("many"))).toBeUndefined();
    const button = find(bridge.document!.root, node => node.id.endsWith("increment"))!;
    bridge.emit({ type: "click", id: button.id } as NativeEvent);
    await settle();
    const mutate = bridge.commands.find(command => command.type === "mutate") as Extract<NativeCommand, { type: "mutate" }>;
    expect(mutate.mutations.some(mutation => mutation.type === "create" && textOf(mutation.node) === "many")).toBe(true);
  });

  test("scoped CSS styles the elements it selects", async () => {
    const { bridge, mounted } = start(Counter);
    await mounted.app.ready;
    const button = find(bridge.document!.root, node => node.id.endsWith("increment"))!;
    expect(button.style.hover?.background).toBe("#eeeeee");
  });

  test("bind:value and keyed each", async () => {
    const { bridge, mounted } = start<{ rename(index: number, label: string): void; removeFirst(): void }>(Todos, { size: 3 });
    await mounted.app.ready;
    const input = find(bridge.document!.root, node => node.id.endsWith("draft") && node.kind === "input")!;
    bridge.emit({ type: "change", id: input.id, value: "milk" } as NativeEvent);
    await settle();
    expect(bridge.commands.some(command => command.type === "patch" && command.nodes.some(node => node.text === "milk"))).toBe(true);
    const add = find(bridge.document!.root, node => node.id.endsWith("add"))!;
    bridge.commands.length = 0;
    bridge.emit({ type: "click", id: add.id } as NativeEvent);
    await settle();
    const mutate = bridge.commands.find(command => command.type === "mutate") as Extract<NativeCommand, { type: "mutate" }>;
    const created = mutate.mutations.filter(mutation => mutation.type === "create");
    expect(created.some(mutation => mutation.node.id.endsWith("item-3"))).toBe(true);
    // Existing rows keep their native nodes: no remove, no re-create.
    expect(mutate.mutations.some(mutation => mutation.type === "remove")).toBe(false);
    expect(created.some(mutation => mutation.node.id.endsWith("item-0"))).toBe(false);
  });

  test("the window title follows <svelte:head><title>", async () => {
    const { bridge, mounted } = start(Counter, { start: 4 });
    await mounted.app.ready;
    expect(bridge.document!.window.title).toBe("Count 4");
  });

  test("changing one row of a large list patches only that row", async () => {
    const { bridge, mounted } = start<{ rename(index: number, label: string): void; removeFirst(): void }>(Todos, { size: 500 });
    await mounted.app.ready;
    bridge.commands.length = 0;
    mounted.component.rename(250, "renamed");
    await settle();
    expect(bridge.commands).toHaveLength(1);
    const patch = bridge.commands[0] as Extract<NativeCommand, { type: "patch" }>;
    expect(patch.type).toBe("patch");
    expect(patch.nodes.map(node => node.text)).toEqual(["renamed"]);

    bridge.commands.length = 0;
    mounted.component.removeFirst();
    await settle();
    const mutate = bridge.commands[0] as Extract<NativeCommand, { type: "mutate" }>;
    expect(mutate.type).toBe("mutate");
    const removed = mutate.mutations.filter(mutation => mutation.type === "remove").map(mutation => (mutation as { id: string }).id);
    expect(removed.some(id => id.endsWith("item-0"))).toBe(true);
    expect(mutate.mutations.some(mutation => mutation.type === "create")).toBe(false);
  });

  test("the todo example adds, filters and checks items", async () => {
    const { bridge, mounted } = start(TodoApp);
    await mounted.app.ready;
    const byId = (suffix: string) => find(bridge.document!.root, node => node.id.endsWith(suffix));
    const patched = () => bridge.commands.flatMap(command => command.type === "patch" ? command.nodes
      : command.type === "mutate" ? command.mutations.flatMap(mutation => mutation.type === "patch" || mutation.type === "create" ? [mutation.node] : []) : []);
    const footer = () => patched().filter(node => node.id.endsWith("footer")).at(-1)?.text;
    expect(textOf(byId("footer")!)).toBe("1 of 2 open");
    expect(bridge.document!.window.title).toBe("Svelte todos · 1 left");
    bridge.emit({ type: "change", id: byId("draft")!.id, value: "Ship it" } as NativeEvent);
    await settle();
    bridge.emit({ type: "submit", id: byId("draft")!.id, value: "Ship it" } as NativeEvent);
    await settle();
    expect(footer()).toBe("2 of 3 open");
    const created = bridge.commands.flatMap(command => command.type === "mutate" ? command.mutations : []).filter(mutation => mutation.type === "create");
    expect(created.some(mutation => mutation.type === "create" && mutation.node.text === "Ship it")).toBe(true);
    bridge.emit({ type: "click", id: byId("filter-done")!.id } as NativeEvent);
    await settle();
    const removes = bridge.commands.flatMap(command => command.type === "mutate" ? command.mutations : []).filter(mutation => mutation.type === "remove");
    expect(removes.length).toBeGreaterThan(0);
    expect(patched().some(node => node.id.endsWith("filter-done") && node.style.background === "#2563eb")).toBe(true);
  });

  test("moving keyed rows keeps their native nodes", async () => {
    const { bridge, mounted } = start<{ swap(): void; update(index: number): void }>(Bench, { size: 50 });
    await mounted.app.ready;
    bridge.commands.length = 0;
    mounted.component.swap();
    await settle();
    const mutations = bridge.commands.flatMap(command => command.type === "mutate" ? command.mutations : []);
    expect(mutations.length).toBeGreaterThan(0);
    expect(mutations.every(mutation => mutation.type === "children")).toBe(true);
    bridge.commands.length = 0;
    mounted.component.update(10);
    await settle();
    expect(bridge.commands).toHaveLength(1);
    expect((bridge.commands[0] as Extract<NativeCommand, { type: "patch" }>).nodes.map(node => node.text)).toEqual(["row 10!"]);
  });

  test("a row button toggles its own row", async () => {
    const { bridge, mounted } = start(Bench, { size: 5 });
    await mounted.app.ready;
    const buttons: NativeNode[] = [];
    const collect = (node: NativeNode) => { if (node.kind === "button") buttons.push(node); node.children.forEach(collect); };
    collect(bridge.document!.root);
    expect(buttons).toHaveLength(5);
    bridge.emit({ type: "click", id: buttons[3]!.id } as NativeEvent);
    await settle();
    const patch = bridge.commands.find(command => command.type === "patch") as Extract<NativeCommand, { type: "patch" }>;
    expect(patch.nodes.map(node => [node.id, node.text])).toEqual([[buttons[3]!.id, "Undo"]]);
  });

  test("select, checkbox group and radio group bindings", async () => {
    const { bridge, mounted } = start<{ setChoice(value: string): void }>(Forms);
    await mounted.app.ready;
    const node = (suffix: string) => find(bridge.document!.root, item => item.id.endsWith(suffix))!;
    const latest = (suffix: string) => {
      const patched = bridge.commands.flatMap(command => command.type === "patch" ? command.nodes : command.type === "mutate" ? command.mutations.flatMap(mutation => "node" in mutation ? [mutation.node] : []) : []);
      return patched.filter(item => item.id.endsWith(suffix)).at(-1)?.text ?? textOf(node(suffix));
    };
    expect(textOf(node("choice"))).toBe("b");
    expect(textOf(node("picked"))).toBe("two");
    mounted.component.setChoice("a");
    await settle();
    expect(latest("choice")).toBe("a");
    bridge.emit({ type: "click", id: node("choc").id } as NativeEvent);
    await settle();
    expect(latest("flavours")).toBe("mint,choc");
    // A native choice reaches Svelte as a change event on the select (object values too).
    const objects = mounted.target.querySelector("select#objects")!;
    expect(objects.selectedIndex).toBe(1);
    objects.selectedIndex = 0;
    objects.dispatchEvent(new TEvent("change", { bubbles: true }));
    await settle();
    expect(latest("picked")).toBe("one");
    expect(mounted.target.querySelectorAll("option:checked").map(option => option.text)).toEqual(["A", "one"]);
    const radio = find(bridge.document!.root, item => item.id.startsWith(node("size-s").id + "/") && item.control?.role === "radio")!;
    bridge.emit({ type: "click", id: radio.id } as NativeEvent);
    await settle();
    expect(latest("size")).toBe("s");
  });

  test("window keys, focus, element and window sizes, double clicks", async () => {
    const { bridge, mounted } = start<{ focusField(): void }>(Events);
    await mounted.app.ready;
    const patched = () => bridge.commands.flatMap(command => command.type === "patch" ? command.nodes : command.type === "mutate" ? command.mutations.flatMap(mutation => "node" in mutation ? [mutation.node] : []) : []);
    const latest = (suffix: string) => patched().filter(item => item.id.endsWith(suffix)).at(-1)?.text ?? textOf(find(bridge.document!.root, item => item.id.endsWith(suffix))!);
    expect(bridge.document!.keyboardEvents).toBe(true);
    expect(latest("inner")).toBe("400");
    const key = (key: string, id: string | null, extra: Partial<Record<"ctrlKey", boolean>> = {}) => bridge.emit({ type: "keyboard", phase: "down", id, key, code: key, repeat: false, ctrlKey: false, altKey: false, shiftKey: false, metaKey: false, ...extra });
    key("a", null);
    key("s", null, { ctrlKey: true });
    await settle();
    expect(latest("keys")).toBe("a Ctrl+s");
    // A key typed into the field: native names it as focused, so it gains focus first.
    const field = find(bridge.document!.root, item => item.id === "field")!;
    key("b", field.id);
    await settle();
    expect(latest("focused")).toBe("field");
    expect(latest("keys")).toBe("a Ctrl+s b");
    bridge.emit({ type: "blur", id: field.id });
    await settle();
    expect(latest("focused")).toBe("none");
    // Script focus moves native focus.
    bridge.commands.length = 0;
    mounted.component.focusField();
    await settle();
    expect(bridge.commands.some(command => command.type === "focus" && command.id === "field")).toBe(true);
    expect(latest("focused")).toBe("field");
    // bind:clientWidth asks native for the box's size.
    const box = find(bridge.document!.root, item => item.id === "box");
    const boxNode = box ?? patched().find(item => item.id === "box")!;
    expect(boxNode.reportSize).toBe(true);
    bridge.emit({ type: "size", id: "box", width: 321, height: 20 });
    await settle();
    expect(latest("width")).toBe("321");
    bridge.emit({ type: "size", id: bridge.document!.root.id, width: 640, height: 480 });
    await settle();
    expect(latest("inner")).toBe("640");
    bridge.emit({ type: "click", id: "clicker" });
    bridge.emit({ type: "click", id: "clicker" });
    await settle();
    expect(latest("clicks")).toBe("2/1");
  });

  test("ancestor and structural selectors restyle when the DOM around changes", async () => {
    const { bridge, mounted } = start<{ toggle(): void; prepend(): void }>(Themed);
    await mounted.app.ready;
    const patched = () => bridge.commands.flatMap(command => command.type === "patch" ? command.nodes : command.type === "mutate" ? command.mutations.flatMap(mutation => "node" in mutation ? [mutation.node] : []) : []);
    const current = (id: string) => patched().filter(node => node.id === id).at(-1) ?? find(bridge.document!.root, node => node.id === id)!;
    expect(current("label").style.foreground).toBe("#111111");
    expect(current("item-a").style.fontWeight).toBe(700);
    mounted.component.toggle();
    await settle();
    expect(current("label").style.foreground).toBe("#eeeeee");
    mounted.component.prepend();
    await settle();
    expect(current("item-z").style.fontWeight).toBe(700);
    expect(current("item-a").style.fontWeight).not.toBe(700);
  });

  test("transitions animate opacity and transforms, and outros remove on time", async () => {
    const { bridge, mounted } = start<{ toggle(): void }>(Transitions);
    await mounted.app.ready;
    const nodes = () => bridge.commands.flatMap(command => command.type === "patch" ? command.nodes : command.type === "mutate" ? command.mutations.flatMap(mutation => "node" in mutation ? [mutation.node] : []) : []);
    mounted.component.toggle();
    await new Promise(resolve => setTimeout(resolve, 60));
    const midway = nodes().filter(node => node.id === "faded").map(node => node.style.opacity).filter(value => value !== undefined) as number[];
    expect(midway.some(value => value > 0 && value < 1)).toBe(true);
    const flown = nodes().filter(node => node.id === "flown").map(node => node.style.transformMatrix?.[5]).filter(value => value !== undefined) as number[];
    expect(flown.some(value => value > 0 && value < 20)).toBe(true);
    await new Promise(resolve => setTimeout(resolve, 150));
    await settle();
    bridge.commands.length = 0;
    mounted.component.toggle();
    await new Promise(resolve => setTimeout(resolve, 50));
    const removedEarly = bridge.commands.some(command => command.type === "mutate" && command.mutations.some(mutation => mutation.type === "remove" && mutation.id === "faded"));
    expect(removedEarly).toBe(false);
    await new Promise(resolve => setTimeout(resolve, 150));
    await settle();
    expect(bridge.commands.some(command => command.type === "mutate" && command.mutations.some(mutation => mutation.type === "remove" && mutation.id === "faded"))).toBe(true);
  });

  test("positions, mouse buttons, wheel, :has, ::before/::after, @keyframes, contenteditable, audio, drag and drop", async () => {
    const { bridge, mounted } = start<{ measure(): void; play(): void }>(Extras);
    await mounted.app.ready;
    const all = () => [bridge.document!.root, ...bridge.commands.flatMap(command => command.type === "patch" ? command.nodes : command.type === "mutate" ? command.mutations.flatMap(mutation => "node" in mutation ? [mutation.node] : []) : command.type === "update" ? [command.root] : [])];
    const current = (id: string) => { let found: NativeNode | undefined; for (const root of all()) { const node = find(root, item => item.id === id); if (node) found = node; } return found!; };
    const text = (id: string) => textOf(current(id));
    // getBoundingClientRect: the first read asks native for reports, the next one has them.
    mounted.component.measure();
    await settle();
    expect(current("box").reportSize).toBe(true);
    bridge.emit({ type: "size", id: "box", width: 100, height: 20, x: 12, y: 34, borderWidth: 102, borderHeight: 22 });
    mounted.component.measure();
    await settle();
    expect(text("rect")).toBe("12,34,102,22");
    const pointer = (phase: "down" | "up" | "wheel", extra: object) => bridge.emit({ type: "pointer", phase, id: "box", x: 15, y: 40, ctrlKey: false, altKey: false, shiftKey: false, metaKey: false, ...extra } as NativeEvent);
    pointer("down", { button: 2 });
    pointer("up", { button: 2 });
    pointer("wheel", { deltaY: 120 });
    await settle();
    expect(text("downs")).toBe("down2 up2");
    expect(text("wheel")).toBe("120");
    // Structure: :has() on the list, generated content.
    const ul = mounted.target.querySelector("ul")!;
    expect(current("s" + ul._key).style.gap).toBe(9);
    expect(find(current("first"), node => node.style.width === 4 && node.style.height === 4)).toBeDefined();
    expect(text("tagged")).toContain("[New] ");
    // @keyframes animation runs on the spinner.
    await new Promise(resolve => setTimeout(resolve, 60));
    const opacities = all().flatMap(root => { const node = find(root, item => item.id === "spinner"); return node?.style.opacity !== undefined ? [node.style.opacity] : []; });
    expect(opacities.some(value => value > 0 && value < 1)).toBe(true);
    // contenteditable is a text area whose edits reach bind:textContent.
    expect(current("editor").kind).toBe("textarea");
    bridge.emit({ type: "change", id: "editor", value: "edited" });
    await settle();
    expect(text("text")).toBe("edited");
    // <audio>: play() goes to native; media events drive bind:paused/currentTime/duration.
    bridge.commands.length = 0;
    mounted.component.play();
    expect(bridge.commands.some(command => command.type === "media" && command.id === "player" && command.action === "play")).toBe(true);
    bridge.emit({ type: "media", id: "player", event: "loadedmetadata", duration: 180, time: 0, paused: true });
    bridge.emit({ type: "media", id: "player", event: "play", time: 0, paused: false, duration: 180 });
    bridge.emit({ type: "media", id: "player", event: "timeupdate", time: 42, paused: false, duration: 180 });
    await settle();
    expect(text("media")).toBe("playing 42 180");
    // HTML drag and drop between two elements.
    const dragNode = current("drag");
    expect(dragNode.draggable).toBe(true);
    expect(current("zone").dropTarget).toBe(true);
    bridge.emit({ type: "dragStart", id: "drag", x: 1, y: 1 });
    bridge.emit({ type: "dragMove", id: "drag", x: 5, y: 5, over: "zone" });
    bridge.emit({ type: "drop", id: "drag", target: "zone", x: 5, y: 5 });
    await settle();
    expect(text("dropped")).toBe("payload");
  });

  test("a reactive <title> retitles the window; <titlebar> replaces the native frame", async () => {
    const { bridge, mounted } = start<{ receive(): void }>(Titled);
    await mounted.app.ready;
    expect(bridge.document!.window.title).toBe("Inbox (0)");
    expect(bridge.document!.window.decorations).toBe(false);
    const bar = find(bridge.document!.root, node => node.id === "bar")!;
    expect(bar.kind).toBe("titlebar");
    expect(bar.dragRegion).toBe(true);
    expect(textOf(bar)).toContain("Inbox · 0");
    expect(find(bar, node => node.id === "custom-close")!.windowAction).toBe("close");
    expect(find(bridge.document!.root, node => node.id === "handle")!.dragRegion).toBe(true);
    mounted.component.receive();
    await settle();
    expect(bridge.commands.filter(command => command.type === "windowTitle")).toEqual([{ type: "windowTitle", title: "Inbox (1)" }]);
    expect(bridge.commands.some(command => command.type === "patch" && command.nodes.some(node => node.text === "Inbox · 1"))).toBe(true);

  });

  test("a <titlebar> without a title shows the <svelte:head> title", async () => {
    const { bridge, mounted } = start<{ bump(): void }>(HeadTitle);
    await mounted.app.ready;
    expect(textOf(find(bridge.document!.root, node => node.id === "plain-bar")!)).toContain("Count 0");
    mounted.component.bump();
    await settle();
    const shown = bridge.commands.flatMap(command => command.type === "patch" ? command.nodes : command.type === "mutate" ? command.mutations.flatMap(mutation => "node" in mutation ? [mutation.node] : []) : []).map(node => node.text);
    expect(shown).toContain("Count 1");
    expect(bridge.commands.some(command => command.type === "windowTitle" && command.title === "Count 1")).toBe(true);
  });

  test("the TitleBar component and the titleBar window option", async () => {
    {
      const { bridge, mounted } = start<{ read(): void }>(ComponentBar);
      await mounted.app.ready;
      expect(bridge.document!.window.decorations).toBe(false);
      const bar = find(bridge.document!.root, node => node.kind === "titlebar")!;
      expect(textOf(bar)).toContain("2 unread");
      expect(find(bar, node => node.control?.label === "Maximize or restore window")).toBeUndefined();
      expect(find(bar, node => node.control?.label === "Close window")).toBeDefined();
      await cleanup?.(); cleanup = undefined;
    }
    const bridge = new FakeBridge();
    const mounted = mount<Record<string, any>, { bump(): void }>(Plain as never, { bridge, window: { width: 400, height: 300, titleBar: true } });
    cleanup = mounted.unmount;
    await mounted.app.ready;
    expect(bridge.document!.window.decorations).toBe(false);
    expect(textOf(find(bridge.document!.root, node => node.kind === "titlebar")!)).toContain("Plain 0");
    mounted.component.bump();
    await settle();
    const shown = bridge.commands.flatMap(command => command.type === "patch" ? command.nodes : command.type === "mutate" ? command.mutations.flatMap(mutation => "node" in mutation ? [mutation.node] : []) : []).map(node => node.text);
    expect(shown).toContain("Plain 1");
    expect(bridge.commands.some(command => command.type === "windowTitle" && command.title === "Plain 1")).toBe(true);
  });

  test("titleBar with a <TitleBar> in the component renders one bar", async () => {
    const bridge = new FakeBridge();
    const mounted = mount<Record<string, any>, { read(): void }>(ComponentBar as never, { bridge, window: { titleBar: true } });
    cleanup = mounted.unmount;
    await mounted.app.ready;
    const bars: NativeNode[] = [];
    const collect = (node: NativeNode) => { if (node.kind === "titlebar") bars.push(node); node.children.forEach(collect); };
    collect(bridge.document!.root);
    expect(bars).toHaveLength(1);
    expect(textOf(bars[0]!)).toContain("2 unread");
  });
  test("IntersectionObserver follows native boxes, scroll offsets, clipping and thresholds", async () => {
    const { bridge, mounted } = start(Visible);
    await mounted.app.ready;
    await settle();
    const seen = () => mounted.target.querySelector("#seen")!.textContent ?? "";
    const pane = find(bridge.document!.root, node => node.id === "pane")!;
    expect(pane.kind).toBe("scroll");
    const size = (id: string, y: number, height: number) => bridge.emit({ type: "size", id, width: 200, height, x: 0, y, borderWidth: 200, borderHeight: height } as NativeEvent);
    // Nothing is reported before native lays the targets out.
    expect(seen()).toBe("");
    size("pane", 0, 100); size("a", 0, 80); size("b", 80, 80);
    await settle();
    // a fits in the pane; b shows its top quarter.
    expect(seen()).toBe("a:100 b:25");
    // Scrolling the pane by 60 px: a keeps its bottom quarter, b is fully inside.
    bridge.emit({ type: "scroll", id: "pane", offset: 60, max: 60 } as NativeEvent);
    await settle();
    expect(seen()).toBe("a:100 b:25 a:25 b:100");
    expect(mounted.target.querySelector("#b")!.getBoundingClientRect().y).toBe(20);
    // A small window clips through the viewport too.
    bridge.emit({ type: "scroll", id: "pane", offset: 0, max: 60 } as NativeEvent);
    await settle();
    expect(seen().split(" ").slice(-2)).toEqual(["a:100", "b:25"]);
  });
  test("layout reads are synchronous: onMount and right after a change", async () => {
    const bridge = new SyncBridge();
    bridge.boxes.measured = { width: 200, height: 20, x: 0, y: 0, borderWidth: 200, borderHeight: 20 };
    const mounted = mount<Record<string, any>, { grow(): number }>(Rich as any, { bridge, window: { title: "Svelte", width: 400, height: 300 } });
    cleanup = mounted.unmount;
    await mounted.app.ready;
    await settle();
    // onMount ran once the window existed: its read was answered, not 0.
    expect(mounted.target.querySelector("#width")!.textContent).toBe("200");
    // A read after a change renders it first, then asks native.
    bridge.boxes.measured = { ...bridge.boxes.measured, width: 190, borderWidth: 210 };
    bridge.commands = [];
    expect(mounted.component.grow()).toBe(210);
    const types = bridge.commands.map(command => command.type);
    expect(types.indexOf("layout")).toBeGreaterThan(types.findIndex(type => type === "patch" || type === "mutate"));
    // No change since: the next read costs nothing.
    bridge.commands = [];
    expect(mounted.target.querySelector("#measured")!.getBoundingClientRect().width).toBe(210);
    expect(bridge.commands.length).toBe(0);
  });

  test("contenteditable is rich text: styled runs, edits in place, selection and execCommand", async () => {
    const bridge = new SyncBridge();
    const mounted = mount<Record<string, any>, { format(command: string): boolean; active(command: string): boolean; selected(): string }>(Rich as any, { bridge, window: { title: "Svelte", width: 400, height: 300 } });
    cleanup = mounted.unmount;
    await mounted.app.ready;
    await settle();
    const all = () => [bridge.document!.root, ...bridge.commands.flatMap(command => command.type === "patch" ? command.nodes : command.type === "mutate" ? command.mutations.flatMap(mutation => "node" in mutation ? [mutation.node] : []) : command.type === "update" ? [command.root] : [])];
    const rich = () => { let found: NativeNode | undefined; for (const root of all()) { const node = find(root, item => item.id === "rich"); if (node) found = node; } return found!; };
    const html = () => mounted.target.querySelector("#html")!.textContent;
    expect(rich().kind).toBe("textarea");
    expect(rich().value).toBe("plain bold end");
    expect(rich().runs).toEqual([{ start: 6, end: 10, style: { fontWeight: 700 } }]);
    // Typing at the end of the bold word stays bold, in the DOM too.
    bridge.emit({ type: "change", id: "rich", value: "plain bolder end" });
    await settle();
    expect(html()).toBe("plain <b>bolder</b> end");
    expect(rich().runs).toEqual([{ start: 6, end: 12, style: { fontWeight: 700 } }]);
    // Enter inserts a line break; Backspace removes it.
    bridge.emit({ type: "change", id: "rich", value: "plain bolder\n end" });
    await settle();
    expect(html()).toBe("plain <b>bolder<br></b> end");
    bridge.emit({ type: "change", id: "rich", value: "plain bolder end" });
    await settle();
    expect(html()).toBe("plain <b>bolder</b> end");
    // Focus follows native focus into the editor, and its keys go to it.
    bridge.emit({ type: "keyboard", phase: "down", id: "rich", key: "x", code: "KeyX", repeat: false, ctrlKey: false, altKey: false, shiftKey: false, metaKey: false });
    expect(documentInstance.activeElement?.getAttribute("id")).toBe("rich");
    // The native selection drives Selection and execCommand.
    bridge.selection = { target: "rich", anchor: 0, focus: 5 };
    expect(mounted.component.selected()).toBe("plain");
    expect(mounted.component.active("bold")).toBe(false);
    expect(mounted.component.format("italic")).toBe(true);
    await settle();
    expect(html()).toBe("<i>plain</i> <b>bolder</b> end");
    expect(mounted.component.active("italic")).toBe(true);
    expect(rich().runs).toEqual([{ start: 0, end: 5, style: { fontStyle: "italic" } }, { start: 6, end: 12, style: { fontWeight: 700 } }]);
    // Toggling again removes it.
    mounted.component.format("italic");
    await settle();
    expect(html()).toBe("plain <b>bolder</b> end");
    // Bold over part of a bold word: that part is no longer bold.
    bridge.selection = { target: "rich", anchor: 6, focus: 9 };
    mounted.component.format("bold");
    await settle();
    expect(html()).toBe('plain <b><span style="font-weight: 400;">bol</span>der</b> end');
    expect(rich().runs).toEqual([{ start: 6, end: 9, style: { fontWeight: 400 } }, { start: 9, end: 12, style: { fontWeight: 700 } }]);
    // And back: the override goes away.
    mounted.component.format("bold");
    await settle();
    expect(html()).toBe("plain <b>bolder</b> end");
    expect(rich().runs).toEqual([{ start: 6, end: 12, style: { fontWeight: 700 } }]);
    expect(mounted.target.querySelector("#inputs")!.textContent).toBe("insertText insertLineBreak deleteContentBackward formatItalic formatItalic formatBold formatBold");
  });
});
