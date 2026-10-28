import { describe, expect, test } from "bun:test";
import { Text, TitleBar, Window } from "./components";
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
    expect(bar.borderWidth).toEqual({ bottom: 1 });
    expect(bar.boxShadow).toHaveLength(2);
    // `glass` alone is the regular material.
    expect(compileTree(<Window><TitleBar id="bar" glass /></Window>).nodes.get("bar")!.style.glass).toMatchObject({ blur: 8 });
  });

  test("a glass bar with a radius is a floating capsule: full rim, shadow, clipped corners", () => {
    const tree = compileTree(<Window><TitleBar id="bar" glass style={{ radius: 22 }} /></Window>);
    const bar = tree.nodes.get("bar")!.style;
    expect(bar.radius).toBe(22);
    expect(bar.borderWidth).toBe(1);
    expect(bar.boxShadow).toHaveLength(4);
    expect(bar.overflow).toBe("hidden");
  });

  test("onBack draws a labelled back button before the title, actions sit before the window controls", () => {
    const tree = compileTree(<Window><TitleBar id="bar" title="Album" onBack={() => {}} actions={<Text id="action">Share</Text>} /></Window>);
    const nodes = [...tree.nodes.values()];
    const back = nodes.find(node => node.control?.label === "Back")!;
    expect(back).toBeDefined();
    expect(tree.nodes.get("bar")!.dragRegion).toBe(true);
    const order = nodes.map(node => node.id);
    expect(order.indexOf(back.id)).toBeLessThan(order.indexOf("action"));
    const close = nodes.find(node => node.windowAction === "close")!;
    expect(order.indexOf("action")).toBeLessThan(order.indexOf(close.id));
  });
});

test("window control hovers are a wash, not the glyph colour; close turns its glyph white", () => {
  const tree = compileTree(<Window><TitleBar title="x" /></Window>);
  const nodes = [...tree.nodes.values()] as any[];
  const buttons = nodes.filter(node => node.windowAction);
  const glyphs = nodes.filter(node => node.kind === "svg");
  expect(buttons).toHaveLength(3);
  for (const [index, button] of buttons.entries()) {
    expect(button.style.hover.background).not.toBe(glyphs[index].style.foreground);
  }
  expect(buttons[0].style.hover.background).toMatch(/^#[0-9a-f]{6}1f$/);
  expect(glyphs[2].style.groupHover).toEqual({ foreground: "#ffffff" });
  const rgba = [...compileTree(<Window><TitleBar title="x" style={{ foreground: "rgba(255, 255, 255, 0.9)" }} /></Window>).nodes.values()] as any[];
  expect(rgba.find(node => node.windowAction === "minimize").style.hover.background).toBe("#ffffff1f");
});
