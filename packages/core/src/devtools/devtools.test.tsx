import { describe, expect, test } from "bun:test";
import type { NativeCommand, NativeEvent, NativeNode, SceneDocument, Snapshot } from "../protocol";
import type { NativeBridge } from "../bridge";
import { createApp } from "../app";
import { compileTree } from "../reconciler";
import { Button, Column, Row, Text, Window } from "../components";
import { memo } from "../memo";
import { ComponentTracer, componentName } from "./trace";
import { ancestorKeys, buildInspectorTree, describeValue, expandToDepth, flattenTree, hitTest, indexTree, stepSelection, type InspectorNode, type Rect } from "./tree";
import { INSPECTOR_CAPTURE_ID, INSPECTOR_HIGHLIGHT_ID, INSPECTOR_WINDOW_ID } from "./inspector";
import { INSPECTOR_PICK_ID } from "./view";

function Label(props: { text: string }) {
  return <Text id={`label-${props.text}`}>{props.text}</Text>;
}
const MemoLabel = memo(Label);
function Pair() {
  return <><Text id="left">L</Text><Text id="right">R</Text></>;
}
function Panel(props: { count: number; pinned: string }) {
  return (
    <Column id="panel">
      <Label text={`count ${props.count}`} />
      <MemoLabel text={props.pinned} />
      <Pair />
    </Column>
  );
}

const names = (node: InspectorNode, depth = 0): string[] =>
  [`${"  ".repeat(depth)}${node.kind === "component" ? `<${node.name}>` : node.name}`, ...node.children.flatMap(child => names(child, depth + 1))];

describe("devtools component trace", () => {
  test("joins components and native nodes into one tree, fragments wrapped once", () => {
    const tracer = new ComponentTracer();
    const tree = tracer.trace(() => compileTree(<Window><Panel count={0} pinned="pin" /></Window>, false, "auto", [], {}));
    const root = buildInspectorTree(tree.document.root, tracer.frames);
    expect(names(root)).toEqual([
      "<Window>", "  window", "    <Panel>", "      <Column>", "        column",
      "          <Label>", "            <Text>", "              text",
      // memo() renders its function inline: the memo component wraps what Label returned.
      "          <memo(Label)>", "            <Text>", "              text",
      "          <Pair>", "            <Text>", "              text", "            <Text>", "              text",
    ]);
    const pair = indexTree(root).get(`c:${tracer.frames[0]!.children[0]!.children[0]!.children[2]!.key}`);
    expect(pair?.node.name).toBe("Pair");
    expect(pair?.node.frame?.roots).toEqual(["left", "right"]);
  });

  test("counts renders per component; a reused memo subtree does not count", () => {
    const tracer = new ComponentTracer();
    const scope = {};
    const view = (count: number, pinned: string) => compileTree(<Window><Panel count={count} pinned={pinned} /></Window>, false, "auto", [], scope);
    for (let count = 0; count < 3; count++) tracer.trace(() => view(count, "same"));
    const byName = (name: string) => [...tracer.renders].filter(([key]) => key.endsWith(`|${name}`)).map(([, n]) => n);
    expect(byName("Panel")).toEqual([3]);
    expect(byName("memo(Label)")).toEqual([1]);
    expect(byName("Label")).toEqual([3]);
    const memoFrame = tracer.frames[0]!.children[0]!.children[0]!.children[1]!;
    expect(memoFrame.rendered).toBe(false);
    // The reused subtree keeps the components recorded inside it.
    expect(memoFrame.children.map(child => child.name)).toEqual(["Text"]);
    expect(byName("Text").sort()).toEqual([1, 3, 3, 3]);
    tracer.trace(() => view(3, "changed"));
    expect(byName("memo(Label)")).toEqual([2]);
    // A quiet render (the inspector's own highlight move) records the tree without counting.
    tracer.trace(() => view(4, "changed"), false);
    expect(byName("Panel")).toEqual([4]);
  });

  test("drops counts of unmounted components and names anonymous ones", () => {
    const tracer = new ComponentTracer();
    tracer.trace(() => compileTree(<Window><Panel count={0} pinned="a" /></Window>, false, "auto", [], {}));
    expect([...tracer.renders.keys()].some(key => key.endsWith("|Panel"))).toBe(true);
    tracer.trace(() => compileTree(<Window><Text>gone</Text></Window>, false, "auto", [], {}));
    expect([...tracer.renders.keys()].some(key => key.endsWith("|Panel"))).toBe(false);
    expect(componentName((() => <Text />) as never)).toBe("Anonymous");
    const named = Object.assign(() => <Text />, { displayName: "Fancy" });
    expect(componentName(named)).toBe("Fancy");
  });
});

describe("devtools tree selection", () => {
  const tracer = new ComponentTracer();
  const compiled = tracer.trace(() => compileTree(<Window><Panel count={1} pinned="p" /></Window>, false, "auto", [], {}));
  const root = buildInspectorTree(compiled.document.root, tracer.frames);
  const index = indexTree(root);

  test("flattens expanded nodes, labels hosts and truncates", () => {
    const collapsed = flattenTree(root, new Set());
    expect(collapsed.rows.map(row => row.label)).toEqual(["Window"]);
    const all = flattenTree(root, expandToDepth(root, Infinity));
    expect(all.rows.length).toBe(index.size);
    expect(all.rows.find(row => row.kind === "host" && row.id === "left")?.label).toBe('text #left "L"');
    expect(all.rows.find(row => row.kind === "host" && row.label.startsWith("window"))?.label).toBe("window");
    const capped = flattenTree(root, expandToDepth(root, Infinity), 5);
    expect(capped.rows.length).toBe(5);
    expect(capped.truncated).toBe(index.size - 5);
  });

  test("reveals a node's ancestors and steps through visible rows", () => {
    const ancestors = ancestorKeys(index, "h:right")!;
    expect(ancestors[0]).toBe(root.key);
    expect(ancestors.at(-1)?.endsWith("|Text")).toBe(true);
    expect(ancestorKeys(index, "h:missing")).toBeUndefined();
    const { rows } = flattenTree(root, new Set(ancestors));
    expect(rows.at(-1)?.key).toBe("h:right");
    expect(stepSelection(rows, undefined, 1)).toBe(rows[0]!.key);
    expect(stepSelection(rows, rows[1]!.key, -1)).toBe(rows[0]!.key);
    expect(stepSelection(rows, rows.at(-1)!.key, 5)).toBe(rows.at(-1)!.key);
  });

  test("hit testing finds the innermost node and respects clipping and order", () => {
    const node = (id: string, children: NativeNode[] = [], style: NativeNode["style"] = {}, kind: NativeNode["kind"] = "view"): NativeNode => ({ id, kind, style, children });
    const tree = node("root", [
      node("scroll", [node("row", [], {}, "row")], {}, "scroll"),
      node("under", []),
      node("over", []),
    ], {}, "window");
    const boxes = new Map<string, Rect>([
      ["root", { x: 0, y: 0, width: 400, height: 300 }],
      ["scroll", { x: 0, y: 0, width: 200, height: 100 }],
      ["row", { x: 0, y: 50, width: 200, height: 200 }],
      ["under", { x: 250, y: 0, width: 100, height: 100 }],
      ["over", { x: 250, y: 0, width: 100, height: 100 }],
    ]);
    expect(hitTest(tree, boxes, 10, 60)).toBe("row");
    // The row overflows its scroll container below 100: clipped.
    expect(hitTest(tree, boxes, 10, 150)).toBe("root");
    expect(hitTest(tree, boxes, 260, 10)).toBe("over");
    expect(hitTest(tree, boxes, 260, 10, id => id === "over")).toBe("under");
    expect(hitTest(tree, boxes, 500, 500)).toBeUndefined();
  });

  test("describes props without dumping functions, nodes or cycles", () => {
    const cycle: Record<string, unknown> = { a: 1 };
    cycle.self = cycle;
    expect(describeValue(function onClick() {})).toBe("ƒ onClick()");
    expect(describeValue(<Text>x</Text>)).toBe("<Text />");
    expect(describeValue(cycle)).toBe("{ a: 1, self: [circular] }");
    expect(describeValue({ deep: { deeper: { deepest: 1 } } })).toBe("{ deep: { deeper: {…} } }");
    expect(describeValue(Array.from({ length: 10 }, (_, i) => i))).toBe("[0, 1, 2, 3, 4, 5, 6, 7, …2 more]");
  });
});

class InspectBridge implements NativeBridge {
  commands: NativeCommand[] = [];
  document?: SceneDocument;
  inspectorDocument?: SceneDocument;
  boxes: Snapshot["nodes"] = [];
  private listener?: (event: NativeEvent) => void;
  start(document: SceneDocument, onEvent: (event: NativeEvent) => void): void {
    this.document = document;
    this.listener = onEvent;
    onEvent({ type: "ready" });
  }
  send(command: NativeCommand): void {
    this.commands.push(command);
    if (command.type === "openWindow") {
      this.inspectorDocument = command.document;
      queueMicrotask(() => this.emit({ type: "ready", window: command.window } as NativeEvent));
    }
    if (command.type === "inspect") {
      const snapshot = { frames: 1, nodes: this.boxes, hovered: null, focused: null, width: 400, height: 300, scale: 1 } as unknown as Snapshot;
      queueMicrotask(() => this.emit({ type: "inspect", requestId: command.requestId, snapshot }));
    }
  }
  join(): void {}
  emit(event: NativeEvent): void { this.listener?.(event); }
  inWindow(event: Record<string, unknown>): void { this.emit({ ...event, window: INSPECTOR_WINDOW_ID } as unknown as NativeEvent); }
  /** Every text the inspector window holds (its first document plus later updates). */
  inspectorTexts(): string {
    const texts: string[] = [];
    const walk = (node: NativeNode) => { if (node.text) texts.push(node.text); node.children.forEach(walk); };
    for (const command of this.commands) {
      if (command.type === "openWindow") walk(command.document.root);
      if (command.type === "toWindow" && command.window === INSPECTOR_WINDOW_ID) {
        const inner = command.command;
        if (inner.type === "update") walk(inner.root);
        if (inner.type === "patch") inner.nodes.forEach(walk);
        if (inner.type === "mutate") for (const mutation of inner.mutations) if ("node" in mutation && mutation.node) walk(mutation.node as NativeNode);
      }
    }
    return texts.join("\n");
  }
  appNodeIds(): string[] {
    const last = [...this.commands].reverse().find(command => command.type === "update" || command.type === "mutate" || command.type === "patch");
    const ids: string[] = [];
    const walk = (node: NativeNode) => { ids.push(node.id); node.children.forEach(walk); };
    if (!last) walk(this.document!.root);
    else if (last.type === "update") walk(last.root);
    else if (last.type === "patch") last.nodes.forEach(walk);
    else for (const mutation of last.mutations) if ("node" in mutation && mutation.node) walk(mutation.node as NativeNode);
    return ids;
  }
}

describe("devtools inspector window", () => {
  test("opens a window with the component tree, render counts and the event log", async () => {
    const bridge = new InspectBridge();
    let count = 0;
    const app = createApp(() => (
      <Window title="Inspected">
        <Panel count={count} pinned="pin" />
        <Button id="bump" onClick={() => { count++; }}>Bump</Button>
      </Window>
    ), { bridge, dev: { inspector: true } });
    await app.ready;
    await Bun.sleep(10);
    const open = bridge.commands.find(command => command.type === "openWindow");
    expect(open?.type === "openWindow" && open.window).toBe(INSPECTOR_WINDOW_ID);
    expect(bridge.inspectorTexts()).toContain("<Panel>");
    expect(bridge.inspectorTexts()).toContain("<memo(Label)>");

    // Each click renders once (two in one task would batch into one render).
    bridge.emit({ type: "click", id: "bump" });
    await Bun.sleep(5);
    bridge.emit({ type: "click", id: "bump" });
    await Bun.sleep(80);
    const texts = bridge.inspectorTexts();
    expect(texts).toContain("×3");
    expect(texts).toMatch(/click #bump/);
    app.close();
  });

  test("picker mode overlays the app window, highlights the hovered node and selects it on click", async () => {
    const bridge = new InspectBridge();
    bridge.boxes = [
      { id: "root", kind: "window", x: 0, y: 0, width: 400, height: 300 },
      { id: "panel", kind: "column", x: 0, y: 0, width: 400, height: 100 },
      { id: "left", kind: "text", x: 10, y: 60, width: 30, height: 20 },
      { id: INSPECTOR_CAPTURE_ID, kind: "pressable", x: 0, y: 0, width: 400, height: 300 },
    ] as Snapshot["nodes"];
    const app = createApp(() => <Window><Panel count={0} pinned="p" /></Window>, { bridge, dev: { inspector: true } });
    await app.ready;
    await Bun.sleep(10);

    bridge.inWindow({ type: "click", id: INSPECTOR_PICK_ID });
    await Bun.sleep(20);
    expect(bridge.appNodeIds()).toContain(INSPECTOR_CAPTURE_ID);

    bridge.emit({ type: "pointerMove", id: INSPECTOR_CAPTURE_ID, x: 15, y: 65 });
    await Bun.sleep(20);
    expect(bridge.appNodeIds()).toContain(INSPECTOR_HIGHLIGHT_ID);
    // The inspector's own pointer tracking is not an app event.
    await Bun.sleep(60);
    expect(bridge.inspectorTexts()).not.toMatch(/pointerMove/);

    bridge.emit({ type: "click", id: INSPECTOR_CAPTURE_ID });
    await Bun.sleep(80);
    expect(bridge.appNodeIds()).not.toContain(INSPECTOR_CAPTURE_ID);
    const texts = bridge.inspectorTexts();
    expect(texts).toContain("Style (resolved)");
    expect(texts).toContain("left");
    app.close();
  });

  test("tree rows never collide with anonymous ids (keys contain `/`)", async () => {
    const bridge = new InspectBridge();
    const errors: string[] = [];
    const app = createApp(() => <Window><Column><Column><Label text="deep" /></Column></Column></Window>, {
      bridge, dev: { inspector: true }, onError: event => errors.push(event.error.message),
    });
    await app.ready;
    await Bun.sleep(80);
    expect(errors).toEqual([]);
    expect(bridge.inspectorTexts()).toContain("<Label>");
    app.close();
  });

  test("child windows and dev: false never open an inspector", async () => {
    const bridge = new InspectBridge();
    const app = createApp(() => <Window><Row /></Window>, { bridge, dev: false });
    await app.ready;
    app.openWindow(() => <Window><Row /></Window>, { id: "other", dev: { inspector: true } });
    await Bun.sleep(20);
    expect(bridge.commands.filter(command => command.type === "openWindow").map(command => command.type === "openWindow" && command.window)).toEqual(["other"]);
    app.close();
  });
});
