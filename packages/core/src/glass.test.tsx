import { describe, expect, test } from "bun:test";
import { Glass, over, Window } from "./components";
import { compileTree } from "./reconciler";

describe("over", () => {
  test("composites a hex colour over another, source-over", () => {
    expect(over("#ff0000", "#0000ff")).toBe("#ff0000ff");
    expect(over("#ff000080", "#0000ff")).toBe("#80007fff");
    expect(over("#fff", "#00000000")).toBe("#ffffffff");
    expect(over("#00000000", "#00000000")).toBe("#00000000");
  });

  test("leaves anything that is not a hex colour alone", () => {
    expect(over("linear-gradient(90deg, #fff, #000)", "#ffffff59")).toBe("linear-gradient(90deg, #fff, #000)");
    expect(over("#ff0000", "red")).toBe("#ff0000");
  });
});

describe("Glass", () => {
  test("declares the material with the veil as its tint and the rim as chrome", () => {
    const tree = compileTree(<Window><Glass id="bar" /></Window>);
    const style = tree.nodes.get("bar")!.style;
    expect(style.glass).toEqual({ blur: 8, saturate: 1.6, refraction: 22, highlight: 1, magnify: 0.06 });
    expect(style.background).toBe("#ffffff59");
    expect(style.radius).toBe(26);
    expect(style.borderWidth).toBe(1);
    expect(Array.isArray(style.boxShadow) && style.boxShadow.length).toBe(4);
  });

  test("variants, appearance and overrides change the material and veil", () => {
    const tree = compileTree(
      <Window>
        <Glass id="clear" variant="clear" appearance="dark" shadow={false} material={{ blur: 4 }} tint="#ff000040" radius={12} style={{ width: 10 }} />
      </Window>,
    );
    const style = tree.nodes.get("clear")!.style;
    expect(style.glass).toEqual({ blur: 4, saturate: 1.25, refraction: 28, highlight: 0.55, magnify: 0.1 });
    // The tint over the dark clear veil `#00000014`.
    expect(style.background).toBe(over("#ff000040", "#00000014"));
    expect(style.background).toBe("#cf00004f");
    expect(style.radius).toBe(12);
    expect(style.width).toBe(10);
    expect(Array.isArray(style.boxShadow) && style.boxShadow.length).toBe(2);
    expect(style.borderColor).toBe("#ffffff26");
  });

  test("merge names the surface the box fuses with and blend how far it bridges", () => {
    const tree = compileTree(
      <Window>
        <Glass id="dock" merge="dock" />
        <Glass id="drop" merge="dock" blend={48} material={{ blend: 12 }} />
      </Window>,
    );
    expect(tree.nodes.get("dock")!.style.glass).toMatchObject({ merge: "dock", blend: 32 });
    expect(tree.nodes.get("drop")!.style.glass).toMatchObject({ merge: "dock", blend: 12 });
    // No outline of its own: the fused surface is lit by the shader.
    expect(tree.nodes.get("drop")!.style.borderWidth).toBe(0);
    expect(tree.nodes.get("drop")!.style.boxShadow).toEqual([]);
  });
});
