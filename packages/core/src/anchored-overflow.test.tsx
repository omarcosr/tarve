import { describe, expect, test } from "bun:test";
import { Button, Image, Input, Modal, Overflow, overflowVisibleCount, Pressable, Scroll, Text, View, Window } from "./components";
import type { SizeEvent } from "./jsx-runtime";
import { Flyout } from "./popups";
import { compileTree } from "./reconciler";

const size = (width: number, height = 20): SizeEvent => ({ width, height, borderBox: { width, height } });

describe("Modal bounded by the window", () => {
  test("header and footer stay fixed and the body scrolls", () => {
    const tree = compileTree(
      <Window>
        <Modal id="dialog" open title="Title" footer={<Button id="ok">OK</Button>}>
          <Input id="first" />
          <Input id="second" />
        </Modal>
      </Window>,
    );
    const panel = tree.nodes.get("dialog-content")!;
    expect(panel.style.maxHeight).toBe("100%");
    const body = tree.nodes.get("dialog-body")!;
    expect(body.kind).toBe("scroll");
    expect(body.style).toMatchObject({ direction: "column", gap: 20, minHeight: 0, shrink: 1 });
    expect(body.children?.map(child => child.id)).toEqual(["first", "second"]);
    const [header, , , footer] = panel.children!;
    expect(header.style.shrink).toBe(0);
    expect(footer.style.shrink).toBe(0);
    expect(panel.children?.[2]?.id).toBe("dialog-body");
  });

  test("scrollBody={false} keeps the body in the panel", () => {
    const tree = compileTree(<Window><Modal id="plain" open scrollBody={false}><Input id="field" /></Modal></Window>);
    expect(tree.nodes.has("plain-body")).toBe(false);
    expect(tree.nodes.get("plain-content")?.children?.some(child => child.id === "field")).toBe(true);
  });
});

describe("onSize typing", () => {
  test("components infer SizeEvent without annotations", () => {
    const widths: number[] = [];
    const nodes = [
      <Pressable onSize={({ borderBox }) => widths.push(borderBox.width)} />,
      <Pressable {...(widths.length ? {} : { draggable: true })} onSize={({ borderBox }) => widths.push(borderBox.width)} />,
      <Button onSize={({ borderBox }) => widths.push(borderBox.width)}>x</Button>,
      <Text onSize={({ width }) => widths.push(width)}>x</Text>,
      <Scroll onSize={({ height }) => widths.push(height)} />,
      <Image src="a.png" onSize={({ borderBox }) => widths.push(borderBox.height)} />,
      <View onSize={({ borderBox }) => widths.push(borderBox.width)} />,
    ];
    expect(nodes).toHaveLength(7);
  });
});

describe("Flyout", () => {
  const view = (open: boolean, changes: boolean[], extra: Record<string, unknown> = {}) => compileTree(
    <Window>
      <Flyout id="menu" open={open} anchor={<Text>More</Text>} onOpenChange={value => changes.push(value)} {...extra}>
        <Text>Item</Text>
      </Flyout>
    </Window>,
  );

  test("the anchor toggles it and a press outside closes it", () => {
    const changes: boolean[] = [];
    const closed = view(false, changes);
    expect(closed.nodes.has("menu-content")).toBe(false);
    expect(closed.nodes.get("menu-anchor")?.control).toMatchObject({ role: "button", expanded: false });
    closed.handlers.get("menu-anchor")?.onClick?.();
    const open = view(true, changes);
    const content = open.nodes.get("menu-content")!;
    expect(content.portal).toBe(true);
    expect(content.dismissOnOutside).toBe(true);
    expect(content.style).toMatchObject({ position: "absolute", top: "100%", left: 0, zIndex: 1001 });
    expect(content.style.background).toBeUndefined();
    open.handlers.get("menu-content")?.onOutsideClick?.();
    open.handlers.get("menu-anchor")?.onClick?.();
    open.handlers.get("menu-anchor")?.onEscape?.();
    expect(changes).toEqual([true, false, false, false]);
  });

  test("placement aligns the end edge and validates", () => {
    const tree = view(true, [], { placement: "top-end", offset: 2 });
    expect(tree.nodes.get("menu-content")?.style).toMatchObject({ bottom: "100%", right: 0, margin: { bottom: 2 } });
    expect(() => view(true, [], { placement: "middle" })).toThrow(TypeError);
  });

  test("lightDismiss={false} leaves outside presses alone; an interactive anchor keeps its node", () => {
    const changes: boolean[] = [];
    const tree = compileTree(
      <Window>
        <Flyout id="pinned" open lightDismiss={false} anchor={<Button id="pin">Pin</Button>} onOpenChange={value => changes.push(value)}>
          <Text>Body</Text>
        </Flyout>
      </Window>,
    );
    expect(tree.nodes.get("pinned-content")?.dismissOnOutside).toBeUndefined();
    expect(tree.nodes.get("pin")?.kind).toBe("button");
    tree.handlers.get("pin")?.onClick?.();
    expect(changes).toEqual([false]);
  });
});

describe("Overflow", () => {
  test("overflowVisibleCount keeps room for the overflow control", () => {
    expect(overflowVisibleCount([40, 40, 40], undefined, 10)).toBe(3);
    expect(overflowVisibleCount([40, 40, 40], 140, 10, 30)).toBe(3);
    expect(overflowVisibleCount([40, 40, 40], 139, 10, 30)).toBe(2);
    expect(overflowVisibleCount([40, 40, 40], 129, 10, 30)).toBe(1);
    expect(overflowVisibleCount([40, undefined, 40], 100, 10)).toBe(3);
    expect(overflowVisibleCount([200], 100, 0, 20)).toBe(0);
  });

  test("hides what does not fit from measured sizes, one render per layout", () => {
    const items = ["a", "b", "c"];
    const seen: string[][] = [];
    const view = () => compileTree(
      <Window>
        <Overflow id="bar" items={items} gap={10} itemKey={item => item} renderItem={item => <Text>{item}</Text>}
          renderOverflow={hidden => { seen.push(hidden); return <Text>{`+${hidden.length}`}</Text>; }} />
      </Window>,
    );
    const shown = (tree: ReturnType<typeof compileTree>) => tree.nodes.get("bar")!.children!
      .filter(child => child.style.display !== "none").map(child => child.id.split("k:")[1]);
    let tree = view();
    expect(shown(tree)).toEqual(["a", "b", "c"]);
    expect(seen).toEqual([]);
    tree.handlers.get("bar")?.onSize?.(size(100));
    for (const key of items) tree.handlers.get(`bar/children/k:${key}`)?.onSize?.(size(40));
    tree = view();
    expect(shown(tree)).toEqual(["a", "b", "\u0000overflow"]);
    expect(seen.at(-1)).toEqual(["c"]);
    tree.handlers.get("bar/children/k:\u0000overflow")?.onSize?.(size(30));
    tree.handlers.get("bar/children/k:c")?.onSize?.(size(0));
    tree = view();
    expect(shown(tree)).toEqual(["a", "\u0000overflow"]);
    expect(seen.at(-1)).toEqual(["b", "c"]);
    tree.handlers.get("bar")?.onSize?.(size(200));
    tree = view();
    expect(shown(tree)).toEqual(["a", "b", "c"]);
    expect(tree.nodes.get("bar")?.style).toMatchObject({ direction: "row", overflow: "hidden", gap: 10 });
  });

  test("column direction measures heights", () => {
    const tree = compileTree(<Window><Overflow id="col" direction="column" items={[1, 2]} renderItem={item => <Text>{String(item)}</Text>} /></Window>);
    expect(tree.nodes.get("col")?.style.direction).toBe("column");
    expect(() => compileTree(<Window><Overflow id="bad" direction={"grid" as "row"} items={[]} renderItem={() => null} /></Window>)).toThrow(TypeError);
  });
});
