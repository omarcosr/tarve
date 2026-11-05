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

  test("labels take the button's own font size and weight", () => {
    const tree = compileTree(<Window><Button id="b" style={{ fontSize: 13, fontWeight: 700 }}><span id="l">Season 1</span></Button></Window>);
    expect(tree.nodes.get("l")!.style).toMatchObject({ fontSize: 13, fontWeight: 700 });
  });

  test("a nested element's own colour and font reach the text inside it", () => {
    const tree = compileTree(<Window><Button id="b">
      <div id="card">
        <h3 id="title" style={{ color: "#ffffff", fontSize: 17 }}>The Box</h3>
        <div id="sized" style={{ fontSize: 12 }}>Small</div>
      </div>
    </Button></Window>);
    const title = tree.nodes.get("title")!;
    expect(title.style).toMatchObject({ foreground: "#ffffff", fontSize: 17 });
    expect(title.runs).toBeUndefined();
    const small = tree.nodes.get("sized")?.children?.[0];
    expect(small?.style.fontSize).not.toBe(14);
    expect(small?.style.foreground).toBeString();
  });
});
