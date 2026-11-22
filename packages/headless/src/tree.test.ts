import { describe, expect, test } from "bun:test";
import { SceneTreeMirror, type SceneNode } from "./tree";

describe("SceneTreeMirror", () => {
  test("setNodes sets texts and style values over the nodes' own", () => {
    const mirror = new SceneTreeMirror();
    mirror.reset({ id: "root", kind: "window", style: {}, children: [
      { id: "a", kind: "text", style: { flex: 1, foreground: "#000" }, children: [], text: "Count: 0" },
    ] } as SceneNode);
    const before = mirror.version;
    mirror.apply({ type: "setNodes", nodes: [{ id: "a", text: "Count: 1" }, { id: "a", style: { foreground: "#f00" } }, { id: "gone", text: "x" }] } as never);
    const node = mirror.root()!.children[0]!;
    expect(node.text).toBe("Count: 1");
    expect(node.style).toEqual({ flex: 1, foreground: "#f00" });
    expect(mirror.version).toBe(before + 1);
  });
});
