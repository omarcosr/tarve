import { describe, expect, test } from "bun:test";
import { Window, View, Column, Row, Text, Button, Icon, Svg, Path, Circle, Image, Input, TextArea, TitleBar, Modal, Pressable } from "./components";
import { compileTree, diffTrees } from "./reconciler";
import { createTheme, darkTheme, lightTheme, Theme, theme } from "./theme";
import type { ComponentAdapter } from "./component-adapter";
import type { VNode } from "./jsx-runtime";

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
  test("renderer preference is serialized at document scope", () => {
    expect(compileTree(<Window />).document.renderer).toBe("auto");
    expect(compileTree(<Window />, false, "cpu").document.renderer).toBe("cpu");
    expect(compileTree(<Window />, false, "gpu").document.renderer).toBe("gpu");
  });
  test("intrinsic div compiles to a native view with CSS-like aliases", () => {
    let entered = 0;
    let left = 0;
    let hovered: boolean | undefined;
    let clicks = 0;
    const tree = compileTree(
      <Window>
        <div
          id="intrinsic-div"
          gap={4}
          padding={6}
          align="center"
          justify="between"
          style={{
            display: "flex",
            flexDirection: "row",
            backgroundColor: "#123456",
            color: "#abcdef",
            gap: 9,
          }}
          onClick={() => { clicks++; }}
          onHover={(value) => { hovered = value; }}
          onMouseEnter={() => { entered++; }}
          onMouseLeave={() => { left++; }}
        >
          <Text id="inside-div">Hello</Text>
        </div>
      </Window>,
    );
    const div = tree.nodes.get("intrinsic-div")!;
    expect(div.kind).toBe("view");
    expect(div.style.direction).toBe("row");
    expect(div.style.background).toBe("#123456");
    expect(div.style.foreground).toBe("#abcdef");
    expect(div.style.gap).toBe(9);
    expect(div.style.padding).toBe(6);
    expect(div.style.align).toBe("center");
    expect(div.style.justify).toBe("between");
    expect((div.style as Record<string, unknown>).flexDirection).toBeUndefined();
    expect((div.style as Record<string, unknown>).backgroundColor).toBeUndefined();
    expect((div.style as Record<string, unknown>).color).toBeUndefined();
    expect(div.children.map(child => child.id)).toEqual(["inside-div"]);
    tree.handlers.get("intrinsic-div")?.onClick?.();
    tree.handlers.get("intrinsic-div")?.onHover?.(true);
    expect({ clicks, hovered, entered, left }).toEqual({ clicks: 1, hovered: true, entered: 1, left: 0 });
    tree.handlers.get("intrinsic-div")?.onHover?.(false);
    expect({ hovered, entered, left }).toEqual({ hovered: false, entered: 1, left: 1 });
  });
  test("intrinsic div canonicalizes to the same native shape as View and preserves Tarve style precedence", () => {
    const intrinsic = compileTree(
      <Window>
        <div
          id="box"
          gap={4}
          style={{
            gap: 8,
            flexDirection: "row",
            direction: "column",
            backgroundColor: "#ff0000",
            background: "#00ff00",
            color: "#111111",
            foreground: "#222222",
          }}
        />
      </Window>,
    );
    const explicit = compileTree(
      <Window>
        <View id="box" style={{ gap: 8, direction: "column", background: "#00ff00", foreground: "#222222" }} />
      </Window>,
    );
    expect(diffTrees(intrinsic, explicit)).toEqual([]);
    expect(intrinsic.nodes.get("box")?.style).toEqual(explicit.nodes.get("box")?.style);
  });
  test("intrinsic div alias changes produce ordinary view patches instead of structural replacements", () => {
    const before = compileTree(<Window><div id="box" style={{ backgroundColor: "#111111" }} /></Window>);
    const after = compileTree(<Window><div id="box" style={{ backgroundColor: "#222222" }} /></Window>);
    expect(diffTrees(before, after)?.map(node => node.id)).toEqual(["box"]);
    expect(diffTrees(before, after)?.[0].kind).toBe("view");
  });
  test("span, img and input intrinsics reuse the existing native component semantics", () => {
    let changed = "";
    const intrinsic = compileTree(
      <Window>
        <div>
          <span id="label" style={{ color: "#abcdef" }}>Hello</span>
          <img id="picture" src="./fixtures/pixel.png" width={40} height={24} fit="contain" style={{ backgroundColor: "#101010" }} />
          <input
            id="field"
            type="email"
            value="hello@example.com"
            placeholder="Email"
            style={{ color: "#eeeeee", backgroundColor: "#222222" }}
            onChange={(value) => { changed = value; }}
          />
        </div>
      </Window>,
    );
    const explicit = compileTree(
      <Window>
        <View>
          <Text id="label" style={{ foreground: "#abcdef" }}>Hello</Text>
          <Image id="picture" src="./fixtures/pixel.png" width={40} height={24} fit="contain" style={{ background: "#101010" }} />
          <Input
            id="field"
            type="email"
            value="hello@example.com"
            placeholder="Email"
            style={{ foreground: "#eeeeee", background: "#222222" }}
          />
        </View>
      </Window>,
    );
    expect(diffTrees(intrinsic, explicit)).toEqual([]);
    expect(intrinsic.nodes.get("label")?.kind).toBe("text");
    expect(intrinsic.nodes.get("picture")?.kind).toBe("image");
    expect(intrinsic.nodes.get("field")?.kind).toBe("input");
    expect(intrinsic.nodes.get("field")?.inputType).toBe("email");
    expect((intrinsic.nodes.get("label")?.style as Record<string, unknown>).color).toBeUndefined();
    expect((intrinsic.nodes.get("picture")?.style as Record<string, unknown>).backgroundColor).toBeUndefined();
    expect((intrinsic.nodes.get("field")?.style as Record<string, unknown>).color).toBeUndefined();
    intrinsic.handlers.get("field")?.onChange?.("next@example.com");
    expect(changed).toBe("next@example.com");
  });
  test("intrinsic input keeps Input validation and defaults", () => {
    const tree = compileTree(<Window><input id="field" placeholder="Value" /></Window>);
    const field = tree.nodes.get("field")!;
    expect(field.kind).toBe("input");
    expect(field.inputType).toBe("text");
    expect(field.style.height).toBe(38);
    expect(field.style.minWidth).toBe(120);
    expect(() => compileTree(<Window><input type="number" value="12x" /></Window>)).toThrow("valid numeric edit value");
  });
  test("p, button, textarea and svg intrinsics reuse their Tarve components", () => {
    let clicked = 0;
    let changed = "";
    const intrinsic = compileTree(
      <Window>
        <div>
          <p id="paragraph" style={{ color: "#345678" }}>Paragraph</p>
          <button id="action" variant="secondary" onClick={() => { clicked++; }} style={{ backgroundColor: "#123456" }}>Save</button>
          <textarea id="notes" value="Hello" placeholder="Notes" onChange={(value) => { changed = value; }} style={{ color: "#eeeeee" }} />
          <svg id="vector-intrinsic" size={32} viewBox="0 0 24 24" color="#abcdef">
            <Circle cx={12} cy={12} r={10} />
            <Path d="M6 12h12" />
          </svg>
        </div>
      </Window>,
    );
    const explicit = compileTree(
      <Window>
        <View>
          <Text id="paragraph" style={{ foreground: "#345678" }}>Paragraph</Text>
          <Button id="action" variant="secondary" style={{ background: "#123456" }}>Save</Button>
          <TextArea id="notes" value="Hello" placeholder="Notes" style={{ foreground: "#eeeeee" }} />
          <Svg id="vector-intrinsic" size={32} viewBox="0 0 24 24" color="#abcdef">
            <Circle cx={12} cy={12} r={10} />
            <Path d="M6 12h12" />
          </Svg>
        </View>
      </Window>,
    );
    expect(diffTrees(intrinsic, explicit)).toEqual([]);
    expect(intrinsic.nodes.get("paragraph")?.kind).toBe("text");
    expect(intrinsic.nodes.get("action")?.kind).toBe("button");
    expect(intrinsic.nodes.get("notes")?.kind).toBe("textarea");
    expect(intrinsic.nodes.get("vector-intrinsic")?.kind).toBe("svg");
    expect(intrinsic.nodes.get("vector-intrinsic")?.svg).toContain('<circle cx="12" cy="12" r="10"/>');
    intrinsic.handlers.get("action")?.onClick?.();
    intrinsic.handlers.get("notes")?.onChange?.("Updated");
    expect(clicked).toBe(1);
    expect(changed).toBe("Updated");
  });
  test("intrinsic button preserves composed Button semantics", () => {
    const tree = compileTree(
      <Window>
        <button id="composed-intrinsic">
          <Icon id="button-icon" name="plus" />
          <span id="button-label">Create</span>
        </button>
      </Window>,
    );
    const button = tree.nodes.get("composed-intrinsic")!;
    expect(button.kind).toBe("pressable");
    expect(button.control?.role).toBe("button");
    expect(button.control?.label).toBe("Create");
    expect(button.children.map(child => child.id)).toEqual(["button-icon", "button-label"]);
  });
  test("Svg serializes TSX geometry and Icon accepts external SVG node data", () => {
    type ExternalIconNode = ["circle" | "ellipse" | "g" | "line" | "path" | "polygon" | "polyline" | "rect", Record<string, string>][];
    const iconNode: ExternalIconNode = [
      ["circle", { cx: "12", cy: "12", r: "9" }],
      ["path", { d: "M8 12.5 10.7 15 16 9" }],
    ];
    const tree = compileTree(
      <Window>
        <Svg id="vector" size={32} viewBox="0 0 24 24">
          <Circle cx={12} cy={12} r={10} />
          <Path d="M6 12h12" />
        </Svg>
        <Icon id="external-icon" iconNode={iconNode} size={20} />
      </Window>,
    );
    const vector = tree.nodes.get("vector")!;
    expect(vector.kind).toBe("svg");
    expect(vector.children).toEqual([]);
    expect(vector.svg).toContain('viewBox="0 0 24 24"');
    expect(vector.svg).toContain('data-tarve-current-color="1"');
    expect(vector.svg).toContain('<circle cx="12" cy="12" r="10"/>');
    expect(vector.svg).toContain('<path d="M6 12h12"/>');
    expect(tree.nodes.get("external-icon")?.kind).toBe("svg");
    expect(tree.nodes.get("external-icon")?.svg).toContain('<circle cx="12" cy="12" r="9"/>');
    expect(tree.nodes.get("external-icon")?.svg).toContain('<path d="M8 12.5 10.7 15 16 9"/>');
  });
  test("component adapters translate foreign component types before normal component execution", () => {
    const ForeignComponent = () => { throw new Error("foreign component executed directly"); };
    const foreignNode: VNode = { type: ForeignComponent, props: { id: "foreign", size: 18 } };
    const adapter: ComponentAdapter = ({ type, props }) => type === ForeignComponent
      ? Svg({ id: String(props.id), size: Number(props.size), nodes: [["circle", { cx: 12, cy: 12, r: 10 }]] })
      : undefined;
    const tree = compileTree(Window({ children: foreignNode }), false, "auto", [adapter]);
    expect(tree.nodes.get("foreign")?.kind).toBe("svg");
    expect(tree.nodes.get("foreign")?.style.width).toBe(18);
    expect(() => compileTree(Window({ children: foreignNode }))).toThrow("foreign component executed directly");
  });
  test("Button keeps text buttons native and compiles composed children into one semantic pressable", () => {
    const tree = compileTree(
      <Window theme={darkTheme}>
        <Button id="text-button">Save</Button>
        <Button id="composed-button" variant="destructive">
          <Icon id="composed-icon" name="x" />
          <Text id="composed-label">Delete</Text>
          <Row id="composed-detail"><Text id="composed-item">item</Text></Row>
        </Button>
        <Button id="explicit-button" variant="default">
          <Icon id="explicit-icon" name="plus" color="#123456" />
          <Text id="explicit-label" color="#abcdef">Create</Text>
        </Button>
        <Button id="disabled-composed" disabled>
          <Text id="disabled-label">Disabled</Text>
        </Button>
      </Window>,
    );

    expect(tree.nodes.get("text-button")?.kind).toBe("button");
    expect(tree.nodes.get("text-button")?.text).toBe("Save");
    expect(tree.nodes.get("text-button")?.children).toEqual([]);

    const composed = tree.nodes.get("composed-button")!;
    expect(composed.kind).toBe("pressable");
    expect(composed.children.map(child => child.id)).toEqual(["composed-icon", "composed-label", "composed-detail"]);
    expect(composed.control).toEqual({ role: "button", label: "Delete item" });
    expect(composed.style.direction).toBe("row");
    expect(composed.style.gap).toBe(8);
    expect(tree.nodes.get("composed-icon")?.style.foreground).toBe(darkTheme.colors.destructiveForeground);
    expect(tree.nodes.get("composed-label")?.style.foreground).toBe(darkTheme.colors.destructiveForeground);
    expect(tree.nodes.get("composed-item")?.style.foreground).toBe(darkTheme.colors.destructiveForeground);
    expect(tree.nodes.get("explicit-icon")?.style.foreground).toBe("#123456");
    expect(tree.nodes.get("explicit-label")?.style.foreground).toBe("#abcdef");
    expect(tree.nodes.get("disabled-label")?.style.foreground).toBe(darkTheme.colors.disabledForeground);
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
    expect(tree.document.version).toBe(31);
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
  test("roving group changes are emitted as native patches", () => {
    const view = () => compileTree(
      <Window>
        <Pressable focusable={false} control={{ role: "navigation" }}>
          <Pressable id="item" rovingGroup control={{ role: "button", label: "Item" }}>Item</Pressable>
        </Pressable>
      </Window>,
    );
    const before = view();
    const after = view();
    expect(before.nodes.get("item")?.rovingGroup).toBeDefined();
    after.nodes.get("item")!.rovingGroup = "changed-group";
    expect(diffTrees(before, after)?.map(node => node.id)).toEqual(["item"]);
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
