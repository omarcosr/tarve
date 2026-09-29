import { describe, expect, test } from "bun:test";
import { Window } from "./components";
import { Badge, Card } from "./controls";
import { compileTree } from "./reconciler";
import { Select, type SelectOption } from "./select";

const options: SelectOption[] = [
  { value: "a", label: "Alpha" },
  { value: "b", label: "Beta", disabled: true },
  { value: "c", label: "Gamma" },
];

function render(props: Partial<Parameters<typeof Select>[0]> = {}) {
  const values: string[] = [];
  const opens: boolean[] = [];
  const tree = compileTree(<Window><Select id="pick" options={options}
    onValueChange={value => values.push(value)} onOpenChange={open => opens.push(open)} {...props} /></Window>);
  const trigger = tree.handlers.get("pick-trigger")!;
  return { tree, trigger, values, opens };
}

describe("Select", () => {
  test("arrow keys wrap and skip disabled options", () => {
    const { trigger, values } = render({ value: "a" });
    trigger.onKeyDown!("ArrowDown");
    trigger.onKeyDown!("ArrowUp");
    expect(values).toEqual(["c", "c"]);
  });

  test("without a value, arrows start from the first or last enabled option", () => {
    const { trigger, values } = render();
    trigger.onKeyDown!("ArrowDown");
    trigger.onKeyDown!("ArrowUp");
    expect(values).toEqual(["a", "c"]);
  });

  test("Home and End jump to the enabled edges", () => {
    const { trigger, values } = render({ value: "c" });
    trigger.onKeyDown!("Home");
    trigger.onKeyDown!("End");
    expect(values).toEqual(["a", "c"]);
  });

  test("keys do nothing when every option is disabled", () => {
    const { trigger, values } = render({ options: [{ value: "x", label: "X", disabled: true }] });
    for (const key of ["ArrowDown", "ArrowUp", "Home", "End"]) trigger.onKeyDown!(key);
    expect(values).toEqual([]);
  });

  test("Escape and blur close a controlled select", () => {
    const { trigger, opens } = render({ open: true });
    trigger.onKeyDown!("Escape");
    trigger.onBlur!();
    expect(opens).toEqual([false, false]);
  });

  test("uncontrolled open state persists across renders and closes on choice", () => {
    const first = render({ id: "free" } as never);
    const trigger = first.tree.handlers.get("free-trigger")!;
    trigger.onClick!();
    const open = compileTree(<Window><Select id="free" options={options} /></Window>);
    expect(open.nodes.get("free-trigger")?.control?.expanded).toBe(true);
    open.handlers.get("free-option-c")!.onClick!();
    const closed = compileTree(<Window><Select id="free" options={options} /></Window>);
    expect(closed.nodes.get("free-trigger")?.control?.expanded).toBe(false);
  });

  test("rejects duplicate option values", () => {
    expect(() => render({ options: [{ value: "a", label: "A" }, { value: "a", label: "B" }] })).toThrow("unique");
  });
});

describe("Card and Badge", () => {
  test("Card renders only the header parts and footer that are provided", () => {
    const full = compileTree(<Window><Card id="card" title="Title" description="Desc" footer="Foot">Body</Card></Window>);
    const texts = [...full.nodes.values()].filter(node => node.kind === "text").map(node => node.text);
    expect(texts).toEqual(["Title", "Desc", "Body", "Foot"]);
    const bare = compileTree(<Window><Card id="bare">Body</Card></Window>);
    expect([...bare.nodes.values()].filter(node => node.kind === "text").map(node => node.text)).toEqual(["Body"]);
  });

  test("Badge variants set background and text colours", () => {
    const tree = compileTree(<Window>
      <Badge id="default">New</Badge>
      <Badge id="outline" variant="outline">Draft</Badge>
      <Badge id="custom" variant="destructive" style={{ foreground: "#123456" }}>Error</Badge>
    </Window>);
    expect(tree.nodes.get("default")?.style.background).toBeString();
    expect(tree.nodes.get("outline")?.style.borderWidth).toBe(1);
    const label = tree.nodes.get("custom")?.children[0];
    expect(label?.style.foreground).toBe("#123456");
  });
});
