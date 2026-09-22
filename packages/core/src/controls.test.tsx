import { describe, expect, test } from "bun:test";
import { Accordion, Checkbox, Progress, RadioGroup, Slider, Switch, Tabs } from "./controls";
import { Text, Window } from "./components";
import { VirtualList } from "./virtual-list";
import { compileTree, diffTrees } from "./reconciler";

describe("control kit", () => {
  test("exposes state and labels to native controls while keeping callbacks in Bun", () => {
    const view = (checked: boolean, value: number) => compileTree(
      <Window>
        <Checkbox id="check" checked={checked} label="Updates" onCheckedChange={() => {}} />
        <Switch id="switch" checked={checked} label="Notifications" />
        <Slider id="slider" value={value} label="Volume" />
        <Progress id="progress" value={value} />
      </Window>,
    );
    const initial = view(false, 20);
    expect(initial.nodes.get("check")?.control).toEqual({ role: "checkbox", label: "Updates", checked: false });
    expect(initial.nodes.get("switch")?.control?.role).toBe("switch");
    expect(initial.nodes.get("slider")?.control?.value).toBe(20);
    expect(initial.nodes.get("progress")?.control?.role).toBe("progress");
    expect(JSON.stringify(initial.document)).not.toContain("onCheckedChange");
    expect(diffTrees(initial, view(true, 25))?.map(node => node.id)).toContain("slider");
  });

  test("groups radio and tab choices and rejects invalid slider ranges", () => {
    const tree = compileTree(
      <Window>
        <RadioGroup id="plans" value="team" options={[{ value: "solo", label: "Solo" }, { value: "team", label: "Team" }]} />
        <Tabs id="tabs" value="one" items={[{ value: "one", label: "One", content: "First" }, { value: "two", label: "Two", content: "Second" }]} />
        <Accordion id="faq" value="a" items={[{ value: "a", title: "Question", content: "Answer" }]} />
      </Window>,
    );
    const radios = [...tree.nodes.values()].filter(node => node.control?.role === "radio");
    const tabs = [...tree.nodes.values()].filter(node => node.control?.role === "tab");
    expect(radios).toHaveLength(2);
    expect(radios.every(node => node.control?.group === "plans")).toBe(true);
    expect(tabs).toHaveLength(2);
    expect(tabs.every(node => node.control?.group)).toBe(true);
    expect(() => compileTree(<Window><Slider value={1} min={2} max={1} /></Window>)).toThrow(RangeError);
  });

  test("virtualizes a large list and keeps row identity stable", () => {
    const items = Array.from({ length: 50_000 }, (_, index) => index);
    const view = (offset: number) => compileTree(<Window><VirtualList id="list" items={items}
      itemHeight={36} height={360} offset={offset} onScroll={() => {}}
      renderItem={index => <Text id={`item-${index}`}>{index}</Text>} /></Window>);
    const first = view(0);
    const later = view(36_000);
    expect(first.nodes.size).toBeLessThan(50);
    expect(later.nodes.size).toBeLessThan(50);
    expect(first.nodes.has("item-0")).toBe(true);
    expect(later.nodes.has("item-1000")).toBe(true);
    expect(later.nodes.has("item-0")).toBe(false);
    expect(later.handlers.get("list")?.onScroll).toBeFunction();
  });
});
