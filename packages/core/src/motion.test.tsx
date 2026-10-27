import { describe, expect, test } from "bun:test";
import { Window, View } from "./components";
import { theme } from "./theme";
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

  test("backdrop blur, filter blur and multiple backgrounds compile to their native forms", () => {
    const tree = compileTree(<Window>
      <View id="chip" style={{ backdropBlur: 12, background: "#ffffff22" }} />
      <View id="search" style={{ backdropFilter: "blur(20px) saturate(160%)" }} />
      <View id="glow" style={{ filter: "blur(90px)", background: "red", radius: 999 }} />
      <View id="app" style={{ background: "radial-gradient(circle at top, #ff000033, transparent 60%), linear-gradient(#111, #000)" }} />
      <View id="stack" style={{ background: theme.colors.background, backgroundLayers: ["linear-gradient(#0000, #000c)", theme.colors.muted] }} />
      <View id="tw" className="blur-xl backdrop-blur-sm" />
    </Window>);
    const style = (id: string) => tree.nodes.get(id)!.style as Record<string, any>;
    expect(style("chip").glass).toEqual({ blur: 12 });
    expect(style("chip").backdropBlur).toBeUndefined();
    expect(style("search").glass).toEqual({ blur: 20, saturate: 1.6 });
    expect(style("glow").filter).toEqual({ blur: 90 });
    expect(style("app").background.type).toBe("linear");
    expect(style("app").backgroundLayers).toHaveLength(1);
    expect(style("app").backgroundLayers[0].type).toBe("radial");
    expect(style("stack").backgroundLayers[1]).toMatch(/^#/);
    expect(style("tw")).toMatchObject({ filter: { blur: 24 }, glass: { blur: 8 } });
    expect(() => compileTree(<Window><View style={{ filter: "grayscale(1)" }} /></Window>)).toThrow("blur() and drop-shadow() only");
    const more = compileTree(<Window>
      <View id="icon" style={{ filter: "drop-shadow(0 2px 6px rgba(0, 0, 0, 0.5)) blur(2px)" }} />
      <View id="hero" style={{ maskImage: "linear-gradient(to bottom, black 60%, transparent)" }} />
    </Window>);
    const icon = more.nodes.get("icon")!.style as Record<string, any>;
    expect(icon.filter).toEqual({ blur: 2, dropShadow: { x: 0, y: 2, blur: 6, color: "#00000080" } });
    const hero = more.nodes.get("hero")!.style as Record<string, any>;
    expect(hero.maskImage.type).toBe("linear");
    expect(hero.maskImage.stops.at(-1).color).toBe("#00000000");
  });

  test("style.animation keyframes resolve CSS transforms and theme colours", () => {
    const tree = compileTree(<Window><View id="skeleton" style={{ animation: { from: { opacity: 0.4, transform: "scale(1.05)", background: theme.colors.muted }, to: { opacity: 1 }, duration: 1200, iterations: "infinite", direction: "alternate" } }} /></Window>);
    const animation = tree.nodes.get("skeleton")!.style.animation!;
    expect(animation).toMatchObject({ duration: 1200, iterations: "infinite", direction: "alternate", to: { opacity: 1 } });
    expect(animation.from.transform).toEqual({ scale: 1.05 });
    expect(animation.from.background).toMatch(/^#/);
  });

  test("transform enters from a CSS string and an exit transform is awaited", () => {
    const scope = {};
    const slide = (present: boolean) => (
      <Window title="motion">
        <AnimatePresence id="slide" present={present} enter={{ opacity: 0, transform: "translateY(12px)" }} exit={{ transform: { y: -8 } }}
          transition={{ transform: { duration: 120 }, opacity: { duration: 120 } }}>
          <View id="card" style={{ opacity: 1 }} />
        </AnimatePresence>
      </Window>
    );
    const entered = compileTree(slide(true), false, "auto", [], scope).nodes.get("card")!;
    expect(entered.motionFrom).toEqual({ opacity: 0, transform: { y: 12 } });
    const exiting = compileTree(slide(false), false, "auto", [], scope);
    expect(exiting.nodes.get("card")?.style.transform).toEqual({ y: -8 });
    exiting.handlers.get("card")!.onTransitionEnd!({ property: "transform" });
    expect(compileTree(slide(false), false, "auto", [], scope).nodes.has("card")).toBe(false);
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
