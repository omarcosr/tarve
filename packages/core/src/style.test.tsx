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
});
