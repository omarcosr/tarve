import { describe, expect, test } from "bun:test";
import type { NativeCommand, NativeEvent, NativeNode, SceneDocument } from "./protocol";
import { createApp } from "./app";
import type { NativeBridge } from "./bridge";
import { Text, View, Window } from "./components";
import { Slider } from "./controls";
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

  test("a media time signal moves a bound slider and clock without a render", async () => {
    let emit: (event: NativeEvent) => void = () => {};
    const bridge = new FakeBridge();
    const start = bridge.start.bind(bridge);
    bridge.start = (document, onEvent) => { emit = onEvent; start(document, onEvent); };
    const time = signal(0);
    let renders = 0;
    const app = createApp(() => {
      renders++;
      return <Window title="s">
        <audio id="song" src="song.m4a" time={time} />
        <Text id="clock">{time}</Text>
        <Slider id="seek" value={time} min={0} max={10} />
      </Window>;
    }, { bridge });
    await app.ready;
    bridge.commands.length = 0;
    emit({ type: "media", id: "song", event: "timeupdate", time: 3 } as NativeEvent);
    await flush();
    expect(time.value).toBe(3);
    expect(renders).toBe(1);
    const patch = bridge.commands.find(command => command.type === "patch") as { nodes: NativeNode[] } | undefined;
    expect(patch?.nodes.map(node => [node.id, node.control?.value])).toEqual([["seek", 3]]);
    expect(bridge.commands.some(command => command.type === "setNodes")).toBe(true);
    // Past `max` the thumb stays at the end; a later render finds nothing to send.
    time.value = 12;
    await flush();
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
