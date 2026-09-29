import { describe, expect, test } from "bun:test";
import { Button, Window } from "./components";
import { jsx } from "./jsx-runtime";
import { compileTree } from "./reconciler";

describe("Button composed content", () => {
  test("span and intrinsic text children inherit the button foreground", () => {
    const tree = compileTree(<Window><Button id="b">
      <span id="span-child">Save</span>
      {jsx("text", { id: "text-child", style: { fontSize: 20 }, children: "Now" })}
    </Button></Window>);
    const foreground = tree.nodes.get("span-child")?.style.foreground;
    expect(foreground).toBeString();
    expect(tree.nodes.get("text-child")?.style).toMatchObject({ fontSize: 20, fontWeight: 500, foreground });
  });

  test("an explicit child colour wins over the button foreground", () => {
    const tree = compileTree(<Window><Button id="b"><span id="s" style={{ color: "#ff0000" }}>Hi</span></Button></Window>);
    expect(tree.nodes.get("s")?.style.foreground).toBe("#ff0000");
  });

  test("bare strings nested in layout children become themed Text", () => {
    const tree = compileTree(<Window><Button id="b"><div id="row">Hi{3}</div></Button></Window>);
    const texts = tree.nodes.get("row")?.children ?? [];
    expect(texts.map(node => [node.kind, node.text])).toEqual([["text", "Hi"], ["text", "3"]]);
    expect(texts[0]?.style).toMatchObject({ fontSize: 14, fontWeight: 500 });
    expect(texts[0]?.style.foreground).toBeString();
  });
});
