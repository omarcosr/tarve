import { describe, expect, test } from "bun:test";
import type { NativeCommand, NativeEvent, SceneDocument } from "./protocol";
import { createApp, type AppErrorEvent } from "./app";
import type { NativeBridge } from "./bridge";
import { Slider } from "./controls";
import { Button, Column, Diff, Image, Input, ScrollArea, Text, Window, TextArea } from "./components";
import { InputOTP } from "./form-controls";
import { TitleBar } from "./components/titlebar";
import { Svg } from "./components/svg";
import { VirtualList } from "./virtual-list";
import type { ComponentAdapter } from "./component-adapter";
import type { VNode } from "./jsx-runtime";
import { AnimatePresence } from "./motion";

class FakeBridge implements NativeBridge {
  commands: NativeCommand[] = [];
  starts = 0;
  joins = 0;
  document?: SceneDocument;
  startError?: Error;
  joinError?: Error;
  failNextSend?: Error;
  private listener?: (event: NativeEvent) => void;
  start(document: SceneDocument, onEvent: (event: NativeEvent) => void): void {
    this.starts++;
    if (this.startError) throw this.startError;
    this.document = document;
    this.listener = onEvent;
    onEvent({ type: "ready" });
  }
  send(command: NativeCommand): void {
    if (this.failNextSend) {
      const error = this.failNextSend;
      this.failNextSend = undefined;
      throw error;
    }
    this.commands.push(command);
  }
  join(): void {
    this.joins++;
    if (this.joinError) throw this.joinError;
  }
  emit(event: NativeEvent): void { this.listener?.(event); }
}

describe("controlled native reconciliation", () => {
  test("a Window level change reaches the running window", async () => {
    const bridge = new FakeBridge();
    let behind = true;
    const app = createApp(() => <Window level={behind ? "alwaysOnBottom" : "normal"}><Text>x</Text></Window>, { bridge });
    await app.ready;
    expect(bridge.document?.window.level).toBe("alwaysOnBottom");
    behind = false;
    app.update();
    await Promise.resolve();
    app.update();
    await Promise.resolve();
    expect(bridge.commands.filter(command => command.type === "windowLevel")).toEqual([{ type: "windowLevel", level: "normal" }]);
    app.close();
  });

  test("a Window title change reaches the running window", async () => {
    const bridge = new FakeBridge();
    let title = "First";
    const app = createApp(() => <Window title={title}><Text>x</Text></Window>, { bridge });
    await app.ready;
    expect(bridge.document?.window.title).toBe("First");
    title = "Second";
    app.update();
    await Promise.resolve();
    app.update();
    await Promise.resolve();
    expect(bridge.commands.filter(command => command.type === "windowTitle")).toEqual([{ type: "windowTitle", title: "Second" }]);
    app.close();
  });

  test("native motion completion reaches the node handler", async () => {
    const bridge = new FakeBridge();
    const completed: string[] = [];
    const app = createApp(() => (
      <Window>
        <Column id="motion-panel" onTransitionEnd={({ property }) => completed.push(property)} />
      </Window>
    ), { bridge });
    await app.ready;
    bridge.emit({ type: "motionComplete", id: "motion-panel", property: "opacity" });
    expect(completed).toEqual(["opacity"]);
    app.close();
  });

  test("AnimatePresence removes an exiting native node only after motion completion", async () => {
    const bridge = new FakeBridge();
    let present = true;
    const app = createApp(() => (
      <Window>
        <AnimatePresence
          id="presence"
          present={present}
          exit={{ opacity: 0 }}
          transition={{ opacity: { duration: 120, easing: "easeOut" } }}
        >
          <Column id="panel" style={{ opacity: 1, width: 100, height: 40 }} />
        </AnimatePresence>
      </Window>
    ), { bridge });
    await app.ready;
    bridge.commands.length = 0;

    present = false;
    app.update();
    await Bun.sleep(0);
    const exiting = bridge.commands.at(-1);
    expect(exiting?.type).toBe("patch");
    if (exiting?.type !== "patch") throw new Error("expected exit patch");
    expect(exiting.nodes.find(node => node.id === "panel")?.style.opacity).toBe(0);

    bridge.emit({ type: "motionComplete", id: "panel", property: "opacity" });
    await Bun.sleep(0);
    const removed = bridge.commands.at(-1);
    expect(removed?.type).toBe("mutate");
    if (removed?.type !== "mutate") throw new Error("expected presence removal mutation");
    expect(removed.mutations).toContainEqual({ type: "remove", id: "panel" });
    app.close();
  });

  test("AnimatePresence waits for every animated exit property", async () => {
    const bridge = new FakeBridge();
    let present = true;
    const app = createApp(() => (
      <Window>
        <AnimatePresence
          id="presence-multiple"
          present={present}
          exit={{ opacity: 0, width: 40 }}
          transition={{
            opacity: { duration: 120, easing: "linear" },
            width: { duration: 120, easing: "linear" },
          }}
        >
          <Column id="multi-panel" style={{ opacity: 1, width: 100, height: 40 }} />
        </AnimatePresence>
      </Window>
    ), { bridge });
    await app.ready;
    bridge.commands.length = 0;

    present = false;
    app.update();
    await Bun.sleep(0);
    expect(bridge.commands.at(-1)?.type).toBe("patch");
    const beforeCompletion = bridge.commands.length;

    bridge.emit({ type: "motionComplete", id: "multi-panel", property: "opacity" });
    await Bun.sleep(0);
    expect(bridge.commands.length).toBe(beforeCompletion);

    bridge.emit({ type: "motionComplete", id: "multi-panel", property: "width" });
    await Bun.sleep(0);
    const removed = bridge.commands.at(-1);
    expect(removed?.type).toBe("mutate");
    if (removed?.type !== "mutate") throw new Error("expected presence removal mutation");
    expect(removed.mutations).toContainEqual({ type: "remove", id: "multi-panel" });
    app.close();
  });

  test("AnimatePresence removes immediately when the exit transition has zero duration", async () => {
    const bridge = new FakeBridge();
    let present = true;
    const app = createApp(() => (
      <Window>
        <AnimatePresence
          id="presence-immediate"
          present={present}
          exit={{ opacity: 0 }}
          transition={{ opacity: { duration: 0 } }}
        >
          <Column id="immediate-panel" style={{ opacity: 1, width: 100, height: 40 }} />
        </AnimatePresence>
      </Window>
    ), { bridge });
    await app.ready;
    bridge.commands.length = 0;

    present = false;
    app.update();
    await Bun.sleep(0);
    const removed = bridge.commands.at(-1);
    expect(removed?.type).toBe("mutate");
    if (removed?.type !== "mutate") throw new Error("expected immediate presence removal mutation");
    expect(removed.mutations).toContainEqual({ type: "remove", id: "immediate-panel" });
    app.close();
  });

  test("an image failure is the app's error only when the image has no onError", async () => {
    const bridge = new FakeBridge();
    const errors: AppErrorEvent[] = [];
    const heard: string[] = [];
    const app = createApp(() => (
      <Window>
        <Image id="handled" src="https://example.com/a.png" fallbackSrc="b.png" width={10} height={10} onError={event => heard.push(event.message)} />
        <Image id="bare" src="https://example.com/c.png" width={10} height={10} />
      </Window>
    ), { bridge, onError: event => errors.push(event) });
    await app.ready;
    bridge.emit({ type: "imageError", id: "handled", src: "https://example.com/a.png", message: "http status: 404" });
    await Bun.sleep(0);
    expect(heard).toEqual(["http status: 404"]);
    expect(errors).toEqual([]);
    bridge.emit({ type: "imageError", id: "bare", src: "https://example.com/c.png", message: "http status: 404" });
    await Bun.sleep(0);
    expect(errors.map(event => [event.source, event.event, event.targetId, event.error.message])).toEqual([["native", "imageError", "bare", "Image 'https://example.com/c.png': http status: 404"]]);
    app.close();
  });

  test("AnimatePresence still removes an exited node when the user transition handler throws", async () => {
    const bridge = new FakeBridge();
    const errors: AppErrorEvent[] = [];
    let present = true;
    const app = createApp(() => (
      <Window>
        <AnimatePresence
          id="presence-throwing-handler"
          present={present}
          exit={{ opacity: 0 }}
          transition={{ opacity: { duration: 100, easing: "linear" } }}
        >
          <Column
            id="throwing-panel"
            style={{ opacity: 1, width: 100, height: 40 }}
            onTransitionEnd={() => { throw new Error("transition callback failed"); }}
          />
        </AnimatePresence>
      </Window>
    ), { bridge, onError: event => errors.push(event) });
    await app.ready;
    bridge.commands.length = 0;

    present = false;
    app.update();
    await Bun.sleep(0);
    bridge.emit({ type: "motionComplete", id: "throwing-panel", property: "opacity" });
    await Bun.sleep(0);

    expect(errors.at(-1)?.source).toBe("event-handler");
    expect(errors.at(-1)?.event).toBe("motionComplete");
    const removed = bridge.commands.at(-1);
    expect(removed?.type).toBe("mutate");
    if (removed?.type !== "mutate") throw new Error("expected presence removal after callback failure");
    expect(removed.mutations).toContainEqual({ type: "remove", id: "throwing-panel" });
    app.close();
  });

  test("Diff callbacks receive the file associated with each row", async () => {
    const bridge = new FakeBridge();
    const shown: Array<[number, string | undefined]> = [];
    const lines: Array<{ text: string; path?: string; oldLine?: number; newLine?: number }> = [];
    const app = createApp(() => Window({ children: Diff({
      id: "patch", source: "--- a/a.rs\n+++ b/a.rs\n@@ -1 +1 @@\n-old\n+new\n",
      onShowMore: (hidden, path) => shown.push([hidden, path]),
      onLineClick: event => lines.push(event),
    }) }), { bridge });
    await app.ready;
    bridge.emit({ type: "diffShowMore", id: "patch", hidden: 5, path: "a.rs" });
    bridge.emit({ type: "diffLineClick", id: "patch", text: "+new", path: "a.rs", newLine: 1 });
    expect(shown).toEqual([[5, "a.rs"]]);
    expect(lines).toEqual([{ text: "+new", path: "a.rs", oldLine: undefined, newLine: 1 }]);
    app.close();
  });
  test("native highlight counts reach the declaring container", async () => {
    const bridge = new FakeBridge();
    const counts: number[] = [];
    const app = createApp(() => <Window highlight={{ query: "needle" }} onHighlight={({ matchCount }) => counts.push(matchCount)}>
      <Text>needle</Text>
    </Window>, { bridge });
    await app.ready;
    bridge.emit({ type: "highlight", id: "root", matchCount: 1 });
    expect(counts).toEqual([1]);
    app.close();
  });

  test("createApp forwards renderer selection and defaults to auto", async () => {
    const cpuBridge = new FakeBridge();
    const cpuApp = createApp(() => <Window />, { bridge: cpuBridge, renderer: "cpu" });
    await cpuApp.ready;
    expect(cpuBridge.document?.renderer).toBe("cpu");

    const gpuBridge = new FakeBridge();
    const gpuApp = createApp(() => <Window />, { bridge: gpuBridge, renderer: "gpu" });
    await gpuApp.ready;
    expect(gpuBridge.document?.renderer).toBe("gpu");

    const autoBridge = new FakeBridge();
    const autoApp = createApp(() => <Window />, { bridge: autoBridge });
    await autoApp.ready;
    expect(autoBridge.document?.renderer).toBe("auto");
  });

  test("lowPower picks the CPU renderer, no MSAA and an early trim unless set explicitly", async () => {
    const bridge = new FakeBridge();
    const app = createApp(() => <Window />, { bridge, lowPower: true });
    await app.ready;
    expect(bridge.document?.renderer).toBe("cpu");
    expect(bridge.document?.msaa).toBe(0);
    expect(bridge.document?.memoryTrimDelay).toBeUndefined();
    expect(bridge.document?.lowPower).toBe(true);

    const explicitBridge = new FakeBridge();
    const explicit = createApp(() => <Window />, { bridge: explicitBridge, lowPower: true, renderer: "gpu", msaa: 4, memoryTrimDelay: false });
    await explicit.ready;
    expect(explicitBridge.document?.renderer).toBe("gpu");
    expect(explicitBridge.document?.msaa).toBe(4);
    expect(explicitBridge.document?.memoryTrimDelay).toBe(-1);
  });

  test("createApp forwards component adapters without knowing foreign libraries", async () => {
    const bridge = new FakeBridge();
    const foreignType = { library: "external" };
    const foreignNode: VNode = { type: foreignType as never, props: { id: "adapted" } };
    const adapter: ComponentAdapter = ({ type, props }) => type === foreignType
      ? Svg({ id: String(props.id), size: 16, nodes: [["circle", { cx: 12, cy: 12, r: 9 }]] })
      : undefined;
    const app = createApp(() => Window({ children: foreignNode }), { bridge, componentAdapters: [adapter] });
    await app.ready;
    expect(bridge.document?.root.children[0]?.kind).toBe("svg");
    expect(bridge.document?.root.children[0]?.id).toBe("adapted");
  });

  test("registerHotkey normalizes shortcuts and unsubscribes cleanly", async () => {
    const bridge = new FakeBridge();
    const app = createApp(() => <Window />, { bridge });
    await app.ready;
    let calls = 0;
    const unsubscribe = app.registerHotkey("shift+control+s", () => { calls++; });
    bridge.emit({ type: "shortcut", shortcut: "Ctrl+Shift+S" });
    expect(calls).toBe(1);
    unsubscribe();
    bridge.emit({ type: "shortcut", shortcut: "Ctrl+Shift+S" });
    expect(calls).toBe(1);
    expect(() => app.registerHotkey("Ctrl", () => {})).toThrow(TypeError);
  });

  test("the tray shows the app icon unless it names its own", async () => {
    const png = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFBQIAX8jx0gAAAABJRU5ErkJggg==";
    const bridge = new FakeBridge();
    const app = createApp(() => <Window><TitleBar /></Window>, { bridge, icon: png });
    await app.ready;
    const tray = app.tray({ tooltip: "Tray" });
    const sent = bridge.commands.at(-1) as { tray: { iconData?: string } };
    expect(sent.tray.iconData).toBe(png.slice(png.indexOf(",") + 1));
    tray.update({ tooltip: "again" });
    expect((bridge.commands.at(-1) as { tray: { iconData?: string } }).tray.iconData).toBeUndefined();
    tray.update({ icon: "data:image/png;base64,AAAA" });
    expect((bridge.commands.at(-1) as { tray: { iconData?: string } }).tray.iconData).toBe("AAAA");
    app.close();
  });

  test("tray, notifications and window visibility round-trip through the bridge", async () => {
    const bridge = new FakeBridge();
    const app = createApp(() => <Window><TitleBar /></Window>, { bridge, closeBehavior: "hide" });
    expect(bridge.document?.root.closeIntercept).toBe(true);
    await app.ready;
    const seen: string[] = [];
    const tray = app.tray({
      tooltip: "Tray",
      onClick: () => seen.push("click"),
      onMenu: id => seen.push(`menu:${id}`),
      menu: [
        { id: "open", label: "Open", onSelect: () => seen.push("select:open") },
        { type: "separator" },
        { id: "more", label: "More", items: [{ id: "mute", label: "Mute", checked: true }] },
      ],
    });
    expect(bridge.commands.at(-1)).toEqual({ type: "tray", tray: { tooltip: "Tray", menu: [
      { id: "open", label: "Open" }, { separator: true }, { label: "More", items: [{ id: "mute", label: "Mute", checked: true }] },
    ] } });
    bridge.emit({ type: "tray", action: "click" });
    bridge.emit({ type: "trayMenu", id: "open" });
    bridge.emit({ type: "trayMenu", id: "mute" });
    expect(seen).toEqual(["click", "select:open", "menu:open", "menu:mute"]);
    tray.update({ tooltip: "2 new" });
    expect((bridge.commands.at(-1) as { tray: { tooltip: string } }).tray.tooltip).toBe("2 new");
    let clicked = 0;
    let other = 0;
    app.notify({ title: "Hi", onClick: () => clicked++ });
    expect(bridge.commands.at(-1)).toEqual({ type: "notify", title: "Hi", body: "", id: "n1" });
    app.notify({ title: "Other", body: "b", onClick: () => other++ });
    expect(bridge.commands.at(-1)).toEqual({ type: "notify", title: "Other", body: "b", id: "n2" });
    // Each notification's click runs its own onClick; a click without an id runs the newest.
    bridge.emit({ type: "notificationClick", id: "n1" });
    expect([clicked, other]).toEqual([1, 0]);
    bridge.emit({ type: "notificationClick" });
    expect([clicked, other]).toEqual([1, 1]);
    const asked = app.requestPermissions(["CAMERA", "android.permission.RECORD_AUDIO"]);
    const command = bridge.commands.at(-1) as { type: string; action: string; permissions: string[]; requestId: string };
    expect([command.type, command.action, command.permissions]).toEqual(["permissions", "request", ["CAMERA", "android.permission.RECORD_AUDIO"]]);
    bridge.emit({ type: "permissions", requestId: command.requestId, results: { CAMERA: "granted", "android.permission.RECORD_AUDIO": "denied" } });
    expect(await asked).toEqual({ CAMERA: "granted", "android.permission.RECORD_AUDIO": "denied" });
    await expect(app.checkPermissions(["no spaces allowed"])).rejects.toThrow(TypeError);
    bridge.commands.length = 0;
    bridge.emit({ type: "closeRequest" });
    expect(bridge.commands).toEqual([{ type: "window", action: "hide" }, { type: "cancelCloseRequest" }]);
    app.show();
    expect(bridge.commands.at(-1)).toEqual({ type: "window", action: "show" });
    app.setFullscreen(true); app.setFullscreen(false); app.toggleFullscreen(); app.setMaximized(true); app.setMaximized(false);
    expect(bridge.commands.slice(-5).map(command => (command as { action: string }).action))
      .toEqual(["fullscreen", "exitFullscreen", "toggleFullscreen", "maximize", "unmaximize"]);
    tray.remove();
    expect(bridge.commands.at(-1)).toEqual({ type: "tray", tray: null });
    expect(() => app.tray({ menu: [{ id: "a", label: "A" }, { id: "a", label: "B" }] })).toThrow(TypeError);
    app.close();
  });

  test("system media state and hardware actions round-trip through the bridge", async () => {
    const bridge = new FakeBridge();
    const app = createApp(() => <Window />, { bridge });
    await app.ready;
    const actions: string[] = [];
    app.systemMedia({ title: "Song", artist: "Artist", playing: true, duration: 120, position: 12, canSeek: true, canNext: true, onAction: (action, time) => actions.push(action + ":" + (time ?? "")) });
    expect(bridge.commands.at(-1)).toEqual({ type: "systemMedia", session: { title: "Song", artist: "Artist", playing: true, duration: 120, position: 12, canSeek: true, canNext: true } });
    bridge.emit({ type: "systemMedia", action: "pause" });
    bridge.emit({ type: "systemMedia", action: "seek", time: 42 });
    expect(actions).toEqual(["pause:", "seek:42"]);
    app.systemMedia(null);
    expect(bridge.commands.at(-1)).toEqual({ type: "systemMedia", session: null });
    app.close();
  });

  test("native file dialog methods preserve options and return cancellation/results", async () => {
    const bridge = new FakeBridge();
    const app = createApp(() => <Window />, { bridge });
    await app.ready;
    const opening = app.openFileDialog({ title: "Open", directory: "C:/tmp", filters: [{ name: "Images", extensions: ["png", ".jpg"] }] });
    const openCommand = bridge.commands.at(-1);
    expect(openCommand?.type).toBe("fileDialog");
    if (openCommand?.type !== "fileDialog") throw new Error("expected fileDialog command");
    expect(openCommand.mode).toBe("openFile");
    expect(openCommand.options.filters?.[0]?.extensions).toEqual(["png", ".jpg"]);
    bridge.emit({ type: "fileDialog", requestId: openCommand.requestId, paths: ["C:\\tmp\\photo.png"] });
    expect(await opening).toBe("C:\\tmp\\photo.png");

    const cancelled = app.openFolderDialog({ title: "Folder" });
    const folderCommand = bridge.commands.at(-1);
    if (folderCommand?.type !== "fileDialog") throw new Error("expected folder fileDialog command");
    expect(folderCommand.mode).toBe("openFolder");
    bridge.emit({ type: "fileDialog", requestId: folderCommand.requestId, paths: [] });
    expect(await cancelled).toBeUndefined();

    const multiple = app.openFilesDialog();
    const filesCommand = bridge.commands.at(-1);
    if (filesCommand?.type !== "fileDialog") throw new Error("expected files fileDialog command");
    bridge.emit({ type: "fileDialog", requestId: filesCommand.requestId, paths: ["a.txt", "b.txt"] });
    expect(await multiple).toEqual(["a.txt", "b.txt"]);
    await expect(app.openFileDialog({ filters: [{ name: "Bad", extensions: ["*.exe"] }] })).rejects.toThrow(TypeError);
  });

  test("Window onCloseRequest can cancel or allow an OS close request", async () => {
    const cancelledBridge = new FakeBridge();
    let requests = 0;
    let message = "ready";
    const cancelled = createApp(() => (
      <Window onCloseRequest={event => { requests++; message = "confirm"; event.preventDefault(); }}>
        <Input id="state" value={message} />
      </Window>
    ), { bridge: cancelledBridge });
    await cancelled.ready;
    cancelledBridge.emit({ type: "closeRequest" });
    await Bun.sleep(0);
    expect(requests).toBe(1);
    expect(cancelledBridge.commands.some(command => command.type === "cancelCloseRequest")).toBe(true);
    const patch = cancelledBridge.commands.find(command => command.type === "patch");
    expect(patch?.type).toBe("patch");
    if (patch?.type === "patch") expect(patch.nodes.find(node => node.id === "state")?.value).toBe("confirm");

    const allowedBridge = new FakeBridge();
    const allowed = createApp(() => <Window onCloseRequest={() => {}} />, { bridge: allowedBridge });
    await allowed.ready;
    allowedBridge.emit({ type: "closeRequest" });
    expect(allowedBridge.commands.at(-1)).toEqual({ type: "close" });
  });

  test("programmatic close remains unconditional with a close-request handler", async () => {
    const bridge = new FakeBridge();
    const app = createApp(() => <Window onCloseRequest={event => event.preventDefault()} />, { bridge });
    await app.ready;
    app.close();
    expect(bridge.commands.at(-1)).toEqual({ type: "close" });
  });

  test("unexpected closeRequest without a current handler fails closed", async () => {
    const bridge = new FakeBridge();
    const app = createApp(() => <Window />, { bridge });
    await app.ready;
    bridge.emit({ type: "closeRequest" });
    expect(bridge.commands.at(-1)).toEqual({ type: "close" });
  });

  test("reverts a native text edit when a controlled handler rejects it", async () => {
    const bridge = new FakeBridge();
    let value = "12";
    const app = createApp(() => (
      <Window><Input id="input" value={value} onChange={next => { if (/^\d*$/.test(next)) value = next; }} /></Window>
    ), { bridge });
    await app.ready;
    bridge.emit({ type: "change", id: "input", value: "12a" });
    await Bun.sleep(0);
    const patch = bridge.commands.find(command => command.type === "patch");
    expect(patch?.type).toBe("patch");
    if (patch?.type === "patch") expect(patch.nodes.find(node => node.id === "input")?.value).toBe("12");
  });

  test("dispatches native submit and non-text paste events to editor handlers", async () => {
    const bridge = new FakeBridge();
    const submitted: string[] = [];
    const pasted: unknown[] = [];
    const app = createApp(() => (
      <Window>
        <Input id="input" value="query" onSubmit={value => submitted.push(value)} onPaste={payload => pasted.push(payload)} />
        <TextArea id="chat" value="" submitOnEnter onSubmit={value => submitted.push(`chat:${value}`)} />
      </Window>
    ), { bridge });
    await app.ready;
    const find = (node: SceneDocument["root"], id: string): SceneDocument["root"] | undefined =>
      node.id === id ? node : node.children.map(child => find(child, id)).find(Boolean);
    expect(find(bridge.document!.root, "chat")?.submitOnEnter).toBe(true);
    expect(find(bridge.document!.root, "input")?.submitOnEnter).toBeUndefined();

    bridge.emit({ type: "submit", id: "input", value: "query" });
    bridge.emit({ type: "submit", id: "chat", value: "hello" });
    bridge.emit({ type: "paste", id: "input", files: ["C:\\tmp\\a.png"] });
    bridge.emit({ type: "paste", id: "input", image: { width: 1, height: 1, rgba: Buffer.from([1, 2, 3, 4]).toString("base64") } });
    bridge.emit({ type: "paste", id: "input" });
    await Bun.sleep(0);

    expect(submitted).toEqual(["query", "chat:hello"]);
    expect(pasted).toEqual([
      { kind: "files", files: ["C:\\tmp\\a.png"] },
      { kind: "image", width: 1, height: 1, rgba: new Uint8Array([1, 2, 3, 4]) },
    ]);
    app.close();
  });

  test("reverts a native slider edit when controlled state stays unchanged", async () => {
    const bridge = new FakeBridge();
    let value = 20;
    const app = createApp(() => (
      <Window><Slider id="slider" value={value} onValueChange={next => { if (next <= 20) value = next; }} /></Window>
    ), { bridge });
    await app.ready;
    bridge.emit({ type: "valueChange", id: "slider", value: 21 });
    await Bun.sleep(0);
    const patch = bridge.commands.find(command => command.type === "patch");
    expect(patch?.type).toBe("patch");
    if (patch?.type === "patch") expect(patch.nodes.find(node => node.id === "slider")?.control?.value).toBe(20);
  });

  test("focus and scrollToItem after update() reach the nodes that render adds", async () => {
    const bridge = new FakeBridge();
    let editing = false;
    const app = createApp(() => (
      <Window>{editing ? <Input id="name" value="" /> : <Text id="label">Name</Text>}</Window>
    ), { bridge });
    await app.ready;
    bridge.commands.length = 0;
    editing = true;
    app.update();
    app.focus("name");
    await Bun.sleep(0);
    expect(bridge.commands.map(command => command.type)).toEqual(["mutate", "focus"]);
    // With no render queued, the command goes out at once.
    bridge.commands.length = 0;
    app.focus("name");
    expect(bridge.commands.map(command => command.type)).toEqual(["focus"]);
  });

  test("scroll dispatch keeps the scalar callback and exposes optional 2D position", async () => {
    const bridge = new FakeBridge();
    const scalar: unknown[][] = [];
    const positions: unknown[] = [];
    const app = createApp(() => (
      <Window>
        <ScrollArea
          id="scroll"
          orientation="both"
          onScroll={(offset, max, info) => scalar.push([offset, max, info.source])}
          onScrollPosition={position => positions.push(position)}
        />
      </Window>
    ), { bridge });
    await app.ready;
    bridge.emit({
      type: "scroll",
      id: "scroll",
      offset: 30,
      max: 300,
      offsetX: 20,
      offsetY: 30,
      maxX: 200,
      maxY: 300,
      source: "program",
    });
    // A runtime that predates `source` reports input.
    bridge.emit({ type: "scroll", id: "scroll", offset: 40, max: 300 });
    await Bun.sleep(0);
    expect(scalar).toEqual([[30, 300, "program"], [40, 300, "user"]]);
    expect(positions).toEqual([{ x: 20, y: 30, maxX: 200, maxY: 300, source: "program" }, { x: 0, y: 40, maxX: 0, maxY: 300, source: "user" }]);
  });

  test("native variable-list measurements feed the next keyed window through normal event dispatch", async () => {
    const bridge = new FakeBridge();
    let offset = 0;
    const sources: string[] = [];
    const items = ["a", "b", "c", "d"];
    const app = createApp(() => (
      <Window>
        <VirtualList
          id="measured-list"
          items={items}
          estimatedItemHeight={40}
          height={60}
          offset={offset}
          overscan={0}
          keyForItem={item => item}
          onScroll={(next, _max, info) => { offset = next; sources.push(info.source); }}
          renderItem={item => <Text id={`measured-${item}`}>{item}</Text>}
        />
      </Window>
    ), { bridge });
    await app.ready;

    bridge.emit({
      type: "virtualListLayout",
      id: "measured-list",
      items: [{ key: "s:a", height: 20 }, { key: "s:b", height: 80 }],
    });
    await Bun.sleep(0);
    bridge.commands.length = 0;

    bridge.emit({
      type: "scroll",
      id: "measured-list",
      offset: 90,
      max: 120,
      offsetX: 0,
      offsetY: 90,
      maxX: 0,
      maxY: 120,
      source: "layout",
    });
    await Bun.sleep(0);

    expect(offset).toBe(90);
    expect(sources).toEqual(["layout"]);
    const command = bridge.commands.at(-1);
    expect(command?.type).toBe("mutate");
    if (command?.type !== "mutate") throw new Error("expected measured virtual-list mutation");
    const listPatch = command.mutations.find(
      mutation => mutation.type === "patch" && mutation.node.id === "measured-list",
    );
    expect(listPatch?.type).toBe("patch");
    if (listPatch?.type === "patch") {
      expect(listPatch.node.virtualList?.renderedKeys).toEqual(["s:b", "s:c", "s:d"]);
    }
  });

  test("native virtual-list focus keeps the focused row mounted when it scrolls outside the window", async () => {
    const bridge = new FakeBridge();
    let offset = 0;
    const items = ["a", "b", "c", "d", "e"];
    const app = createApp(() => (
      <Window>
        <VirtualList
          id="focus-event-list"
          items={items}
          estimatedItemHeight={40}
          height={80}
          offset={offset}
          overscan={0}
          keyForItem={item => item}
          onScroll={next => { offset = next; }}
          renderItem={item => <Text id={`focus-event-${item}`}>{item}</Text>}
        />
      </Window>
    ), { bridge });
    await app.ready;

    bridge.emit({ type: "virtualListFocus", id: "focus-event-list", key: "s:b" });
    await Bun.sleep(0);
    bridge.commands.length = 0;

    bridge.emit({
      type: "scroll",
      id: "focus-event-list",
      offset: 120,
      max: 120,
      offsetX: 0,
      offsetY: 120,
      maxX: 0,
      maxY: 120,
    });
    await Bun.sleep(0);

    expect(offset).toBe(120);
    const command = bridge.commands.at(-1);
    expect(command?.type).toBe("mutate");
    if (command?.type !== "mutate") throw new Error("expected focused virtual-list mutation");
    const listPatch = command.mutations.find(
      mutation => mutation.type === "patch" && mutation.node.id === "focus-event-list",
    );
    expect(listPatch?.type).toBe("patch");
    if (listPatch?.type === "patch") {
      expect(listPatch.node.virtualList?.retainedKey).toBe("s:b");
      expect(listPatch.node.virtualList?.renderedKeys).toEqual(["s:d", "s:e"]);
    }
  });

  test("scrollToItem uses a generation-tagged variable-list request and acknowledges through scroll", async () => {
    const bridge = new FakeBridge();
    let offset = 0;
    const items = ["a", "b", "c", "d", "e", "f"];
    const app = createApp(() => (
      <Window>
        <VirtualList
          id="imperative-list"
          items={items}
          estimatedItemHeight={40}
          height={80}
          offset={offset}
          overscan={0}
          keyForItem={item => item}
          onScroll={next => { offset = next; }}
          renderItem={item => <Text id={`imperative-${item}`}>{item}</Text>}
        />
      </Window>
    ), { bridge });
    await app.ready;

    app.scrollToItem("imperative-list", 3, 5);
    expect(bridge.commands.at(-1)).toEqual({
      type: "scrollToItem",
      id: "imperative-list",
      index: 3,
      offset: 5,
    });
    expect(() => app.scrollToItem("imperative-list", -1)).toThrow(RangeError);
    bridge.commands.length = 0;

    bridge.emit({ type: "virtualListScrollToItem", id: "imperative-list", index: 3, offset: 5 });
    await Bun.sleep(0);
    const requested = bridge.commands.at(-1);
    expect(requested?.type).toBe("mutate");
    if (requested?.type !== "mutate") throw new Error("expected scrollToItem window mutation");
    const requestPatch = requested.mutations.find(
      mutation => mutation.type === "patch" && mutation.node.id === "imperative-list",
    );
    expect(requestPatch?.type).toBe("patch");
    if (requestPatch?.type === "patch") {
      expect(requestPatch.node.virtualList?.scrollRequest).toEqual({ generation: 1, offset: 125 });
      expect(requestPatch.node.virtualList?.renderedKeys).toContain("s:d");
    }

    bridge.commands.length = 0;
    bridge.emit({
      type: "scroll",
      id: "imperative-list",
      offset: 125,
      max: 160,
      offsetX: 0,
      offsetY: 125,
      maxX: 0,
      maxY: 160,
    });
    await Bun.sleep(0);
    expect(offset).toBe(125);
    const acknowledged = bridge.commands.at(-1);
    expect(acknowledged?.type).toBe("patch");
    if (acknowledged?.type === "patch") {
      expect(acknowledged.nodes.find(node => node.id === "imperative-list")?.virtualList?.scrollRequest).toBeUndefined();
    }

    // A smooth request carries the flag to native and back into the list's request.
    app.scrollToItem("imperative-list", 1, 0, { smooth: true });
    expect(bridge.commands.at(-1)).toEqual({ type: "scrollToItem", id: "imperative-list", index: 1, smooth: true });
    bridge.commands.length = 0;
    bridge.emit({ type: "virtualListScrollToItem", id: "imperative-list", index: 1, offset: 0, smooth: true });
    await Bun.sleep(0);
    const smooth = bridge.commands.at(-1);
    const smoothList = smooth?.type === "mutate"
      ? smooth.mutations.flatMap(mutation => mutation.type === "patch" ? [mutation.node] : []).find(node => node.id === "imperative-list")
      : smooth?.type === "patch" ? smooth.nodes.find(node => node.id === "imperative-list") : undefined;
    expect(smoothList?.virtualList?.scrollRequest).toEqual({ generation: 2, offset: 40, smooth: true });
  });

  test("separate apps do not share variable VirtualList measurements for the same id", async () => {
    const firstBridge = new FakeBridge();
    const first = createApp(() => (
      <Window>
        <VirtualList
          id="shared-list-id"
          items={["same", "first"]}
          estimatedItemHeight={40}
          height={40}
          offset={0}
          overscan={0}
          keyForItem={item => item}
          onScroll={() => {}}
          renderItem={item => <Text>{item}</Text>}
        />
      </Window>
    ), { bridge: firstBridge });
    await first.ready;
    firstBridge.emit({
      type: "virtualListLayout",
      id: "shared-list-id",
      items: [{ key: "s:same", height: 80 }],
    });

    const secondBridge = new FakeBridge();
    const second = createApp(() => (
      <Window>
        <VirtualList
          id="shared-list-id"
          items={["same", "second"]}
          estimatedItemHeight={40}
          height={40}
          offset={40}
          overscan={0}
          keyForItem={item => item}
          onScroll={() => {}}
          renderItem={item => <Text>{item}</Text>}
        />
      </Window>
    ), { bridge: secondBridge });
    await second.ready;

    expect(secondBridge.document?.root.children[0]?.virtualList?.renderedKeys).toEqual(["s:second"]);
  });

  test("InputOTP filters native edits and patches rejected characters back out", async () => {
    const bridge = new FakeBridge();
    let value = "1234";
    const app = createApp(() => (
      <Window><InputOTP id="otp" value={value} length={4} onValueChange={next => { value = next; }} /></Window>
    ), { bridge });
    await app.ready;
    bridge.emit({ type: "change", id: "otp-input", value: "1234x" });
    await Bun.sleep(0);
    expect(value).toBe("1234");
    const patch = bridge.commands.find(command => command.type === "patch");
    expect(patch?.type).toBe("patch");
    if (patch?.type === "patch") expect(patch.nodes.find(node => node.id === "otp-input")?.value).toBe("1234");
  });

  test("startup render failures reject ready, resolve closed, report context, and never start native", async () => {
    const bridge = new FakeBridge();
    const errors: AppErrorEvent[] = [];
    const app = createApp(() => { throw new Error("startup boom"); }, { bridge, onError: event => errors.push(event) });
    await expect(app.ready).rejects.toThrow("startup boom");
    await app.closed;
    expect(bridge.starts).toBe(0);
    expect(errors).toHaveLength(1);
    expect(errors[0]?.source).toBe("render");
    expect(errors[0]?.event).toBe("startup");
  });

  test("bridge startup failures reject ready and settle closed deterministically", async () => {
    const bridge = new FakeBridge();
    bridge.startError = new Error("native unavailable");
    const errors: AppErrorEvent[] = [];
    const app = createApp(() => <Window />, { bridge, onError: event => errors.push(event) });
    await expect(app.ready).rejects.toThrow("native unavailable");
    await app.closed;
    expect(errors.map(event => [event.source, event.event])).toEqual([["bridge", "start"]]);
  });

  test("failed update render keeps the last valid native tree and can recover later", async () => {
    const bridge = new FakeBridge();
    const errors: AppErrorEvent[] = [];
    let label = "before";
    let broken = false;
    const app = createApp(() => {
      if (broken) throw new Error("render failed");
      return <Window><Button id="button">{label}</Button></Window>;
    }, { bridge, onError: event => errors.push(event) });
    await app.ready;
    label = "after";
    broken = true;
    app.update();
    await Bun.sleep(0);
    expect(bridge.commands).toHaveLength(0);
    expect(errors.at(-1)?.source).toBe("render");
    broken = false;
    app.update();
    await Bun.sleep(0);
    const patch = bridge.commands.at(-1);
    expect(patch?.type).toBe("patch");
    if (patch?.type === "patch") expect(patch.nodes.find(node => node.id === "button")?.text).toBe("after");
  });

  test("failed bridge send does not commit new handlers or advance the canonical tree", async () => {
    const bridge = new FakeBridge();
    const errors: AppErrorEvent[] = [];
    let alternate = false;
    let oldCalls = 0;
    let newCalls = 0;
    const app = createApp(() => (
      <Window>
        <Button id="button" onClick={alternate ? () => { newCalls++; } : () => { oldCalls++; }}>
          {alternate ? "new" : "old"}
        </Button>
      </Window>
    ), { bridge, onError: event => errors.push(event) });
    await app.ready;
    alternate = true;
    bridge.failNextSend = new Error("send failed");
    app.update();
    await Bun.sleep(0);
    expect(errors.at(-1)?.source).toBe("bridge");
    expect(errors.at(-1)?.event).toBe("patch");
    bridge.emit({ type: "click", id: "button" });
    expect(oldCalls).toBe(1);
    expect(newCalls).toBe(0);
    await Bun.sleep(0);
    expect(bridge.commands.at(-1)?.type).toBe("patch");
  });

  test("structural renders use incremental mutation batches instead of full-tree updates", async () => {
    const bridge = new FakeBridge();
    let items = ["a"];
    const clicks: string[] = [];
    const app = createApp(() => (
      <Window>
        <Column id="list">
          {items.map(item => <Button key={item} id={item} onClick={() => clicks.push(item)}>{item}</Button>)}
        </Column>
      </Window>
    ), { bridge });
    await app.ready;

    items = ["a", "b"];
    app.update();
    await Bun.sleep(0);
    const inserted = bridge.commands.at(-1);
    expect(inserted?.type).toBe("mutate");
    if (inserted?.type !== "mutate") throw new Error("expected structural mutate command");
    expect(inserted.mutations).toEqual([
      expect.objectContaining({ type: "create", node: expect.objectContaining({ id: "b", children: [] }) }),
      { type: "children", id: "list", children: ["a", "b"] },
    ]);
    expect(bridge.commands.some(command => command.type === "update")).toBe(false);

    bridge.emit({ type: "click", id: "b" });
    expect(clicks).toEqual(["b"]);

    items = ["b", "a"];
    app.update();
    await Bun.sleep(0);
    const reordered = bridge.commands.at(-1);
    expect(reordered).toEqual({
      type: "mutate",
      mutations: [{ type: "children", id: "list", children: ["b", "a"] }],
    });

    items = ["b"];
    app.update();
    await Bun.sleep(0);
    const removed = bridge.commands.at(-1);
    expect(removed).toEqual({
      type: "mutate",
      mutations: [
        { type: "children", id: "list", children: ["b"] },
        { type: "remove", id: "a" },
      ],
    });
  });

  test("failed structural mutation send does not advance handlers or the native shadow", async () => {
    const bridge = new FakeBridge();
    const errors: AppErrorEvent[] = [];
    let showExtra = false;
    let extraClicks = 0;
    const app = createApp(() => (
      <Window>
        <Column id="list">
          <Button id="stable">Stable</Button>
          {showExtra ? <Button id="extra" onClick={() => { extraClicks++; }}>Extra</Button> : null}
        </Column>
      </Window>
    ), { bridge, onError: event => errors.push(event) });
    await app.ready;

    showExtra = true;
    bridge.failNextSend = new Error("mutation send failed");
    app.update();
    await Bun.sleep(0);
    expect(errors.at(-1)?.source).toBe("bridge");
    expect(errors.at(-1)?.event).toBe("mutate");
    bridge.emit({ type: "click", id: "extra" });
    expect(extraClicks).toBe(0);

    app.update();
    await Bun.sleep(0);
    const recovered = bridge.commands.at(-1);
    expect(recovered?.type).toBe("mutate");
    if (recovered?.type !== "mutate") throw new Error("expected recovered mutate command");
    expect(recovered.mutations.some(mutation => mutation.type === "create" && mutation.node.id === "extra")).toBe(true);
    bridge.emit({ type: "click", id: "extra" });
    expect(extraClicks).toBe(1);
  });

  test("throwing controlled change handler is contained and rolls native value back", async () => {
    const bridge = new FakeBridge();
    const errors: AppErrorEvent[] = [];
    const app = createApp(() => (
      <Window><Input id="input" value="fixed" onChange={() => { throw new Error("reject edit"); }} /></Window>
    ), { bridge, onError: event => errors.push(event) });
    await app.ready;
    expect(() => bridge.emit({ type: "change", id: "input", value: "changed" })).not.toThrow();
    expect(errors.at(-1)?.source).toBe("event-handler");
    expect(errors.at(-1)?.event).toBe("change");
    expect(errors.at(-1)?.targetId).toBe("input");
    const patch = bridge.commands.at(-1);
    expect(patch?.type).toBe("patch");
    if (patch?.type === "patch") expect(patch.nodes.find(node => node.id === "input")?.value).toBe("fixed");
  });

  test("controlled native edits are reconciled even without a change handler", async () => {
    const bridge = new FakeBridge();
    const app = createApp(() => <Window><Input id="input" value="fixed" /></Window>, { bridge });
    await app.ready;
    bridge.emit({ type: "change", id: "input", value: "changed" });
    await Bun.sleep(0);
    const patch = bridge.commands.at(-1);
    expect(patch?.type).toBe("patch");
    if (patch?.type === "patch") expect(patch.nodes.find(node => node.id === "input")?.value).toBe("fixed");
  });

  test("event handlers, hotkeys, and listeners are isolated from sibling failures", async () => {
    const bridge = new FakeBridge();
    const errors: AppErrorEvent[] = [];
    let goodClicks = 0;
    let goodHotkeys = 0;
    let goodListeners = 0;
    const app = createApp(() => (
      <Window>
        <Button id="bad" onClick={() => { throw new Error("bad click"); }}>Bad</Button>
        <Button id="good" onClick={() => { goodClicks++; }}>Good</Button>
      </Window>
    ), { bridge, onError: event => errors.push(event) });
    await app.ready;
    app.registerHotkey("Ctrl+S", () => { throw new Error("bad hotkey"); });
    app.registerHotkey("Ctrl+S", () => { goodHotkeys++; });
    app.onEvent(() => { throw new Error("bad listener"); });
    app.onEvent(() => { goodListeners++; });
    bridge.emit({ type: "click", id: "bad" });
    bridge.emit({ type: "click", id: "good" });
    bridge.emit({ type: "shortcut", shortcut: "Ctrl+S" });
    expect(goodClicks).toBe(1);
    expect(goodHotkeys).toBe(1);
    expect(goodListeners).toBe(3);
    expect(errors.some(event => event.source === "event-handler")).toBe(true);
    expect(errors.some(event => event.source === "hotkey")).toBe(true);
    expect(errors.filter(event => event.source === "listener")).toHaveLength(3);
  });

  test("throwing close-request handler cancels the handshake and does not escape", async () => {
    const bridge = new FakeBridge();
    const errors: AppErrorEvent[] = [];
    const app = createApp(() => <Window onCloseRequest={() => { throw new Error("cannot decide"); }} />, {
      bridge,
      onError: event => errors.push(event),
    });
    await app.ready;
    expect(() => bridge.emit({ type: "closeRequest" })).not.toThrow();
    expect(bridge.commands.at(-1)).toEqual({ type: "cancelCloseRequest" });
    expect(errors.at(-1)?.source).toBe("event-handler");
    bridge.emit({ type: "closeRequest" });
    expect(bridge.commands.filter(command => command.type === "cancelCloseRequest")).toHaveLength(2);
  });

  test("programmatic close inside onCloseRequest does not send a second close decision", async () => {
    const bridge = new FakeBridge();
    let app!: ReturnType<typeof createApp>;
    app = createApp(() => <Window onCloseRequest={() => app.close()} />, { bridge });
    await app.ready;
    bridge.emit({ type: "closeRequest" });
    expect(bridge.commands).toEqual([{ type: "close" }]);
    app.close();
    expect(bridge.commands).toEqual([{ type: "close" }]);
  });

  test("onError throwing cannot take down dispatch", async () => {
    const bridge = new FakeBridge();
    let goodClicks = 0;
    const originalConsoleError = console.error;
    console.error = () => {};
    try {
      const app = createApp(() => (
        <Window>
          <Button id="bad" onClick={() => { throw new Error("handler failed"); }}>Bad</Button>
          <Button id="good" onClick={() => { goodClicks++; }}>Good</Button>
        </Window>
      ), { bridge, onError: () => { throw new Error("reporter failed"); } });
      await app.ready;
      expect(() => bridge.emit({ type: "click", id: "bad" })).not.toThrow();
      bridge.emit({ type: "click", id: "good" });
      expect(goodClicks).toBe(1);
    } finally {
      console.error = originalConsoleError;
    }
  });

  test("native and file-dialog errors use the structured error channel while promises still reject", async () => {
    const bridge = new FakeBridge();
    const errors: AppErrorEvent[] = [];
    const app = createApp(() => <Window />, { bridge, debug: true, onError: event => errors.push(event) });
    await app.ready;
    bridge.emit({ type: "error", message: "renderer lost" });
    expect(errors.at(-1)?.source).toBe("native");
    const opening = app.openFileDialog();
    const command = bridge.commands.at(-1);
    if (command?.type !== "fileDialog") throw new Error("expected fileDialog command");
    bridge.emit({ type: "fileDialog", requestId: command.requestId, paths: [], error: "dialog failed" });
    await expect(opening).rejects.toThrow("dialog failed");
    expect(errors.at(-1)?.source).toBe("file-dialog");

    const capturing = app.capture("capture.png");
    const captureCommand = bridge.commands.at(-1);
    if (captureCommand?.type !== "capture") throw new Error("expected capture command");
    bridge.emit({ type: "captured", requestId: captureCommand.requestId, path: captureCommand.path, error: "capture failed" });
    await expect(capturing).rejects.toThrow("capture failed");
    expect(errors.at(-1)?.source).toBe("request");
    expect(errors.at(-1)?.event).toBe("capture");
  });

  test("closed settles and rejects pending requests even when bridge.join throws", async () => {
    const bridge = new FakeBridge();
    bridge.joinError = new Error("join failed");
    const errors: AppErrorEvent[] = [];
    const app = createApp(() => <Window />, { bridge, onError: event => errors.push(event) });
    await app.ready;
    const pending = app.inspect();
    bridge.emit({ type: "closed" });
    await app.closed;
    await expect(pending).rejects.toThrow("Native window closed");
    expect(bridge.joins).toBe(1);
    expect(errors.at(-1)?.source).toBe("bridge");
    expect(errors.at(-1)?.event).toBe("join");
  });

  test("stats reports JS update phases with the native answer and resets both on request", async () => {
    const bridge = new FakeBridge();
    let label = "a";
    const app = createApp(() => <Window><Text id="label">{label}</Text></Window>, { bridge });
    await app.ready;
    for (const next of ["b", "c"]) {
      label = next;
      app.update();
      await Promise.resolve();
    }
    const reading = app.stats({ reset: true });
    await Promise.resolve();
    const command = bridge.commands.at(-1);
    if (command?.type !== "stats") throw new Error("expected stats command");
    expect(command.reset).toBe(true);
    const native = { phases: null, memory: null };
    bridge.emit({ type: "stats", requestId: command.requestId, stats: native });
    const stats = await reading;
    expect(stats.native).toEqual(native);
    for (const phase of ["render", "diff", "shadow", "send", "update"] as const) {
      expect(stats.js[phase].count).toBe(2);
      expect(stats.js[phase].p50).toBeGreaterThanOrEqual(0);
      expect(stats.js[phase].p99).toBeLessThanOrEqual(stats.js[phase].max);
    }
    expect(stats.js.heapUsedMb).toBeGreaterThan(0);
    const again = app.stats();
    await Promise.resolve();
    const second = bridge.commands.at(-1);
    if (second?.type !== "stats") throw new Error("expected stats command");
    bridge.emit({ type: "stats", requestId: second.requestId, stats: native });
    expect((await again).js.update.count).toBe(0);
    app.close();
  });
});
