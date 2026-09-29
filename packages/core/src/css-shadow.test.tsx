import { describe, expect, test } from "bun:test";
import { Column, Text, Window } from "./components";
import { cssColor, normalizeGradient, parseBoxShadow, parseGradient, parseTextShadow, parseTransform } from "./css-shadow";
import { lightTheme, resolveThemeStyle } from "./theme";
import { compileTree } from "./reconciler";
import { darkTheme, theme } from "./theme";

describe("CSS shadow syntax", () => {
  test("colours convert to #rrggbbaa", () => {
    expect(cssColor("#abc")).toBe("#aabbcc");
    expect(cssColor("#abcd")).toBe("#aabbccdd");
    expect(cssColor("rgba(0, 0, 0, 0.2)")).toBe("#00000033");
    expect(cssColor("rgb(255 128 0 / 50%)")).toBe("#ff800080");
    expect(cssColor("hsl(0, 100%, 50%)")).toBe("#ff0000ff");
    expect(cssColor("transparent")).toBe("#00000000");
    expect(cssColor("var(--ring)")).toBe("var(--ring)");
    expect(() => cssColor("constructor")).toThrow("Unsupported colour");
  });

  test("box-shadow lists, inset in any position, defaults and none", () => {
    expect(parseBoxShadow("inset 0 1px 2px rgba(0,0,0,.2), 0 8px 24px -4px #0003")).toEqual([
      { x: 0, y: 1, blur: 2, spread: 0, color: "#00000033", inset: true },
      { x: 0, y: 8, blur: 24, spread: -4, color: "#00000033" },
    ]);
    expect(parseBoxShadow("2px 2px red inset")).toEqual([{ x: 2, y: 2, blur: 0, spread: 0, color: "#ff0000", inset: true }]);
    expect(parseBoxShadow("3px 4px")).toEqual([{ x: 3, y: 4, blur: 0, spread: 0, color: "#000000" }]);
    expect(parseBoxShadow("none")).toEqual([]);
  });

  test("invalid box-shadow strings throw", () => {
    expect(() => parseBoxShadow("2px")).toThrow("x and y");
    expect(() => parseBoxShadow("1em 2px #000")).toThrow();
    expect(() => parseBoxShadow("1px 1px -2px #000")).toThrow("negative");
    expect(() => parseBoxShadow("1px 1px 1px 1px 1px #000")).toThrow("Too many");
    expect(() => parseBoxShadow("1px 1px #000 #fff")).toThrow("Unexpected");
  });

  test("text-shadow takes one solid shadow", () => {
    expect(parseTextShadow("1px 2px #0006")).toEqual({ x: 1, y: 2, color: "#00000066" });
    expect(parseTextShadow("1px 2px 0 red")).toEqual({ x: 1, y: 2, color: "#ff0000" });
    expect(parseTextShadow("none")).toBeUndefined();
    expect(() => parseTextShadow("1px 1px 3px #000")).toThrow("blur");
    expect(() => parseTextShadow("1px 1px #000, 2px 2px #fff")).toThrow("single");
  });

  test("strings are normalized in base and state styles with theme tokens resolved", () => {
    const tree = compileTree(<Window theme={darkTheme}>
      <Column id="card" style={{
        boxShadow: `0 4px 12px ${theme.colors.border}`,
        hover: { boxShadow: "inset 0 0 0 2px rgba(37, 99, 235, 0.5)", textShadow: "1px 1px #000" },
      }}>
        <Text id="label" style={{ textShadow: "none" }}>Hi</Text>
      </Column>
    </Window>);
    const card = tree.nodes.get("card")!.style;
    expect(card.boxShadow).toEqual([{ x: 0, y: 4, blur: 12, spread: 0, color: darkTheme.colors.border }]);
    expect(card.hover?.boxShadow).toEqual([{ x: 0, y: 0, blur: 0, spread: 2, color: "#2563eb80", inset: true }]);
    expect(card.hover?.textShadow).toEqual({ x: 1, y: 1, color: "#000000" });
    expect(tree.nodes.get("label")!.style.textShadow).toBeUndefined();
  });

  test("transform syntax composes translate and scale like CSS", () => {
    expect(parseTransform("translateY(-2px) scale(1.02)")).toEqual({ y: -2, scale: 1.02 });
    expect(parseTransform("scale(2) translateX(10px)")).toEqual({ x: 20, scale: 2 });
    expect(parseTransform("translate(4px, 0) scaleX(2) scaleY(0.5)")).toEqual({ x: 4, scaleX: 2, scaleY: 0.5 });
    expect(parseTransform("none")).toEqual({});
    expect(() => parseTransform("rotate(10deg)")).toThrow("translate and scale only");
    expect(() => parseTransform("scale(0)")).toThrow("Invalid scale");
    expect(() => parseTransform("translateX(1em)")).toThrow("length");
    expect(() => parseTransform("scale(2) junk")).toThrow("Invalid transform");
    const tree = compileTree(<Window><Column id="c" style={{ hover: { transform: "translateY(-4px)" } }} /></Window>);
    expect(tree.nodes.get("c")!.style.hover?.transform).toEqual({ y: -4 });
  });
});

describe("CSS gradients", () => {
  test("linear-gradient syntax", () => {
    expect(parseGradient("linear-gradient(135deg, #2563eb, rgb(147 51 234) 80%)")).toEqual({
      type: "linear", angle: 135, stops: [{ color: "#2563eb" }, { color: "rgb(147 51 234)", offset: 0.8 }],
    });
    expect(parseGradient("linear-gradient(0.25turn, red, blue)")).toMatchObject({ angle: 90 });
    expect(parseGradient("linear-gradient(to right top, red, blue)")).toMatchObject({ to: "top right" });
    expect(parseGradient("linear-gradient(red, blue)")).toEqual({ type: "linear", stops: [{ color: "red" }, { color: "blue" }] });
    expect(parseGradient("linear-gradient(red 0 50%, blue 12px)").stops).toEqual([
      { color: "red", offset: 0 }, { color: "red", offset: 0.5 }, { color: "blue", offset: "12px" },
    ]);
    expect(() => parseGradient("linear-gradient(to top bottom, red, blue)")).toThrow("direction");
    expect(() => parseGradient("linear-gradient(red 1em, blue)")).toThrow("px or %");
  });

  test("repeating gradients", () => {
    expect(parseGradient("repeating-linear-gradient(45deg, #000 0 10px, #fff 10px 20px)")).toEqual({
      type: "linear", angle: 45, repeating: true,
      stops: [{ color: "#000", offset: 0 }, { color: "#000", offset: "10px" }, { color: "#fff", offset: "10px" }, { color: "#fff", offset: "20px" }],
    });
    expect(parseGradient("repeating-radial-gradient(circle 40px, red, blue 10%)")).toMatchObject({ type: "radial", shape: "circle", size: "40px", repeating: true });
  });

  test("radial-gradient syntax", () => {
    expect(parseGradient("radial-gradient(#fff, #000)")).toEqual({ type: "radial", stops: [{ color: "#fff" }, { color: "#000" }] });
    expect(parseGradient("radial-gradient(circle at top left, #fff, #000)")).toMatchObject({ shape: "circle", at: { x: 0, y: 0 } });
    expect(parseGradient("radial-gradient(ellipse farthest-corner at 25% 75%, #fff, #000)")).toMatchObject({ shape: "ellipse", size: "farthest-corner", at: { x: 0.25, y: 0.75 } });
    expect(parseGradient("radial-gradient(closest-side, #fff, #000)")).toMatchObject({ size: "closest-side" });
    expect(parseGradient("radial-gradient(30px, #fff, #000)")).toMatchObject({ shape: "circle", size: "30px" });
    expect(parseGradient("radial-gradient(50% 10px at center, #fff, #000)")).toMatchObject({ shape: "ellipse", size: ["50%", "10px"], at: { x: 0.5, y: 0.5 } });
    expect(parseGradient("radial-gradient(at 10px 20%, #fff, #000)")).toMatchObject({ at: { x: "10px", y: 0.2 } });
    expect(parseGradient("radial-gradient(at right 10px bottom 25%, #fff, #000)")).toMatchObject({ at: { x: "10px", xEdge: "right", y: 0.75 } });
    expect(parseGradient("radial-gradient(at left 15% top 4px, #fff, #000)")).toMatchObject({ at: { x: 0.15, y: "4px" } });
    expect(parseGradient("radial-gradient(at bottom 5px center, #fff, #000)")).toMatchObject({ at: { x: 0.5, y: "5px", yEdge: "bottom" } });
    expect(parseGradient("radial-gradient(at top right, #fff, #000)")).toMatchObject({ at: { x: 1, y: 0 } });
    expect(() => parseGradient("radial-gradient(at left right, #fff, #000)")).toThrow("position");
    expect(() => parseGradient("radial-gradient(at center 5px top, #fff, #000)")).toThrow("position");
    expect(() => parseGradient("radial-gradient(circle 50%, #fff, #000)")).toThrow("circle");
    expect(() => parseGradient("radial-gradient(ellipse 10px, #fff, #000)")).toThrow("ellipse");
    expect(() => parseGradient("radial-gradient(closest-side 10px, #fff, #000)")).toThrow("not both");
  });

  test("normalization resolves colours and percentages but leaves px and gaps to the native side", () => {
    const stops = normalizeGradient({ type: "linear", stops: ["red", { color: "blue", offset: "20%" }, { color: "white", offset: "8px" }] }, cssColor).stops;
    expect(stops).toEqual([{ color: "#ff0000" }, { color: "#0000ff", offset: 0.2 }, { color: "#ffffff", offset: "8px" }]);
    expect(() => normalizeGradient({ type: "linear", stops: [{ color: "red", offset: "2em" as "2px" }] }, cssColor)).toThrow("px or %");
    expect(normalizeGradient({ type: "linear", stops: ["red"] }, cssColor).stops).toHaveLength(2);
  });

  test("styles resolve gradient strings, objects and theme tokens, including states", () => {
    const resolved = resolveThemeStyle({
      background: "linear-gradient(to right, var(--primary), transparent)",
      hover: { background: { type: "radial", stops: ["#fff", "#000"] } },
    }, lightTheme);
    expect(resolved.background as unknown).toEqual({
      type: "linear", to: "right",
      stops: [{ color: resolveThemeStyle({ background: "var(--primary)" }, lightTheme).background }, { color: "#00000000" }],
    });
    expect(resolved.hover?.background).toEqual({ type: "radial", stops: [{ color: "#ffffff" }, { color: "#000000" }] });
    expect(resolveThemeStyle({ background: "repeating-linear-gradient(red 0 4px, blue 4px 8px)" }, lightTheme).background).toMatchObject({ repeating: true });
  });
});
