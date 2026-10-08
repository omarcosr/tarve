import { describe, expect, test } from "bun:test";
import { Window, Column, Text } from "./components";
import { compileTree } from "./reconciler";
import { VirtualList } from "./virtual-list";

describe("VirtualList without a height", () => {
  const items = Array.from({ length: 1000 }, (_, i) => `item ${i}`);
  const view = () => (
    <Window title="fill">
      <Column flex={1}>
        <VirtualList id="list" items={items} itemHeight={20} offset={0} onScroll={() => {}}
          renderItem={(item, i) => <Text id={`row-${i}`}>{item}</Text>} />
      </Column>
    </Window>
  );

  test("fills its parent and asks native for its size", () => {
    const tree = compileTree(view(), false, "auto", [], {});
    const list = tree.nodes.get("list")!;
    expect(list.style.flex).toBe(1);
    expect(list.style.height).toBeUndefined();
    expect(list.reportSize).toBe(true);
  });

  test("renders the rows its reported height shows, and follows a resize", () => {
    const scope = {};
    const rows = (tree: ReturnType<typeof compileTree>) => [...tree.nodes.keys()].filter(id => id.startsWith("row-")).length;
    const first = compileTree(view(), false, "auto", [], scope);
    // Before layout: an estimate of 800px (40 rows + overscan).
    expect(rows(first)).toBe(42);
    first.handlers.get("list")!.onSize!({ width: 300, height: 200 });
    expect(rows(compileTree(view(), false, "auto", [], scope))).toBe(12);
    first.handlers.get("list")!.onSize!({ width: 300, height: 1000 });
    expect(rows(compileTree(view(), false, "auto", [], scope))).toBe(52);
  });

  test("needs an id", () => {
    expect(() => compileTree(<Window title="x"><VirtualList items={items} itemHeight={20} offset={0} onScroll={() => {}} renderItem={item => <Text>{item}</Text>} /></Window>))
      .toThrow("needs an id");
  });
});
