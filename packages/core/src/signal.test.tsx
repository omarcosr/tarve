import { describe, expect, test } from "bun:test";
import type { NativeCommand, NativeEvent, NativeNode, SceneDocument } from "./protocol";
import { createApp } from "./app";
import type { NativeBridge } from "./bridge";
import { Text, View, Window } from "./components";
import { batch, signal } from "./signal";

class FakeBridge implements NativeBridge {
  commands: NativeCommand[] = [];
  document?: SceneDocument;
  start(document: SceneDocument, onEvent: (event: NativeEvent) => void): void {
    this.document = document;
    onEvent({ type: "ready" });
  }
  send(command: NativeCommand): void { this.commands.push(command); }
  join(): void {}
}

const flush = () => new Promise(resolve => setTimeout(resolve, 0));
const find = (node: NativeNode, kind: string): NativeNode | undefined =>
  node.kind === kind ? node : node.children.map(child => find(child, kind)).find(Boolean);

describe("signals", () => {
  test("a bound text and style start at the signal's value and update without a render", async () => {
    const bridge = new FakeBridge();
    const count = signal(1);
    const color = signal("#ff0000");
    let renders = 0;
    const app = createApp(() => {
      renders++;
      return <Window title="s"><View id="box" style={{ background: color }}><Text id="label">Clicks: {count}</Text></View></Window>;
    }, { bridge });
    await app.ready;
    expect(find(bridge.document!.root, "text")?.text).toBe("Clicks: 1");
    expect(bridge.document!.root.children[0]!.style.background).toBe("#ff0000");
    bridge.commands.length = 0;
    batch(() => { count.value = 2; color.value = "#00ff00"; });
    await flush();
    expect(renders).toBe(1);
    expect(bridge.commands).toEqual([{ type: "setNodes", nodes: [
      { id: "label", text: "Clicks: 2" },
      { id: "box", style: { background: "#00ff00" } },
    ] }]);
    // A later render reads the signals and finds nothing new to send for them.
    bridge.commands.length = 0;
    app.update();
    await flush();
    expect(bridge.commands.filter(command => command.type === "patch" || command.type === "mutate")).toEqual([]);
    app.close();
  });

  test("a bare signal child is its own text", async () => {
    const bridge = new FakeBridge();
    const name = signal("a");
    const app = createApp(() => <Window title="s"><View>{name}</View></Window>, { bridge });
    await app.ready;
    expect(find(bridge.document!.root, "text")?.text).toBe("a");
    bridge.commands.length = 0;
    name.value = "b";
    await flush();
    expect(bridge.commands).toHaveLength(1);
    expect((bridge.commands[0] as { nodes: { text?: string }[] }).nodes[0]!.text).toBe("b");
    app.close();
  });
});
