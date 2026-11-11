import { afterEach, describe, expect, test } from "bun:test";
import type { NativeCommand, NativeEvent, SceneDocument } from "./protocol";
import { createApp } from "./app";
import type { NativeBridge } from "./bridge";
import { Modal, Text, Window } from "./components";

class FakeBridge implements NativeBridge {
  commands: NativeCommand[] = [];
  document?: SceneDocument;
  private listener?: (event: NativeEvent) => void;
  start(document: SceneDocument, onEvent: (event: NativeEvent) => void): void { this.document = document; this.listener = onEvent; onEvent({ type: "ready" }); }
  send(command: NativeCommand): void { this.commands.push(command); }
  join(): void {}
  emit(event: NativeEvent): void { this.listener?.(event); }
  types(): string[] { return this.commands.map(command => command.type); }
}
const tick = () => new Promise(resolve => setTimeout(resolve, 0));
const platform = process.platform;
const asAndroid = () => Object.defineProperty(process, "platform", { value: "android", configurable: true });
afterEach(() => { Object.defineProperty(process, "platform", { value: platform, configurable: true }); });

describe("app.onBack", () => {
  test("Android Back closes the open overlay, then listeners by priority, then the window", async () => {
    asAndroid();
    const bridge = new FakeBridge();
    let dialog = true;
    const calls: string[] = [];
    const app = createApp(() => (
      <Window>
        <Text>shell</Text>
        {dialog ? <Modal id="settings" open onOpenChange={open => { if (!open) { dialog = false; calls.push("modal"); } }}><Text>settings</Text></Modal> : null}
      </Window>
    ), { bridge });
    await app.ready;
    expect(bridge.document!.root.closeIntercept).toBe(true);
    let searching = true;
    app.onBack(() => { calls.push("tab"); return false; });
    const offSearch = app.onBack(() => { if (!searching) return false; searching = false; calls.push("search"); return true; }, { priority: 10 });
    bridge.emit({ type: "closeRequest" });
    await tick();
    expect(calls).toEqual(["modal"]);
    bridge.emit({ type: "closeRequest" });
    await tick();
    expect(calls).toEqual(["modal", "search"]);
    expect(bridge.types().filter(type => type === "cancelCloseRequest")).toHaveLength(2);
    offSearch();
    bridge.emit({ type: "closeRequest" });
    await tick();
    expect(calls).toEqual(["modal", "search", "tab"]);
    expect(bridge.types()).toContain("close");
  });

  test("desktop: Escape runs only escape: true listeners; the close button never runs any", async () => {
    const bridge = new FakeBridge();
    const app = createApp(() => <Window onCloseRequest={event => event.preventDefault()}><Text>x</Text></Window>, { bridge });
    await app.ready;
    let backs = 0;
    let plain = 0;
    app.onBack(() => { plain++; return true; });
    app.onBack(() => { backs++; return true; }, { escape: true });
    bridge.emit({ type: "escape" });
    bridge.emit({ type: "closeRequest" });
    await tick();
    expect(backs).toBe(1);
    expect(plain).toBe(0);
    expect(() => app.onBack(1 as never)).toThrow(TypeError);
    app.close();
  });
});
