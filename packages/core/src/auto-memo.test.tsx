import { describe, expect, test } from "bun:test";
import { Button, Column, Row, Scroll, Text, View, Window, signal } from "./index";
import { compileTree } from "./reconciler";
import type { VNode } from "./jsx-runtime";

describe("automatic memo of list items", () => {
  const grid = (changed: number, label: string, extra?: (i: number) => unknown) => <Window title="grid">
    <View>{Array.from({ length: 100 }, (_, i) => <View key={i} style={{ width: 10, background: i === changed ? "#f00" : "#00f" }}>
      <Text>{i === changed ? label : String(i)}</Text>
      {extra?.(i) as never}
    </View>)}</View>
  </Window>;

  test("an unchanged item keeps its compiled nodes; a changed one compiles again", () => {
    const scope = {};
    compileTree(grid(0, "a"), false, "auto", [], scope);
    const first = compileTree(grid(0, "a"), false, "auto", [], scope);
    const second = compileTree(grid(0, "b"), false, "auto", [], scope);
    const id = (i: number) => `root/children/children/k:${i}`;
    expect(second.nodes.get(id(5))).toBe(first.nodes.get(id(5)));
    expect(second.nodes.get(id(0))).not.toBe(first.nodes.get(id(0)));
    const label = [...second.nodes.values()].find(node => node.kind === "text" && node.text === "b");
    expect(label).toBeDefined();
  });

  test("an item with a component that may read state is compiled every time", () => {
    const scope = {};
    let value = "x";
    const Reads = () => <Text>{value}</Text>;
    const view = () => grid(-1, "", i => i === 3 ? <Reads /> : null);
    compileTree(view(), false, "auto", [], scope);
    compileTree(view(), false, "auto", [], scope);
    value = "y";
    const next = compileTree(view(), false, "auto", [], scope);
    expect([...next.nodes.values()].some(node => node.kind === "text" && node.text === "y")).toBe(true);
  });

  test("a new handler is not hidden by a reused item", () => {
    const scope = {};
    const calls: string[] = [];
    const view = (tag: string) => <Window title="h"><View>{[0, 1].map(i => <div key={i} onClick={() => { calls.push(tag); }} />)}</View></Window>;
    compileTree(view("a"), false, "auto", [], scope);
    const next = compileTree(view("b"), false, "auto", [], scope);
    for (const handlers of next.handlers.values()) handlers.onClick?.();
    expect(calls).toEqual(["b", "b"]);
  });

  test("an unchanged item with a button is reused, and a changed label compiles again", () => {
    const scope = {};
    const onClick = () => {};
    const view = (label: string) => <Window title="b"><View>{[0, 1].map(i => <View key={i}><Button size="sm" onClick={onClick}>{i === 0 ? label : "Open"}</Button></View>)}</View></Window>;
    compileTree(view("a"), false, "auto", [], scope);
    const first = compileTree(view("a"), false, "auto", [], scope);
    const next = compileTree(view("b"), false, "auto", [], scope);
    const id = (i: number) => `root/children/children/k:${i}`;
    expect(next.nodes.get(id(1))).toBe(first.nodes.get(id(1)));
    expect(next.nodes.get(id(0))).not.toBe(first.nodes.get(id(0)));
    expect([...next.nodes.values()].some(node => node.kind === "button" && node.text === "b")).toBe(true);
  });
});

describe("automatic memo: items whose texts alone changed are patched", () => {
  const row = (i: number, label: unknown, tick: number) => <Row key={i} style={{ height: 36 }} gap={12}>
    <Text style={{ flex: 1 }}>Record {i}: {label as never} {tick}</Text>
    <Button size="sm">Open</Button>
  </Row>;
  const list = (tick: number, label: (i: number) => unknown = () => "text", count = 20) =>
    <Window title="list"><Column><Scroll id="s"><Column>{Array.from({ length: count }, (_, i) => row(i, label(i), tick))}</Column></Scroll></Column></Window>;

  /** The scoped (memoized, patched) compile must equal a compile from scratch, render after render. */
  function expectSameAsFresh(views: (() => VNode)[]): void {
    const scope = {};
    for (const view of views) {
      const memoized = compileTree(view(), false, "auto", [], scope);
      const fresh = compileTree(view(), false, "auto", []);
      expect(memoized.document).toEqual(fresh.document);
      expect([...memoized.nodes.keys()].sort()).toEqual([...fresh.nodes.keys()].sort());
      for (const [id, node] of memoized.nodes) expect(node).toEqual(fresh.nodes.get(id)!);
    }
  }

  test("a changed text is patched and the rest of the item is reused", () => {
    const scope = {};
    compileTree(list(0), false, "auto", [], scope);
    const first = compileTree(list(1), false, "auto", [], scope);
    const next = compileTree(list(2), false, "auto", [], scope);
    const rowId = "s/children/children/k:3";
    const text = (tree: typeof next) => [...tree.nodes.values()].find(node => node.kind === "text" && node.id.startsWith(rowId + "/"))!;
    expect(text(next).text).toBe("Record 3: text 2");
    expect(text(next)).not.toBe(text(first));
    const button = (tree: typeof next) => [...tree.nodes.values()].find(node => node.kind === "button" && node.id.startsWith(rowId + "/"))!;
    expect(button(next)).toBe(button(first));
    expect(next.nodes.get(rowId)!.children).toContain(text(next));
  });

  test("patched renders compile exactly what a fresh compile does", () => {
    expectSameAsFresh([
      () => list(0), () => list(1), () => list(2), () => list(2),
      // Whitespace collapses, numbers, empty strings.
      () => list(3, i => i % 2 ? "two  spaces" : 7), () => list(3, i => i % 3 ? "" : "x"),
      // A text that becomes an element (not plain) and back.
      () => list(4, i => i === 2 ? <strong>bold</strong> : "t"), () => list(5), () => list(6),
      // Structure and style changes, fewer items, more items.
      () => list(7, () => "t", 10), () => list(8, () => "t", 25), () => list(9, () => "u", 25),
    ]);
  });

  test("a style change next to a text change compiles the item again", () => {
    const scope = {};
    const view = (tick: number, flex: number) => <Window title="w"><Column>{[0, 1].map(i => <Row key={i}><Text style={{ flex }}>{tick}</Text></Row>)}</Column></Window>;
    compileTree(view(0, 1), false, "auto", [], scope);
    compileTree(view(1, 1), false, "auto", [], scope);
    const next = compileTree(view(2, 2), false, "auto", [], scope);
    const texts = [...next.nodes.values()].filter(node => node.kind === "text");
    expect(texts.map(node => [node.text, node.style.flex])).toEqual([["2", 2], ["2", 2]]);
  });
});

describe("compiled styles", () => {
  test("equal styles under the same inherited font are one object; a signal-bound one is its own", () => {
    const color = signal("#ff0000");
    const tree = compileTree(<Window title="s"><Column>
      <Text id="a" style={{ flex: 1 }}>one</Text>
      <Text id="b" style={{ flex: 1 }}>two</Text>
      <Column style={{ fontSize: 20 }}><Text id="c" style={{ flex: 1 }}>three</Text></Column>
      <Text id="d" style={{ flex: 1, foreground: color }}>four</Text>
      <Text id="e" style={{ flex: 1, foreground: color }}>five</Text>
    </Column></Window>);
    const style = (id: string) => tree.nodes.get(id)!.style;
    expect(style("a")).toBe(style("b"));
    // Another inherited font: another style.
    expect(style("c")).not.toBe(style("a"));
    expect(style("c").fontSize).toBe(20);
    expect(style("d")).not.toBe(style("e"));
    expect(style("d")).toEqual(style("e"));
  });
});

describe("automatic memo inside a memoized item", () => {
  test("a memoized item's many children keep entries of their own; a few do not need them", () => {
    const scope = {};
    const grid = (changed: number, tag: string) => <Window title="g"><Column>{[0, 1].map(row => <Row key={row}>
      {Array.from({ length: 10 }, (_, i) => <View key={i} style={{ width: row === 0 && i === changed ? 20 : 10 }}><Text>{tag}</Text></View>)}
    </Row>)}</Column></Window>;
    compileTree(grid(3, "a"), false, "auto", [], scope);
    const first = compileTree(grid(3, "a"), false, "auto", [], scope);
    const next = compileTree(grid(4, "a"), false, "auto", [], scope);
    const cell = (tree: typeof next, i: number) => [...tree.nodes.values()].find(node => node.id.endsWith(`k:0/children/k:${i}`))!;
    // Row 0 compiled again, but its unchanged cells (ten of them: more than a few) were reused.
    expect(cell(next, 7)).toBe(cell(first, 7));
    expect(cell(next, 4)).not.toBe(cell(first, 4));
    expect(cell(next, 4).style.width).toBe(20);
    expect(cell(next, 3).style.width).toBe(10);
  });
});
