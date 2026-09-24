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

  test("variable VirtualList learns measured heights and preserves a keyed anchor across prepend", () => {
    type Item = { id: string; label: string };
    let items: Item[] = ["a", "b", "c", "d", "e"].map(id => ({ id, label: id.toUpperCase() }));
    const view = (offset: number) => compileTree(
      <Window>
        <VirtualList
          id="variable-list"
          items={items}
          estimatedItemHeight={40}
          height={80}
          offset={offset}
          overscan={0}
          keyForItem={item => item.id}
          onScroll={() => {}}
          renderItem={item => <Text id={`variable-${item.id}`}>{item.label}</Text>}
        />
      </Window>,
    );

    const first = view(0);
    expect(first.nodes.get("variable-list")?.virtualList).toEqual({
      estimatedItemHeight: 40,
      itemCount: 5,
      windowStart: 0,
      windowEnd: 2,
      renderedKeys: ["s:a", "s:b"],
      alignment: "top",
      followTail: false,
    });
    expect(first.nodes.has("variable-a")).toBe(true);
    expect(first.nodes.has("variable-c")).toBe(false);
    first.handlers.get("variable-list")?.onVirtualListLayout?.([
      { key: "s:a", height: 20 },
      { key: "s:b", height: 70 },
    ]);

    const measured = view(90);
    expect(measured.nodes.get("variable-list")?.control?.value).toBe(90);
    expect(measured.nodes.get("variable-list")?.virtualList?.renderedKeys[0]).toBe("s:c");
    expect(measured.nodes.has("variable-c")).toBe(true);

    items = [{ id: "x", label: "X" }, ...items];
    const prepended = view(90);
    expect(prepended.nodes.get("variable-list")?.control?.value).toBe(130);
    expect(prepended.nodes.get("variable-list")?.virtualList?.windowStart).toBe(3);
    expect(prepended.nodes.get("variable-list")?.virtualList?.renderedKeys[0]).toBe("s:c");
    expect(prepended.nodes.has("variable-c")).toBe(true);

    expect(() => compileTree(
      <Window>
        <VirtualList
          id="duplicate-variable-list"
          items={[{ id: "same" }, { id: "same" }]}
          estimatedItemHeight={32}
          height={64}
          offset={0}
          keyForItem={item => item.id}
          onScroll={() => {}}
          renderItem={() => <Text>row</Text>}
        />
      </Window>,
    )).toThrow("unique keyForItem");
  });

  test("variable VirtualList bottom alignment follows tail only while pinned to the end", () => {
    let offset = 0;
    let items = ["a", "b", "c", "d", "e"];
    const view = () => compileTree(
      <Window>
        <VirtualList
          id="tail-list"
          items={items}
          estimatedItemHeight={40}
          height={80}
          offset={offset}
          overscan={0}
          alignment="bottom"
          followTail
          keyForItem={item => item}
          onScroll={next => { offset = next; }}
          renderItem={item => <Text id={`tail-${item}`}>{item}</Text>}
        />
      </Window>,
    );

    const initial = view();
    expect(initial.nodes.get("tail-list")?.control?.value).toBe(120);
    expect(initial.nodes.get("tail-list")?.virtualList?.renderedKeys).toEqual(["s:d", "s:e"]);
    initial.handlers.get("tail-list")?.onScroll?.(120, 120);

    items = [...items, "f"];
    const appended = view();
    expect(appended.nodes.get("tail-list")?.control?.value).toBe(160);
    expect(appended.nodes.has("tail-f")).toBe(true);
    appended.handlers.get("tail-list")?.onScroll?.(80, 160);

    items = [...items, "g"];
    const paused = view();
    expect(paused.nodes.get("tail-list")?.control?.value).toBe(80);
    expect(paused.nodes.has("tail-g")).toBe(false);
    paused.handlers.get("tail-list")?.onScroll?.(200, 200);

    items = [...items, "h"];
    const resumed = view();
    expect(resumed.nodes.get("tail-list")?.control?.value).toBe(240);
    expect(resumed.nodes.has("tail-h")).toBe(true);
  });

  test("variable VirtualList parks a focused row outside the rendered window and restores it on reentry", () => {
    const items = ["a", "b", "c", "d", "e"];
    let offset = 0;
    const view = () => compileTree(
      <Window>
        <VirtualList
          id="focus-list"
          items={items}
          estimatedItemHeight={40}
          height={80}
          offset={offset}
          overscan={0}
          keyForItem={item => item}
          onScroll={() => {}}
          renderItem={item => <Text id={`focus-${item}`}>{item}</Text>}
        />
      </Window>,
    );

    const visible = view();
    expect(visible.nodes.has("focus-b")).toBe(true);
    visible.handlers.get("focus-list")?.onVirtualListFocus?.("s:b");

    offset = 120;
    const parked = view();
    expect(parked.nodes.get("focus-list")?.virtualList?.retainedKey).toBe("s:b");
    expect(parked.nodes.has("focus-b")).toBe(true);
    const parkedRow = [...parked.nodes.values()].find(node =>
      node.children.some(child => child.id === "focus-b"),
    );
    expect(parkedRow?.style.position).toBe("absolute");
    expect(parkedRow?.style.top).toBe(-1_000_000);

    offset = 0;
    const restored = view();
    expect(restored.nodes.get("focus-list")?.virtualList?.retainedKey).toBeUndefined();
    expect(restored.nodes.has("focus-b")).toBe(true);
    const restoredRow = [...restored.nodes.values()].find(node =>
      node.children.some(child => child.id === "focus-b"),
    );
    expect(restoredRow?.style.position).toBeUndefined();
  });

  test("windowed VirtualList represents huge logical collections without iterating or mounting them", () => {
    const items = Array.from({ length: 8 }, (_, index) => `loaded-${index}`);
    const view = () => compileTree(
      <Window>
        <VirtualList
          id="windowed-list"
          items={items}
          itemCount={1_000_000}
          windowStart={500_000}
          estimatedItemHeight={40}
          height={160}
          offset={20_000_000}
          keyForItem={(_, index) => index}
          onScroll={() => {}}
          renderItem={(_, index) => <Text id={`windowed-${index}`}>{index}</Text>}
        />
      </Window>,
    );

    const first = view();
    const list = first.nodes.get("windowed-list");
    expect(first.nodes.size).toBeLessThan(30);
    expect(list?.virtualList).toEqual({
      estimatedItemHeight: 40,
      itemCount: 1_000_000,
      windowStart: 500_000,
      windowEnd: 500_008,
      renderedKeys: Array.from({ length: 8 }, (_, offset) => `n:${500_000 + offset}`),
      alignment: "top",
      followTail: false,
    });
    expect(first.nodes.has("windowed-500000")).toBe(true);
    expect(first.nodes.has("windowed-800000")).toBe(false);
    const content = list?.children[0];
    expect(content?.children[0]?.style.height).toBe(20_000_000);

    first.handlers.get("windowed-list")?.onVirtualListScrollToItem?.(800_000, 0);
    const requested = view();
    expect(requested.nodes.get("windowed-list")?.virtualList?.scrollRequest).toEqual({
      generation: 1,
      offset: 32_000_000,
    });
    expect(requested.nodes.size).toBeLessThan(30);
  });

  test("windowed VirtualList retains a focused provider row while the loaded window moves away", () => {
    let windowStart = 100;
    let items = ["a", "b"];
    const view = () => compileTree(
      <Window>
        <VirtualList
          id="windowed-focus-list"
          items={items}
          itemCount={1_000}
          windowStart={windowStart}
          estimatedItemHeight={40}
          height={80}
          offset={windowStart * 40}
          keyForItem={(_, index) => index}
          onScroll={() => {}}
          renderItem={(item, index) => <Text id={`windowed-focus-${index}`}>{item}</Text>}
        />
      </Window>,
    );

    const first = view();
    first.handlers.get("windowed-focus-list")?.onVirtualListFocus?.("n:101");

    windowStart = 500;
    items = ["x", "y"];
    const parked = view();
    expect(parked.nodes.get("windowed-focus-list")?.virtualList?.retainedKey).toBe("n:101");
    expect(parked.nodes.has("windowed-focus-101")).toBe(true);

    windowStart = 101;
    items = ["b", "c"];
    const restored = view();
    expect(restored.nodes.get("windowed-focus-list")?.virtualList?.retainedKey).toBeUndefined();
    expect(restored.nodes.has("windowed-focus-101")).toBe(true);
  });

  test("variable VirtualList keeps measured state for more than 128 lists mounted in one render", () => {
    let targetOffset = 0;
    const view = () => compileTree(
      <Window>
        {Array.from({ length: 129 }, (_, index) => (
          <VirtualList
            id={`many-variable-lists-${index}`}
            items={["a", "b"]}
            estimatedItemHeight={40}
            height={40}
            offset={index === 0 ? targetOffset : 0}
            overscan={0}
            keyForItem={item => item}
            onScroll={() => {}}
            renderItem={item => <Text>{item}</Text>}
          />
        ))}
      </Window>,
    );

    const initial = view();
    initial.handlers.get("many-variable-lists-0")?.onVirtualListLayout?.([
      { key: "s:a", height: 80 },
    ]);

    targetOffset = 40;
    expect(view().nodes.get("many-variable-lists-0")?.virtualList?.renderedKeys).toEqual(["s:a"]);
  });

  test("variable VirtualList keeps scroll request generations monotonic after state eviction", () => {
    const target = () => compileTree(
      <Window>
        <VirtualList
          id="generation-eviction-list"
          items={["a", "b", "c"]}
          estimatedItemHeight={40}
          height={40}
          offset={0}
          overscan={0}
          keyForItem={item => item}
          onScroll={() => {}}
          renderItem={item => <Text>{item}</Text>}
        />
      </Window>,
    );

    const first = target();
    first.handlers.get("generation-eviction-list")?.onVirtualListScrollToItem?.(1, 0);
    const firstGeneration = target().nodes.get("generation-eviction-list")?.virtualList?.scrollRequest?.generation;
    expect(firstGeneration).toBeNumber();

    for (let index = 0; index < 130; index++) {
      compileTree(
        <Window>
          <VirtualList
            id={`generation-pressure-${index}`}
            items={[index]}
            estimatedItemHeight={40}
            height={40}
            offset={0}
            overscan={0}
            keyForItem={item => item}
            onScroll={() => {}}
            renderItem={item => <Text>{item}</Text>}
          />
        </Window>,
      );
    }

    const restored = target();
    restored.handlers.get("generation-eviction-list")?.onVirtualListScrollToItem?.(2, 0);
    const nextGeneration = target().nodes.get("generation-eviction-list")?.virtualList?.scrollRequest?.generation;
    expect(nextGeneration).toBeGreaterThan(firstGeneration!);
  });

  test("windowed VirtualList keeps measured geometry after a row leaves the provider window", () => {
    let itemCount = 1_000;
    let windowStart = 100;
    let items = ["a", "b"];
    const view = () => compileTree(
      <Window>
        <VirtualList
          id="windowed-measurement-history"
          items={items}
          itemCount={itemCount}
          windowStart={windowStart}
          estimatedItemHeight={40}
          height={80}
          offset={4_000}
          keyForItem={(_, index) => index}
          onScroll={() => {}}
          renderItem={(item, index) => <Text id={`history-${index}`}>{item}</Text>}
        />
      </Window>,
    );

    const initial = view();
    initial.handlers.get("windowed-measurement-history")?.onVirtualListLayout?.([
      { key: "n:100", height: 80 },
    ]);
    view();

    windowStart = 101;
    items = ["b", "c"];
    const shifted = view();
    const content = shifted.nodes.get("windowed-measurement-history")?.children[0];
    expect(content?.children[0]?.style.height).toBe(4_080);

    shifted.handlers.get("windowed-measurement-history")?.onVirtualListScrollToItem?.(500, 0);
    expect(view().nodes.get("windowed-measurement-history")?.virtualList?.scrollRequest?.offset).toBe(20_040);

    itemCount = 50;
    windowStart = 0;
    items = ["x"];
    view();

    itemCount = 1_000;
    windowStart = 101;
    items = ["b", "c"];
    const regrown = view();
    const regrownContent = regrown.nodes.get("windowed-measurement-history")?.children[0];
    expect(regrownContent?.children[0]?.style.height).toBe(4_040);
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
