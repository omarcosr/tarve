import { describe, expect, test } from "bun:test";
import type { NativeCommand, NativeEvent, SceneDocument } from "../../protocol/src/index";
import { createApp } from "./app";
import type { NativeBridge } from "./bridge";
import { Column, Pressable, Window } from "./components";
import { compileTree } from "./reconciler";

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

function board(log: string[]) {
  return () => (
    <Window>
      <Pressable
        id="card"
        draggable
        onDragStart={({ x, y }) => log.push(`start ${x},${y}`)}
        onDragMove={({ over }) => log.push(`move ${over}`)}
        onDragEnd={({ target, cancelled, x, y }) => log.push(`end ${target} ${cancelled} ${x},${y}`)}
      />
      {["a", "b"].map(id => (
        <Column
          key={id}
          id={id}
          onDragEnter={source => log.push(`enter ${id} ${source}`)}
          onDragLeave={source => log.push(`leave ${id} ${source}`)}
          onDrop={({ source }) => log.push(`drop ${id} ${source}`)}
        />
      ))}
      <Column id="plain" />
    </Window>
  );
}

describe("pointer drag and drop", () => {
  test("draggable and drop handlers compile to native flags", () => {
    const tree = compileTree(board([])());
    expect(tree.nodes.get("card")?.draggable).toBe(true);
    expect(tree.nodes.get("a")?.dropTarget).toBe(true);
    expect(tree.nodes.get("plain")?.dropTarget).toBeUndefined();
  });

  test("enter, leave and drop are derived from native moves", async () => {
    const bridge = new FakeBridge();
    const log: string[] = [];
    const app = createApp(board(log), { bridge });
    await app.ready;
    bridge.emit({ type: "dragStart", id: "card", x: 1, y: 2 });
    bridge.emit({ type: "dragMove", id: "card", x: 10, y: 2, over: "a" });
    bridge.emit({ type: "dragMove", id: "card", x: 11, y: 2, over: "a" });
    bridge.emit({ type: "dragMove", id: "card", x: 40, y: 2, over: "b" });
    bridge.emit({ type: "drop", id: "card", target: "b", x: 41, y: 3 });
    expect(log).toEqual([
      "start 1,2",
      "enter a card", "move a",
      "move a",
      "leave a card", "enter b card", "move b",
      "drop b card", "end b false 41,3",
    ]);
    app.close();
  });

  test("cancel leaves the hovered target and reports the last position", async () => {
    const bridge = new FakeBridge();
    const log: string[] = [];
    const app = createApp(board(log), { bridge });
    await app.ready;
    bridge.emit({ type: "dragStart", id: "card", x: 0, y: 0 });
    bridge.emit({ type: "dragMove", id: "card", x: 7, y: 8, over: "a" });
    bridge.emit({ type: "dragCancel", id: "card" });
    expect(log.slice(-2)).toEqual(["leave a card", "end null true 7,8"]);
    app.close();
  });

  test("dropping outside every target only ends the drag", async () => {
    const bridge = new FakeBridge();
    const log: string[] = [];
    const app = createApp(board(log), { bridge });
    await app.ready;
    bridge.emit({ type: "dragStart", id: "card", x: 0, y: 0 });
    bridge.emit({ type: "dragMove", id: "card", x: 5, y: 5, over: "a" });
    bridge.emit({ type: "dragMove", id: "card", x: 500, y: 5, over: null });
    bridge.emit({ type: "drop", id: "card", target: null, x: 500, y: 5 });
    expect(log.slice(-3)).toEqual(["leave a card", "move null", "end null false 500,5"]);
    app.close();
  });
});
