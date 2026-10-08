import { describe, expect, test } from "bun:test";
import { Window, Column, Text, Pressable, Input } from "./components";
import { compileTree, diffTreeMutations, invalidateMemos } from "./reconciler";
import { memo } from "./memo";

describe("memo", () => {
  test("reuses a subtree while its props are equal and recompiles it when they change", () => {
    let renders = 0;
    const clicks: string[] = [];
    const Row = memo(({ label }: { label: string }) => {
      renders++;
      return <Pressable id={`row-${label}`} onClick={() => clicks.push(label)}><Text id={`text-${label}`}>{label}</Text></Pressable>;
    });
    const scope = {};
    const view = (time: number, label: string) => (
      <Window title="memo">
        <Column id="list"><Row label={label} /></Column>
        <Text id="time">{String(time)}</Text>
      </Window>
    );
    const first = compileTree(view(0, "a"), false, "auto", [], scope);
    const second = compileTree(view(1, "a"), false, "auto", [], scope);
    expect(renders).toBe(1);
    expect(second.nodes.get("row-a")).toBe(first.nodes.get("row-a")!);
    // The reused subtree still registers its nodes and handlers in the new tree.
    expect(second.nodes.has("text-a")).toBe(true);
    second.handlers.get("row-a")!.onClick!();
    expect(clicks).toEqual(["a"]);
    // Only the text outside the memoized row changed.
    expect(diffTreeMutations(first, second)!.map(m => m.type === "patch" ? m.node.id : m.type)).toEqual(["time"]);
    const third = compileTree(view(1, "b"), false, "auto", [], scope);
    expect(renders).toBe(2);
    expect(third.nodes.has("row-b") && !third.nodes.has("row-a")).toBe(true);
  });

  test("keeps nested memoized components cached when their parent is reused", () => {
    let inner = 0;
    const Inner = memo(({ n }: { n: number }) => { inner++; return <Text id={`inner-${n}`}>{String(n)}</Text>; });
    const Outer = memo(({ n }: { n: number }) => <Column id="outer"><Inner n={n} /></Column>);
    const scope = {};
    const view = (n: number, t: number) => <Window title="nested"><Outer n={n} /><Text id="t">{String(t)}</Text></Window>;
    compileTree(view(1, 0), false, "auto", [], scope);
    compileTree(view(1, 1), false, "auto", [], scope);
    compileTree(view(1, 2), false, "auto", [], scope);
    expect(inner).toBe(1);
  });

  test("a subtree tied to a label elsewhere is recompiled every time", () => {
    let renders = 0;
    const Field = memo(({ value }: { value: string }) => { renders++; return <Input id="field" value={value} />; });
    const scope = {};
    const view = () => <Window title="labels"><label htmlFor="field">Name</label><Field value="x" /></Window>;
    const first = compileTree(view(), false, "auto", [], scope);
    const second = compileTree(view(), false, "auto", [], scope);
    expect(renders).toBe(2);
    expect(second.nodes.get("field")!.labelledBy).toEqual(first.nodes.get("field")!.labelledBy);
  });

  test("duplicate ids are still reported for a reused subtree", () => {
    const Same = memo(() => <Text id="dup">x</Text>);
    const scope = {};
    compileTree(<Window title="d"><Same /></Window>, false, "auto", [], scope);
    expect(() => compileTree(<Window title="d"><Same /><Text id="dup">y</Text></Window>, false, "auto", [], scope)).toThrow("Duplicate node id: dup");
  });

  test("a handler inside a memoized subtree recompiles it on the next render", () => {
    let count = 0;
    let renders = 0;
    const Counter = memo(() => { renders++; return <Pressable id="inc" onClick={() => { count++; }}><Text id="count">{String(count)}</Text></Pressable>; });
    const scope = {};
    const view = () => <Window title="c"><Column id="outer"><Counter /></Column></Window>;
    compileTree(view(), false, "auto", [], scope);
    compileTree(view(), false, "auto", [], scope);
    expect(renders).toBe(1);
    count++;
    invalidateMemos(scope, "inc");
    const tree = compileTree(view(), false, "auto", [], scope);
    expect(renders).toBe(2);
    expect(tree.nodes.get("count")!.text).toBe("1");
  });

  test("without a render scope a memo component is a plain component", () => {
    let renders = 0;
    const Plain = memo(() => { renders++; return <Text id="p">x</Text>; });
    compileTree(<Window title="p"><Plain /></Window>);
    compileTree(<Window title="p"><Plain /></Window>);
    expect(renders).toBe(2);
  });
});
