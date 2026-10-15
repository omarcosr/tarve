import { describe, expect, test } from "bun:test";
import { Window, Text } from "./components";
import { createApp } from "./app";
import { compileTree, diffTreeMutations } from "./reconciler";
import type { NativeBridge } from "./bridge";
import type { NativeCommand, NativeEvent, SceneDocument } from "./protocol";

class SyncBridge implements NativeBridge {
  commands: NativeCommand[] = [];
  start(_document: SceneDocument, onEvent: (event: NativeEvent) => void): void { onEvent({ type: "ready" }); }
  send(command: NativeCommand): void { this.commands.push(command); }
  join(): void {}
  requestSync(command: NativeCommand & { requestId: string }): NativeEvent | undefined {
    this.send(command);
    if (command.type === "layout") return { type: "layout", requestId: command.requestId, boxes: { label: { width: 50, height: 20, x: 1, y: 2, borderWidth: 50, borderHeight: 20 } } };
    if (command.type === "selection") return { type: "selection", requestId: command.requestId, target: "field", anchor: 1, focus: 3 };
    return undefined;
  }
}

describe("synchronous native requests", () => {
  test("layout renders a queued update first, then asks native", async () => {
    const bridge = new SyncBridge();
    let text = "a";
    const app = createApp(() => <Window><Text id="label">{text}</Text></Window>, { bridge });
    await app.ready;
    text = "b";
    app.update();
    const boxes = app.layout(["label"]);
    expect(boxes?.label?.width).toBe(50);
    const types = bridge.commands.map(command => command.type);
    expect(types.indexOf("layout")).toBeGreaterThan(types.findIndex(type => type === "patch" || type === "mutate"));
    // The update was rendered once: the queued microtask finds nothing left.
    const before = bridge.commands.length;
    await Promise.resolve();
    expect(bridge.commands.length).toBe(before);
    expect(app.textSelection()).toEqual({ id: "field", anchor: 1, focus: 3 });
    app.close();
  });

  test("bridges without requestSync answer undefined without rendering early", async () => {
    const bridge = new SyncBridge();
    (bridge as { requestSync?: unknown }).requestSync = undefined;
    const app = createApp(() => <Window><Text id="label">x</Text></Window>, { bridge });
    await app.ready;
    app.update();
    expect(app.layout(["label"])).toBeUndefined();
    expect(bridge.commands.length).toBe(0);
    app.close();
  });

  test("a change of runs alone (same text) is sent to native", () => {
    const view = (bold: boolean) => compileTree(<Window><Text id="t">plain {bold ? <strong>word</strong> : "word"}</Text></Window>);
    const mutations = diffTreeMutations(view(false), view(true));
    expect(JSON.stringify(mutations)).toContain("fontWeight");
  });
});
