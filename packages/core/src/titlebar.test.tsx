import { describe, expect, test } from "bun:test";
import { TitleBar, Window } from "./components";
import { compileTree } from "./reconciler";

describe("TitleBar", () => {
  test("buttonStyle shapes every window control and keeps their actions", () => {
    const tree = compileTree(<Window><TitleBar id="bar" showMaximize={false} buttonStyle={{ width: 36, height: 36, radius: 18 }} /></Window>);
    const buttons = [...tree.nodes.values()].filter(node => node.windowAction);
    expect(buttons.map(node => node.windowAction)).toEqual(["minimize", "close"]);
    for (const button of buttons) expect([button.style.width, button.style.height, button.style.radius]).toEqual([36, 36, 18]);
    expect(tree.document.window.decorations).toBe(false);
  });

  test("glass makes the bar a glass surface with round controls and the appearance's ink", () => {
    const tree = compileTree(<Window><TitleBar id="bar" glass="clear" appearance="dark" title="Music" /></Window>);
    const bar = tree.nodes.get("bar")!.style;
    expect(bar.glass).toEqual({ blur: 2, saturate: 1.25, refraction: 28, highlight: 0.55, magnify: 0.1 });
    expect(bar.background).toBe("#00000014");
    expect(bar.radius).toBe(0);
    expect(bar.foreground).toBe("#ffffff");
    const close = [...tree.nodes.values()].find(node => node.windowAction === "close")!;
    expect([close.style.width, close.style.radius]).toEqual([36, 18]);
    // `glass` alone is the regular material.
    expect(compileTree(<Window><TitleBar id="bar" glass /></Window>).nodes.get("bar")!.style.glass).toMatchObject({ blur: 8 });
  });
});
