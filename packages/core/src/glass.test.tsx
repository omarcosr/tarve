import { describe, expect, test } from "bun:test";
import { Button, Glass, Input, over, Window } from "./components";
import { Switch } from "./controls";
import { Toggle, ToggleGroup } from "./form-controls";
import { Select } from "./select";
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

describe("glass prop", () => {
  test("Button glass is a capsule of control glass; destructive tints it, options pass a tint and appearance", () => {
    const tree = compileTree(
      <Window>
        <Button id="plain" glass>Save</Button>
        <Button id="danger" variant="destructive" glass="clear">Delete</Button>
        <Button id="prominent" glass={{ tint: "#007affd9", appearance: "dark" }}>Go</Button>
      </Window>,
    );
    const plain = tree.nodes.get("plain")!.style;
    expect(plain.glass).toMatchObject({ refraction: 30 });
    expect(plain.radius).toBe(18);
    expect(plain.borderWidth).toBe(0);
    expect(plain.active).toMatchObject({ transform: { scale: 1.07 }, glass: { refraction: 42 } });
    expect(plain.hover).toMatchObject({ glass: { refraction: 36 } });
    expect(tree.nodes.get("danger")!.style.glass).toMatchObject({ refraction: 26 });
    const prominent = tree.nodes.get("prominent")!.style;
    // The tint over the dark regular control veil.
    expect(prominent.background).toBe(over("#007affd9", "#00000059"));
    expect(prominent.foreground).toBe("#ffffff");
  });

  test("Toggle, ToggleGroup, Select, Switch and Input take glass", () => {
    const tree = compileTree(
      <Window>
        <Toggle id="toggle" pressed glass={{ tint: "#ff9500" }}>Bold</Toggle>
        <ToggleGroup id="group" value="b" glass items={[{ value: "a", label: "A" }, { value: "b", label: "B" }]} />
        <Select id="select" value="a" glass options={[{ value: "a", label: "A" }]} />
        <Switch id="switch" label="Wi-Fi" checked glass />
        <Input id="input" glass value="" />
      </Window>,
    );
    expect(tree.nodes.get("toggle")!.style.background).toBe("#ff9500");
    expect(tree.nodes.get("group")!.style.glass).toBeDefined();
    // One lens slides under the chosen item; the items themselves stay clear.
    // Segments are equal grid columns sized natively; the lens fills the chosen one.
    expect(tree.nodes.get("group")!.style).toMatchObject({ display: "grid", columns: "repeat(2, 1fr)", align: "stretch" });
    expect(tree.nodes.get("group-item-a")!.style.width).toBeUndefined();
    expect(tree.nodes.get("group-lens-1")!.style).toMatchObject({ gridColumn: "2", gridRow: "1" });
    expect(tree.nodes.get("group-item-b")!.style).toMatchObject({ gridColumn: "2", gridRow: "1" });
    expect(tree.nodes.get("group-lens-1")!.style.glass).toMatchObject({ refraction: 24 });
    expect(tree.nodes.get("group-lens-1")!.style.transition).toMatchObject({ transform: { easing: "spring" } });
    expect(tree.nodes.get("group-item-b")!.style.glass).toBeUndefined();
    // The others raise a drop under the pointer: always there, faded out, it springs in on hover.
    expect(tree.nodes.get("group-item-a")!.style.group).toBe(true);
    expect(tree.nodes.get("group-item-b")!.style.group).toBe(false);
    expect(tree.nodes.get("group-item-a")!.style.background).toBe("#00000000");
    expect(tree.nodes.get("select-trigger")!.style.glass).toBeDefined();
    expect(tree.nodes.get("switch")!.style.minHeight).toBe(32);
    expect(tree.nodes.get("input")!.style.glass).toBeDefined();
    expect(tree.nodes.get("input")!.style.radius).toBe(19);
  });

  test("a glass Select's options put the check in a leading column and raise a drop of glass on hover", () => {
    const tree = compileTree(
      <Window>
        <Select id="s" open value="b" glass={{ appearance: "dark" }} options={[{ value: "a", label: "A" }, { value: "b", label: "B" }, { value: "c", label: "C", disabled: true }]} />
      </Window>,
    );
    const b = tree.nodes.get("s-option-b")!.style;
    expect(b.group).toBe(true);
    const drops = [...tree.nodes.values()].filter(node => node.style.groupHover !== undefined);
    expect(drops).toHaveLength(2);
    // The drop takes the popup's frost, under a veil a step lighter than the popup's.
    expect(drops[0]!.style).toMatchObject({ opacity: 0, background: over("#ffffff1f", "#1c1c1e73"), groupHover: { opacity: 1 }, glass: { refraction: 16, blur: 26 } });
    expect(b.radius).toBe(13);
    expect(tree.nodes.get("s-option-c")!.style.group).toBe(false);
  });

  test("a new choice lays the lens in its cell and springs it in from the old one, stretched", () => {
    let value = "a";
    const view = () => compileTree(
      <Window>
        <ToggleGroup id="seg" value={value} glass items={[{ value: "a", label: "A" }, { value: "b", label: "Bee" }, { value: "c", label: "C" }]} />
      </Window>,
    );
    expect(view().nodes.get("seg-lens-0")!.motionFrom).toBeUndefined();
    value = "c";
    const moved = view().nodes.get("seg-lens-2")!;
    expect(moved.style.gridColumn).toBe("3");
    expect(moved.motionFrom).toEqual({ transform: { xPercent: -200, scaleX: 1.24, originX: 0 } });
    value = "b";
    expect(view().nodes.get("seg-lens-1")!.motionFrom).toEqual({ transform: { xPercent: 100, scaleX: 1.12, originX: 1 } });
  });
});
