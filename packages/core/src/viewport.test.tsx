import { afterEach, describe, expect, test } from "bun:test";
import { Column, View, Window } from "./components";
import { memo } from "./memo";
import { compileTree } from "./reconciler";
import { tw } from "./tailwind";
import { environmentKey, setEnvironment, trackViewport, viewport } from "./viewport";

const desktop = { fontScale: 1, reducedMotion: false, pointer: "fine" as const };
afterEach(() => setEnvironment(desktop));

describe("viewport", () => {
  test("portrait and landscape fold by the window's shape", () => {
    const view = (width: number, height: number) => compileTree(
      <Window><View id="box" style={{ width: 1, portrait: { width: 10 }, landscape: { width: 20 } }} /></Window>,
      false, "auto", [], undefined, true, { width, height });
    const tall = view(400, 800);
    expect(tall.nodes.get("box")!.style.width).toBe(10);
    expect(tall.document.root.reportSize).toBe(true);
    expect(view(800, 400).nodes.get("box")!.style.width).toBe(20);
  });

  test("pointer and motion variants fold by the system environment", () => {
    const style = { minHeight: 32, pointerCoarse: { minHeight: 48 }, motionReduce: { opacity: 1 }, motionSafe: { opacity: 0.5 } };
    const view = () => compileTree(<Window><View id="target" style={style} /></Window>).nodes.get("target")!.style;
    expect(view()).toMatchObject({ minHeight: 32, opacity: 0.5 });
    setEnvironment({ fontScale: 1.5, reducedMotion: true, pointer: "coarse" });
    expect(view()).toMatchObject({ minHeight: 48, opacity: 1 });
  });

  test("a memoized subtree with environment variants recompiles when the environment changes", () => {
    let renders = 0;
    const Target = memo(() => { renders++; return <Column id="target" style={{ padding: 4, pointerCoarse: { padding: 12 } }} />; });
    const scope = {};
    const view = () => compileTree(<Window><Target /></Window>, false, "auto", [], scope, true, { width: 400, height: 800 });
    expect(view().nodes.get("target")!.style.padding).toBe(4);
    view();
    expect(renders).toBe(1);
    setEnvironment({ fontScale: 1, reducedMotion: false, pointer: "coarse" });
    expect(view().nodes.get("target")!.style.padding).toBe(12);
    expect(renders).toBe(2);
  });

  test("viewport() reports the size, shape and environment, and what a render read", () => {
    setEnvironment({ fontScale: 1.3, reducedMotion: false, pointer: "coarse" });
    const read = trackViewport({ width: 411, height: 860 }, () => viewport());
    expect(read.value).toEqual({ width: 411, height: 860, orientation: "portrait", pointer: "coarse", fontScale: 1.3, reducedMotion: false });
    expect(read.readSize && read.readEnvironment).toBe(true);
    expect(trackViewport({ width: 1, height: 1 }, () => 0).readSize).toBe(false);
    expect(environmentKey()).toBe("1.3|false|coarse");
  });

  test("a memoized subtree that reads viewport() recompiles on any resize", () => {
    let renders = 0;
    const Size = memo(() => { renders++; return <View id="size" style={{ width: viewport().width / 2 }} />; });
    const scope = {};
    const view = (width: number) => trackViewport({ width, height: 600 }, () =>
      compileTree(<Window><Size /></Window>, false, "auto", [], scope, true, { width, height: 600 })).value;
    expect(view(400).nodes.get("size")!.style.width).toBe(200);
    expect(view(400).document.root.reportSize).toBe(true);
    expect(renders).toBe(1);
    expect(view(420).nodes.get("size")!.style.width).toBe(210);
    expect(renders).toBe(2);
  });

  test("Tailwind's orientation, pointer and motion variants", () => {
    expect(tw("portrait:flex-col landscape:flex-row pointer-coarse:min-h-12 pointer-fine:min-h-8 motion-reduce:transition-none motion-safe:opacity-50")).toMatchObject({
      portrait: { direction: "column" }, landscape: { direction: "row" },
      pointerCoarse: { minHeight: 48 }, pointerFine: { minHeight: 32 },
      motionSafe: { opacity: 0.5 },
    });
  });
});
