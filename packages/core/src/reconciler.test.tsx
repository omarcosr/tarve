import { describe, expect, test } from "bun:test";
import { Window, Column, Text, Button, TextInput } from "./components";
import { compileTree, diffTrees } from "./reconciler";

describe("native TSX protocol", () => {
  test("compiles function components, flattens children, and keeps callbacks outside JSON", () => {
    let clicked = false;
    const tree = compileTree(<Window title="Test"><Column>{null}<Text>Hello {2}</Text><Button id="button" onClick={() => { clicked = true; }}>Click</Button><TextInput id="input" value="Olá"/></Column></Window>);
    expect(tree.document.root.kind).toBe("window");
    expect(tree.document.root.children[0].children[0].text).toBe("Hello 2");
    expect(JSON.stringify(tree.document)).not.toContain("onClick");
    tree.handlers.get("button")?.onClick?.();
    expect(clicked).toBe(true);
  });
  test("keyed identities survive reordering", () => {
    const build = (values: string[]) => compileTree(<Window><Column>{values.map(v => <Text key={v}>{v}</Text>)}</Column></Window>);
    const a = build(["a", "b"]).document.root.children[0].children;
    const b = build(["b", "a"]).document.root.children[0].children;
    expect(a[0].id).toBe(b[1].id);
  });
  test("rejects duplicate IDs and invalid roots", () => {
    expect(() => compileTree(<Window><Text id="same">a</Text><Text id="same">b</Text></Window>)).toThrow("Duplicate");
    expect(() => compileTree(<Column/>)).toThrow("Window root");
  });
  test("sends only changed properties and detects structural updates", () => {
    const view = (value: string) => compileTree(<Window><Column><Text id="label">{value}</Text><Button id="button">Save</Button></Column></Window>);
    const a = view("Before");
    expect(diffTrees(a, view("Before"))).toEqual([]);
    const changes = diffTrees(a, view("After"))!;
    expect(changes.map(node => node.id)).toEqual(["label"]);
    expect(changes[0].children).toEqual([]);
    expect(changes[0].text).toBe("After");
    expect(diffTrees(a, compileTree(<Window><Text id="label">After</Text></Window>))).toBeNull();
  });
  test("style snapshots detect mutations to shared inset objects", () => {
    const padding = { left: 8 };
    const view = () => compileTree(<Window><Column id="column" padding={padding}/></Window>);
    const before = view();
    padding.left = 20;
    expect(diffTrees(before, view())?.map(node => node.id)).toEqual(["column"]);
  });
});
