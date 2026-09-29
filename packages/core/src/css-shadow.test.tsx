import { describe, expect, test } from "bun:test";
import { Column, Text, Window } from "./components";
import { cssColor, parseBoxShadow, parseTextShadow, parseTransform } from "./css-shadow";
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
