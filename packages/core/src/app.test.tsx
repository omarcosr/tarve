import { describe, expect, test } from "bun:test";
import type { NativeCommand, NativeEvent, SceneDocument } from "../../protocol/src/index";
import { createApp } from "./app";
import type { NativeBridge } from "./bridge";
import { Slider } from "./controls";
import { Input, Window } from "./components";
import { InputOTP } from "./form-controls";

class FakeBridge implements NativeBridge {
  commands: NativeCommand[] = [];
  private listener?: (event: NativeEvent) => void;
  start(_document: SceneDocument, onEvent: (event: NativeEvent) => void): void {
    this.listener = onEvent;
    onEvent({ type: "ready" });
  }
  send(command: NativeCommand): void { this.commands.push(command); }
  join(): void {}
  emit(event: NativeEvent): void { this.listener?.(event); }
}

describe("controlled native reconciliation", () => {
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
});
