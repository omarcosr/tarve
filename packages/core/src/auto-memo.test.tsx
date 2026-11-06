import { describe, expect, test } from "bun:test";
import { Text, View, Window } from "./index";
import { compileTree } from "./reconciler";

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
});
