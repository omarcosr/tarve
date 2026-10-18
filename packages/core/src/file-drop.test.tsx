import { describe, expect, test } from "bun:test";
import { View, Window, Text } from "./components";
import { createApp } from "./app";
import { compileTree } from "./reconciler";
import type { NativeBridge } from "./bridge";
import type { NativeCommand, NativeEvent, SceneDocument } from "./protocol";

describe("system file drops", () => {
  test("a file drop handler makes the node a file drop target", () => {
    const tree = compileTree(<Window><View id="zone" onFileDrop={() => {}}><Text>drop</Text></View><View id="plain" /></Window>);
    expect(tree.nodes.get("zone")?.fileDropTarget).toBe(true);
    expect(tree.nodes.get("plain")?.fileDropTarget).toBeUndefined();
  });

  test("enter, leave and drop reach the target's handlers", async () => {
    let onEvent!: (event: NativeEvent) => void;
    const bridge: NativeBridge = {
      start(_document: SceneDocument, listener) { onEvent = listener; listener({ type: "ready" }); },
      send(_command: NativeCommand) {},
      join() {},
    };
    const log: unknown[] = [];
    const app = createApp(() => (
      <Window>
        <View id="zone" onFileDragEnter={paths => log.push(["enter", paths])} onFileDragLeave={() => log.push(["leave"])}
          onFileDrop={event => log.push(["drop", event])} />
      </Window>
    ), { bridge });
    await app.ready;
    const outside: unknown[] = [];
    app.onEvent(event => { if (event.type === "fileDrop" && !("id" in event)) outside.push(event.paths); });
    onEvent({ type: "fileDragEnter", id: "zone", paths: ["C:/a.txt"] });
    onEvent({ type: "fileDragLeave", id: "zone" });
    onEvent({ type: "fileDrop", id: "zone", paths: ["C:/a.txt", "C:/b.png"], x: 4, y: 5 });
    onEvent({ type: "fileDrop", paths: ["C:/c.txt"], x: 1, y: 1 });
    expect(log).toEqual([["enter", ["C:/a.txt"]], ["leave"], ["drop", { paths: ["C:/a.txt", "C:/b.png"], x: 4, y: 5 }]]);
    expect(outside).toEqual([["C:/c.txt"]]);
    app.close();
  });
});
