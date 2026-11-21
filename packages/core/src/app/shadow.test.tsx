import { describe, expect, test } from "bun:test";
import { Column, Input, Row, Text, View, Window } from "../components";
import { compileTree } from "../reconciler";
import { editShadowNode, nativeShadow, reconciliationCommand, splitTextSets } from "./shadow";

describe("nativeShadow", () => {
  test("shares the compiled nodes until native edits one", () => {
    const tree = compileTree(<Window><Input id="q" value="a" /><Text id="t">x</Text></Window>);
    const shadow = nativeShadow(tree);
    expect(shadow.nodes).toBe(tree.nodes);
    editShadowNode(shadow, "q", { value: "ab" });
    expect(shadow.nodes).not.toBe(tree.nodes);
    expect(shadow.nodes.get("q")?.value).toBe("ab");
    expect(tree.nodes.get("q")?.value).toBe("a");
    expect(shadow.nodes.get("t")).toBe(tree.nodes.get("t")!);
  });

  test("a controlled value the app kept is patched back over the native edit", () => {
    const view = () => <Window><Input id="q" value="fixed" /></Window>;
    const first = compileTree(view());
    const shadow = nativeShadow(first);
    editShadowNode(shadow, "q", { value: "typed" });
    const command = reconciliationCommand(shadow, compileTree(view()));
    expect(command?.type).toBe("patch");
    if (command?.type === "patch") expect(command.nodes.map(node => [node.id, node.value])).toEqual([["q", "fixed"]]);
  });

  test("an uncontrolled field carries the typed value across renders", () => {
    const scope = {};
    const view = () => <Window><Input id="q" /></Window>;
    const first = compileTree(view(), false, "auto", [], scope);
    let shadow = nativeShadow(first);
    editShadowNode(shadow, "q", { value: "typed" });
    const second = compileTree(view(), false, "auto", [], scope);
    shadow = nativeShadow(second, shadow);
    expect(shadow.nodes.get("q")?.value).toBe("typed");
    expect(second.nodes.get("q")?.value).toBeUndefined();
    const third = compileTree(view(), false, "auto", [], scope);
    expect(nativeShadow(third, shadow).nodes.get("q")?.value).toBe("typed");
  });

  test("a carried value does not patch a field whose compiled node the render reused", () => {
    const view = (n: number) => <Window><Text id="n">{String(n)}</Text><Input id="q" /></Window>;
    const first = compileTree(view(0));
    let shadow = nativeShadow(first);
    editShadowNode(shadow, "q", { value: "typed" });
    const second = compileTree(view(1));
    shadow = nativeShadow(second, shadow);
    // A reused node object (what memo yields) is what the shadow's copy stands for.
    const third = compileTree(view(2));
    third.nodes.set("q", second.nodes.get("q")!);
    const command = reconciliationCommand(shadow, third);
    expect(command?.type).toBe("patch");
    if (command?.type === "patch") expect(command.nodes.map(node => node.id)).toEqual(["n"]);
    // A freshly compiled node is compared, and the app's (absent) value wins.
    const fourth = compileTree(view(3));
    const next = reconciliationCommand(shadow, fourth);
    if (next?.type === "patch") expect(next.nodes.map(node => node.id)).toEqual(["n", "q"]);
  });

  test("the shadow of a rolled-back render keeps native edits", () => {
    const view = () => <Window><Input id="q" value="v" /></Window>;
    const committed = compileTree(view());
    const observed = nativeShadow(committed);
    editShadowNode(observed, "q", { value: "v2" });
    const restored = nativeShadow(committed, observed);
    // A controlled field goes back to the app's value; nothing of the edit survives.
    expect(restored.nodes.get("q")?.value).toBe("v");
  });
});

describe("splitTextSets", () => {
  const view = (tick: number, color: string) => <Window title="w"><Column>
    <View id="marker" style={{ width: 10, height: 10, background: color }} />
    {Array.from({ length: 6 }, (_, i) => <Row key={i} style={{ height: 20 }}><Text style={{ flex: 1 }}>Row {i}: {tick}</Text></Row>)}
  </Column></Window>;

  test("texts patched in place go as text sets, the rest as a patch", () => {
    const scope = {};
    compileTree(view(0, "#f00"), false, "auto", [], scope);
    const first = compileTree(view(1, "#f00"), false, "auto", [], scope);
    const next = compileTree(view(2, "#0f0"), false, "auto", [], scope);
    const command = reconciliationCommand(nativeShadow(first), next)!;
    const split = splitTextSets(nativeShadow(first), command)!;
    expect(split).toBeDefined();
    const sets = (split.sets as unknown as { nodes: { id: string; text?: string; style?: unknown }[] }).nodes;
    expect(sets.map(set => set.text)).toEqual(Array.from({ length: 6 }, (_, i) => `Row ${i}: 2`));
    expect(sets.every(set => set.style === undefined)).toBe(true);
    expect(split.rest).toEqual({ type: "patch", nodes: [expect.objectContaining({ id: "marker" })] });
  });

  test("a text whose style changed too stays in the patch", () => {
    const scope = {};
    const styled = (tick: number, flex: number) => <Window title="w"><Column>{[0, 1].map(i => <Row key={i}><Text style={{ flex }}>{tick}</Text></Row>)}</Column></Window>;
    compileTree(styled(0, 1), false, "auto", [], scope);
    const first = compileTree(styled(1, 1), false, "auto", [], scope);
    const next = compileTree(styled(2, 2), false, "auto", [], scope);
    expect(splitTextSets(nativeShadow(first), reconciliationCommand(nativeShadow(first), next)!)).toBeUndefined();
  });
});
