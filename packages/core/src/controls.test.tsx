import { describe, expect, test } from "bun:test";
import { Accordion, Checkbox, Progress, RadioGroup, Slider, Switch, Tabs } from "./controls";
import { Scroll, ScrollArea, Text, TextArea, Window } from "./components";
import { List } from "./list";
import { Select } from "./select";
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

  test("keeps List and VirtualList as separate public list models", () => {
    const items = [24, 48, 72];
    const regular = compileTree(
      <Window>
        <List id="regular-list" items={items} renderItem={(height, index) => (
          <Text id={`regular-${index}`} style={{ height }}>{height}</Text>
        )} />
      </Window>,
    );
    expect(regular.nodes.get("regular-list")?.kind).toBe("scroll");
    expect(regular.nodes.get("regular-list")?.control).toBeUndefined();
    expect(items.every((_, index) => regular.nodes.has(`regular-${index}`))).toBe(true);
    expect(() => compileTree(<Window><List items={[1]} /></Window>)).toThrow(TypeError);
  });

  test("Scroll serializes and validates wheel speed", () => {
    const normal = compileTree(<Window><Scroll id="normal"><Text>Content</Text></Scroll></Window>);
    const faster = compileTree(<Window><Scroll id="faster" speed={2.5}><Text>Content</Text></Scroll></Window>);
    expect(normal.nodes.get("normal")?.scrollSpeed).toBe(1);
    expect(faster.nodes.get("faster")?.scrollSpeed).toBe(2.5);
    expect(diffTrees(faster, compileTree(<Window><Scroll id="faster" speed={0.5}><Text>Content</Text></Scroll></Window>))
      ?.map(node => node.id)).toContain("faster");
    expect(() => compileTree(<Window><Scroll speed={0}><Text>Content</Text></Scroll></Window>)).toThrow(RangeError);
    expect(() => compileTree(<Window><Scroll speed={Number.NaN}><Text>Content</Text></Scroll></Window>)).toThrow(RangeError);
  });

  test("ScrollArea exposes horizontal and bidirectional orientation without changing vertical defaults", () => {
    const tree = compileTree(<Window>
      <Scroll id="vertical"><Text>Vertical</Text></Scroll>
      <ScrollArea id="horizontal" orientation="horizontal" onScrollPosition={() => {}}>
        <Text>Horizontal</Text>
      </ScrollArea>
      <ScrollArea id="both" orientation="both"><Text>Both</Text></ScrollArea>
    </Window>);
    expect(tree.nodes.get("vertical")?.scrollOrientation).toBe("vertical");
    expect(tree.nodes.get("horizontal")?.scrollOrientation).toBe("horizontal");
    expect(tree.nodes.get("both")?.scrollOrientation).toBe("both");
    expect(tree.handlers.get("horizontal")?.onScrollPosition).toBeFunction();
    expect(() => Scroll({ orientation: "diagonal" as never })).toThrow(TypeError);
  });

  test("Select exposes one keyboard trigger and non-tab-stop popup options", () => {
    const changes: string[] = [];
    const tree = compileTree(
      <Window>
        <Select id="plan-select" value="team" open options={[
          { value: "personal", label: "Personal" },
          { value: "team", label: "Team" },
          { value: "enterprise", label: "Enterprise", disabled: true },
        ]} onValueChange={value => changes.push(value)} />
      </Window>,
    );
    const trigger = tree.nodes.get("plan-select-trigger");
    expect(trigger?.control).toEqual({ role: "select", label: "Team", expanded: true });
    expect(trigger?.children.map(node => node.id)).toContain("plan-select-popup");
    expect(tree.nodes.get("plan-select-option-team")?.control).toEqual({ role: "option", label: "Team", selected: true });
    expect(tree.handlers.get("plan-select-trigger")?.onBlur).toBeFunction();
    expect(tree.nodes.get("plan-select-option-personal")?.focusable).toBe(false);
    expect(tree.nodes.get("plan-select-option-enterprise")?.disabled).toBe(true);
    tree.handlers.get("plan-select-option-personal")?.onClick?.();
    expect(changes).toEqual(["personal"]);
    expect(() => compileTree(<Window><Select id="duplicate" options={[
      { value: "same", label: "One" }, { value: "same", label: "Two" },
    ]} /></Window>)).toThrow(TypeError);
  });

  test("TextArea compiles to a native multiline editable node", () => {
    const tree = compileTree(
      <Window>
        <TextArea id="notes" value={"first\nsecond"} placeholder="Notes" onChange={() => {}} />
      </Window>,
    );
    const area = tree.nodes.get("notes");
    expect(area?.kind).toBe("textarea");
    expect(area?.value).toBe("first\nsecond");
    expect(area?.placeholder).toBe("Notes");
    expect(area?.style.height).toBe(120);
    expect(area?.style.focusVisible?.outlineStyle).toBe("solid");
    expect(tree.handlers.get("notes")?.onChange).toBeFunction();
  });
});
