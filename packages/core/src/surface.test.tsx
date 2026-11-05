import { describe, expect, test } from "bun:test";
import { Surface, Window } from "./index";
import { compileTree } from "./reconciler";
import { surfaceController, trackSurfaceHandles } from "./surface";
import type { NativeCommand } from "./protocol";

describe("<surface>", () => {
  test("compiles to a native surface node whose onSurface is a handler", () => {
    const onSurface = () => {};
    const tree = compileTree(
      <Window title="t">
        <surface id="player" style={{ width: 320, height: 180 }} onSurface={onSurface} />
        <Surface id="game" native style={{ flex: 1 }} />
      </Window>,
    );
    expect(tree.nodes.get("player")?.kind).toBe("surface");
    expect(tree.nodes.get("game")?.kind).toBe("surface");
    expect(tree.handlers.get("player")?.onSurface).toBe(onSurface);
    expect(tree.nodes.get("player")?.native).toBeUndefined();
    expect(tree.nodes.get("game")?.native).toBe(true);
  });

  test("the controller attaches a swap chain pointer and detaches it", () => {
    const sent: NativeCommand[] = [];
    const surface = surfaceController("player", command => sent.push(command));
    surface.attach(0x1234n);
    surface.attach("0xbeef");
    surface.attach(42);
    surface.detach();
    expect(sent).toEqual([
      { type: "surface", id: "player", action: "attach", swapChain: "4660" },
      { type: "surface", id: "player", action: "attach", swapChain: "0xbeef" },
      { type: "surface", id: "player", action: "attach", swapChain: "42" },
      { type: "surface", id: "player", action: "detach" },
    ]);
    expect(() => surface.attach(2 ** 60)).toThrow();
  });

  test("present needs a frames handle, which surface events keep", () => {
    const handles = new Map<string, bigint>();
    const surface = surfaceController("player", () => {}, id => handles.get(id));
    expect(surface.present(new Uint8Array(16), 2, 2)).toBe(false);
    const base = { type: "surface", id: "player", width: 2, height: 2, scale: 1 } as const;
    trackSurfaceHandles(handles, { ...base, event: "ready", handle: "7", handleType: "TarveFrames" });
    expect(handles.get("player")).toBe(7n);
    expect(() => surface.present(new Uint8Array(8), 2, 2)).toThrow(RangeError);
    trackSurfaceHandles(handles, { ...base, event: "ready", handle: "9", handleType: "ISwapChainPanelNative" });
    expect(handles.has("player")).toBe(false);
    trackSurfaceHandles(handles, { ...base, event: "ready", handle: "8", handleType: "TarveFrames" });
    trackSurfaceHandles(handles, { ...base, event: "destroyed" });
    expect(handles.has("player")).toBe(false);
  });
});
