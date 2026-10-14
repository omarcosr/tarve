import { describe, expect, test } from "bun:test";
import { Glass, Window } from "./components";
import { compileTree } from "./reconciler";

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
    expect(style.background).toBe("#ff000040");
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
  });
});
