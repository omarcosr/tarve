import { describe, expect, test } from "bun:test";
import { Column, Window } from "./components";
import { compileTree } from "./reconciler";
import { darkTheme, theme } from "./theme";

describe("shadow styles", () => {
  test("box and text shadow colours resolve theme tokens, including lists and states", () => {
    const tree = compileTree(<Window theme={darkTheme}>
      <Column id="card" style={{
        boxShadow: [{ y: 2, blur: 8, color: theme.colors.border }, { inset: true, blur: 4, color: "#123456" }],
        textShadow: { x: 1, color: theme.colors.primary },
        hover: { boxShadow: { blur: 12, color: theme.colors.ring } },
      }} />
    </Window>);
    const style = tree.nodes.get("card")!.style;
    expect(style.boxShadow).toEqual([
      { y: 2, blur: 8, color: darkTheme.colors.border },
      { inset: true, blur: 4, color: "#123456" },
    ]);
    expect(style.textShadow).toEqual({ x: 1, color: darkTheme.colors.primary });
    expect(style.hover?.boxShadow).toEqual({ blur: 12, color: darkTheme.colors.ring });
  });

  test("CSS colours work in every colour property, including states and the window", () => {
    const tree = compileTree(<Window style={{ background: "rgb(240 240 240)" }}>
      <Column id="box" style={{
        background: "rgba(255, 0, 0, 0.5)", borderColor: "hsl(120, 100%, 25%)", foreground: "white",
        width: "50%", fontFamily: "system-ui",
        hover: { background: "#abc", outlineColor: "transparent" },
      }} />
    </Window>);
    const style = tree.nodes.get("box")!.style;
    expect(style).toMatchObject({ background: "#ff000080", borderColor: "#008000ff", foreground: "#ffffff", width: "50%", fontFamily: "system-ui" });
    expect(style.hover).toMatchObject({ background: "#aabbcc", outlineColor: "#00000000" });
    expect(tree.document.window.background).toBe("#f0f0f0ff");
    expect(() => compileTree(<Window><Column style={{ background: "bogus" }} /></Window>)).toThrow("Unsupported colour");
  });
});
