import { describe, expect, test } from "bun:test";
import { Window, Column, Text, Button, Input, TitleBar, Modal, Pressable } from "./components";
import { compileTree, diffTrees } from "./reconciler";
import { createTheme, darkTheme, lightTheme, Theme, theme } from "./theme";

describe("native TSX protocol", () => {
  test("compiles function components, flattens children, and keeps callbacks outside JSON", () => {
    let clicked = false;
    const tree = compileTree(<Window title="Test"><Column>{null}<Text>Hello {2}</Text><Button id="button" onClick={() => { clicked = true; }}>Click</Button><Input id="input" value="Olá"/></Column></Window>);
    expect(tree.document.root.kind).toBe("window");
    expect(tree.document.root.children[0].children[0].text).toBe("Hello 2");
    expect(tree.nodes.get("input")?.inputType).toBe("text");
    expect(JSON.stringify(tree.document)).not.toContain("onClick");
    tree.handlers.get("button")?.onClick?.();
    expect(clicked).toBe(true);
  });
  test("Input serializes native input types and validates number values", () => {
    const password = compileTree(<Window><Input id="password" type="password" value="secret" /></Window>);
    expect(password.nodes.get("password")?.inputType).toBe("password");
    const number = compileTree(<Window><Input id="number" type="number" value="-12.5e2" /></Window>);
    expect(number.nodes.get("number")?.inputType).toBe("number");
    expect(() => compileTree(<Window><Input type="number" value="12x" /></Window>)).toThrow("valid numeric edit value");
  });
  test("keyed identities survive reordering", () => {
    const build = (values: string[]) => compileTree(<Window><Column>{values.map(v => <Text key={v}>{v}</Text>)}</Column></Window>);
    const a = build(["a", "b"]).document.root.children[0].children;
    const b = build(["b", "a"]).document.root.children[0].children;
    expect(a[0].id).toBe(b[1].id);
  });
  test("rejects duplicate IDs and invalid roots", () => {
    expect(() => compileTree(<Window><Text id="same">a</Text><Text id="same">b</Text></Window>)).toThrow("Duplicate");
    expect(() => compileTree(<Column/>)).toThrow("Window root");
  });
  test("sends only changed properties and detects structural updates", () => {
    const view = (value: string) => compileTree(<Window><Column><Text id="label">{value}</Text><Button id="button">Save</Button></Column></Window>);
    const a = view("Before");
    expect(diffTrees(a, view("Before"))).toEqual([]);
    const changes = diffTrees(a, view("After"))!;
    expect(changes.map(node => node.id)).toEqual(["label"]);
    expect(changes[0].children).toEqual([]);
    expect(changes[0].text).toBe("After");
    expect(diffTrees(a, compileTree(<Window><Text id="label">After</Text></Window>))).toBeNull();
  });
  test("style snapshots detect mutations to shared inset objects", () => {
    const padding = { left: 8 };
    const view = () => compileTree(<Window><Column id="column" padding={padding}/></Window>);
    const before = view();
    padding.left = 20;
    expect(diffTrees(before, view())?.map(node => node.id)).toEqual(["column"]);
  });
  test("modal compiles as an absolute focus scope with dismiss handlers", () => {
    let open = true;
    const tree = compileTree(
      <Window>
        <Button id="behind">Behind</Button>
        <Modal id="dialog" open={open} title="Dialog" onOpenChange={(value) => { open = value; }}>
          <Input id="dialog-input" />
        </Modal>
      </Window>,
    );
    const dialog = tree.nodes.get("dialog")!;
    const dialogContent = tree.nodes.get("dialog-content")!;
    expect(dialog.kind).toBe("pressable");
    expect(dialog.modal).toBeUndefined();
    expect(dialogContent.modal).toBe(true);
    expect(dialogContent.control).toEqual({ role: "group", label: "Dialog", description: "" });
    expect(dialog.focusable).toBe(false);
    expect(dialog.style.position).toBe("absolute");
    expect(dialog.style.top).toBe(0);
    expect(dialog.style.right).toBe(0);
    expect(dialog.style.bottom).toBe(0);
    expect(dialog.style.left).toBe(0);
    tree.handlers.get("dialog")?.onEscape?.();
    expect(open).toBe(false);
  });
  test("TitleBar automatically selects custom chrome and emits native window actions", () => {
    const tree = compileTree(
      <Window title="App" resizable>
        <TitleBar id="titlebar" title="App" />
      </Window>,
    );
    expect(tree.document.window.decorations).toBe(false);
    expect(tree.document.window.resizable).toBe(true);
    expect(tree.document.root.style.borderWidth).toBe(1);
    expect(tree.document.root.style.borderColor).toBe("#e4e4e7");
    expect(tree.document.root.style.radius).toBe(8);
    expect(tree.nodes.get("titlebar")?.dragRegion).toBe(true);
    expect(tree.nodes.get("titlebar")?.style.borderWidth).toEqual({ bottom: 1 });
    const actions = [...tree.nodes.values()].map(node => node.windowAction).filter(Boolean);
    expect(actions).toEqual(["minimize", "toggleMaximize", "close"]);
    const actionLabels = [...tree.nodes.values()]
      .filter(node => Boolean(node.windowAction))
      .map(node => node.control?.label);
    expect(actionLabels).toEqual(["Minimize window", "Maximize or restore window", "Close window"]);
  });
  test("Window keeps native chrome when no TitleBar is present", () => {
    const tree = compileTree(<Window title="Native"><Text>Hello</Text></Window>);
    expect(tree.document.window.decorations).toBe(true);
    expect(tree.document.window.position).toBe("center");
    expect(tree.document.root.closeIntercept).toBeUndefined();
    expect(tree.document.root.style.borderWidth).toBeUndefined();
    expect(tree.document.root.style.radius).toBeUndefined();
  });
  test("Window close requests stay in JS handlers while native receives an intercept flag", () => {
    let requested = false;
    const tree = compileTree(<Window onCloseRequest={() => { requested = true; }}><Text>Hello</Text></Window>);
    expect(tree.document.version).toBe(28);
    expect(tree.document.root.closeIntercept).toBe(true);
    expect(JSON.stringify(tree.document)).not.toContain("onCloseRequest");
    tree.handlers.get(tree.document.root.id)?.onCloseRequest?.({ defaultPrevented: false, preventDefault() {} });
    expect(requested).toBe(true);
  });
  test("Window serializes explicit coordinates and initial position presets", () => {
    const explicit = compileTree(<Window position={{ x: 120, y: -40 }}><Text>Hello</Text></Window>);
    expect(explicit.document.window.position).toEqual({ x: 120, y: -40 });

    for (const position of ["top-left", "top", "top-right", "left", "center", "right", "bottom-left", "bottom", "bottom-right"] as const) {
      const tree = compileTree(<Window position={position}><Text>Hello</Text></Window>);
      expect(tree.document.window.position).toBe(position);
    }
  });
  test("TitleBar is detected through component composition", () => {
    const Shell = () => <Column><TitleBar title="Nested" /><Text>Body</Text></Column>;
    const tree = compileTree(<Window><Shell /></Window>);
    expect(tree.document.window.decorations).toBe(false);
    expect([...tree.nodes.values()].filter(node => node.kind === "titlebar")).toHaveLength(1);
  });
  test("dark theme resolves semantic component colors without changing component code", () => {
    const light = compileTree(
      <Window theme={lightTheme}>
        <Column>
          <Text id="label">Hello</Text>
          <Input id="input" placeholder="Name" />
          <Button id="button">Save</Button>
        </Column>
      </Window>,
    );
    const dark = compileTree(
      <Window theme={darkTheme}>
        <Column>
          <Text id="label">Hello</Text>
          <Input id="input" placeholder="Name" />
          <Button id="button">Save</Button>
        </Column>
      </Window>,
    );
    expect(light.document.root.style.background).toBe("#fafafa");
    expect(dark.document.root.style.background).toBe("#09090b");
    expect(dark.nodes.get("label")?.style.foreground).toBe("#fafafa");
    expect(dark.nodes.get("input")?.style.background).toBe("#18181b");
    expect(dark.nodes.get("input")?.style.placeholderColor).toBe("#71717a");
    expect(dark.nodes.get("button")?.style.background).toBe("#fafafa");
    expect(diffTrees(light, dark)?.length).toBeGreaterThan(0);
  });
  test("custom themes inherit a base palette and resolve theme tokens in user styles", () => {
    const midnight = createTheme({ colors: { primary: "#8b5cf6", border: "#3f3f46" } }, darkTheme);
    const tree = compileTree(
      <Window theme={midnight}>
        <TitleBar />
        <Button id="accent">Accent</Button>
        <Column id="panel" style={{ background: theme.colors.card, borderColor: theme.colors.border }} />
      </Window>,
    );
    expect(tree.nodes.get("accent")?.style.background).toBe("#8b5cf6");
    expect(tree.nodes.get("panel")?.style.background).toBe(darkTheme.colors.card);
    expect(tree.nodes.get("panel")?.style.borderColor).toBe("#3f3f46");
    expect(tree.document.root.style.borderColor).toBe("#3f3f46");
  });
  test("Theme.create composes a conditional base theme without spreading ThemeDefinition", () => {
    const noOutlineDark = Theme.create(darkTheme, {
      focusOutline: { outlineWidth: 0, outlineStyle: "none" },
    });
    const tree = compileTree(
      <Window theme={noOutlineDark}>
        <Button id="button">Save</Button>
      </Window>,
    );
    expect(tree.document.root.style.background).toBe(darkTheme.colors.background);
    expect(tree.nodes.get("button")?.style.focus?.outlineWidth).toBe(0);
    expect(tree.nodes.get("button")?.style.focus?.outlineStyle).toBe("none");
  });
  test("literal colors remain literal when a theme is active", () => {
    const tree = compileTree(
      <Window theme={darkTheme}>
        <Column id="literal" style={{ background: "#123456" }} />
      </Window>,
    );
    expect(tree.nodes.get("literal")?.style.background).toBe("#123456");
  });
  test("focus outline defaults are configurable per theme and merge with local focus styles", () => {
    const custom = createTheme({ focusOutline: {
      outlineWidth: 1,
      outlineColor: "#8b5cf6",
      outlineOffset: 0,
      outlineRadius: 4,
      outlineStyle: "dashed",
    } });
    const tree = compileTree(
      <Window theme={custom}>
        <Button id="themed-focus">Save</Button>
        <Input id="local-focus" style={{ focus: { outlineWidth: 3 } }} />
        <Pressable id="not-focusable" focusable={false}>No focus</Pressable>
      </Window>,
    );
    expect(tree.nodes.get("themed-focus")?.style.focus).toEqual({
      outlineWidth: 1,
      outlineColor: "#8b5cf6",
      outlineOffset: 0,
      outlineRadius: 4,
      outlineStyle: "dashed",
    });
    expect(tree.nodes.get("local-focus")?.style.focus).toEqual({
      outlineWidth: 3,
      outlineColor: "#8b5cf6",
      outlineOffset: 0,
      outlineRadius: 4,
      outlineStyle: "dashed",
    });
    expect(tree.nodes.get("not-focusable")?.style.focus).toBeUndefined();
  });
  test("focus outline can be disabled globally by the theme", () => {
    const noOutline = createTheme({ focusOutline: { outlineWidth: 0, outlineStyle: "none" } });
    const tree = compileTree(<Window theme={noOutline}><Button id="button">Save</Button></Window>);
    expect(tree.nodes.get("button")?.style.focus?.outlineWidth).toBe(0);
    expect(tree.nodes.get("button")?.style.focus?.outlineStyle).toBe("none");
  });
  test("borderWidth supports independent widths on all four sides", () => {
    const tree = compileTree(
      <Window>
        <Column id="panel" style={{ borderWidth: { top: 1, right: 2, bottom: 3, left: 4 } }} />
      </Window>,
    );
    expect(tree.nodes.get("panel")?.style.borderWidth).toEqual({ top: 1, right: 2, bottom: 3, left: 4 });
  });
  test("nested states are stylable and resolve theme colors", () => {
    const tree = compileTree(
      <Window theme={darkTheme}>
        <Column
          id="panel"
          style={{
            outlineWidth: 3,
            outlineColor: theme.colors.ring,
            outlineOffset: 4,
            outlineRadius: 12,
            outlineStyle: "dashed",
            hover: { background: theme.colors.muted, borderColor: theme.colors.border },
            active: { background: theme.colors.secondaryActive },
            focus: {
              outlineWidth: 2,
              outlineColor: theme.colors.primary,
              outlineOffset: 2,
              outlineRadius: 10,
              outlineStyle: "dotted",
            },
            disabled: { background: theme.colors.disabled, foreground: theme.colors.disabledForeground },
          }}
        />
      </Window>,
    );
    const style = tree.nodes.get("panel")?.style;
    expect(style?.outlineWidth).toBe(3);
    expect(style?.outlineColor).toBe(darkTheme.colors.ring);
    expect(style?.outlineOffset).toBe(4);
    expect(style?.outlineRadius).toBe(12);
    expect(style?.outlineStyle).toBe("dashed");
    expect(style?.hover).toEqual({ background: darkTheme.colors.muted, borderColor: darkTheme.colors.border });
    expect(style?.active).toEqual({ background: darkTheme.colors.secondaryActive });
    expect(style?.focus).toEqual({
      outlineWidth: 2,
      outlineColor: darkTheme.colors.primary,
      outlineOffset: 2,
      outlineRadius: 10,
      outlineStyle: "dotted",
    });
    expect(style?.disabled).toEqual({
      background: darkTheme.colors.disabled,
      foreground: darkTheme.colors.disabledForeground,
    });
  });
  test("nested state objects compare deeply and do not create spurious patches", () => {
    const view = () => compileTree(
      <Window>
        <Button id="button" style={{ hover: { background: theme.colors.muted }, focus: { outlineWidth: 2 } }}>
          Save
        </Button>
      </Window>,
    );
    expect(diffTrees(view(), view())).toEqual([]);
  });
  test("supports every outlineStyle value", () => {
    const styles = ["dotted", "dashed", "solid", "double", "groove", "ridge", "inset", "outset", "none", "hidden"] as const;
    const tree = compileTree(
      <Window>
        <Column>
          {styles.map((outlineStyle) => (
            <Column key={outlineStyle} id={`outline-${outlineStyle}`} style={{ outlineWidth: 3, outlineStyle }} />
          ))}
        </Column>
      </Window>,
    );
    for (const outlineStyle of styles) {
      expect(tree.nodes.get(`outline-${outlineStyle}`)?.style.outlineStyle).toBe(outlineStyle);
    }
  });
});
