import { describe, expect, test } from "bun:test";
import { Window, View } from "./components";
import { AnimatePresence } from "./motion";
import { compileTree } from "./reconciler";
import { withRenderScope } from "./render-scope";

const view = (present: boolean, onEnd?: (event: { property: string }) => void) => (
  <Window title="motion">
    <AnimatePresence id="toast" present={present} enter={{ opacity: 0 }} exit={{ opacity: 0 }} transition={{ opacity: { duration: 100 } }}>
      <View id="box" style={{ opacity: 1, width: 40 }} onTransitionEnd={onEnd as never} />
    </AnimatePresence>
  </Window>
);

describe("AnimatePresence", () => {
  test("a present child mounts with its enter values as motionFrom", () => {
    const tree = compileTree(view(true));
    const box = tree.nodes.get("box")!;
    expect(box.motionFrom).toEqual({ opacity: 0 });
    expect(box.style.opacity).toBe(1);
  });

  test("an absent child is kept with its exit targets until every awaited property completes", () => {
    const scope = {};
    const ended: string[] = [];
    const onEnd = (event: { property: string }) => { ended.push(event.property); };
    compileTree(view(true, onEnd), false, "auto", [], scope);
    const exiting = compileTree(view(false, onEnd), false, "auto", [], scope);
    const box = exiting.nodes.get("box")!;
    expect(box.style.opacity).toBe(0);
    expect(box.style.transition).toEqual({ opacity: { duration: 100 } });
    // A property that was not animated does not remove the node.
    exiting.handlers.get("box")!.onTransitionEnd!({ property: "width" });
    expect(compileTree(view(false, onEnd), false, "auto", [], scope).nodes.has("box")).toBe(true);
    exiting.handlers.get("box")!.onTransitionEnd!({ property: "opacity" });
    expect(compileTree(view(false, onEnd), false, "auto", [], scope).nodes.has("box")).toBe(false);
    // The child's own handler still ran for both.
    expect(ended).toEqual(["width", "opacity"]);
  });

  test("becoming present again during an exit cancels it", () => {
    const scope = {};
    compileTree(view(true), false, "auto", [], scope);
    compileTree(view(false), false, "auto", [], scope);
    const back = compileTree(view(true), false, "auto", [], scope);
    expect(back.nodes.get("box")!.style.opacity).toBe(1);
    // Completing the stale exit no longer removes anything.
    const again = compileTree(view(false), false, "auto", [], scope);
    expect(again.nodes.get("box")!.style.opacity).toBe(0);
  });

  test("removes at once when nothing needs animating", () => {
    const scope = {};
    const still = (present: boolean) => (
      <Window title="motion">
        <AnimatePresence id="toast" present={present} exit={{ opacity: 1 }}>
          <View id="box" style={{ opacity: 1 }} />
        </AnimatePresence>
      </Window>
    );
    compileTree(still(true), false, "auto", [], scope);
    expect(compileTree(still(false), false, "auto", [], scope).nodes.has("box")).toBe(false);
  });

  test("forgets a boundary that two renders skipped", () => {
    const scope = {};
    compileTree(view(true), false, "auto", [], scope);
    const empty = <Window title="motion"><View id="other" /></Window>;
    compileTree(empty, false, "auto", [], scope);
    compileTree(empty, false, "auto", [], scope);
    // No retained child: the exit has nothing to animate.
    expect(compileTree(view(false), false, "auto", [], scope).nodes.has("box")).toBe(false);
  });

  test("each render scope has its own presence state", () => {
    const a = {}, b = {};
    compileTree(view(true), false, "auto", [], a);
    expect(compileTree(view(false), false, "auto", [], b).nodes.has("box")).toBe(false);
    expect(compileTree(view(false), false, "auto", [], a).nodes.has("box")).toBe(true);
  });

  test("validates its id and single child", () => {
    expect(() => withRenderScope({}, () => AnimatePresence({ id: "", present: true, exit: {}, children: <View /> }))).toThrow(TypeError);
    expect(() => withRenderScope({}, () => AnimatePresence({ id: "x", present: true, exit: {}, children: [<View />, <View />] as never }))).toThrow(TypeError);
  });
});
