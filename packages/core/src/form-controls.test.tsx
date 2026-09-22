import { describe, expect, test } from "bun:test";
import { Window, Text, Button, Column, TextInput } from "./components";
import { compileTree } from "./reconciler";
import { Alert, AspectRatio, ButtonGroup, Direction, Empty, Field, InputGroup, InputOTP, Item, Kbd, Label,
  NativeSelect, Toggle, ToggleGroup, Typography } from "./form-controls";

describe("form and visual controls", () => {
  test("basic visual controls compile with shadcn-style structure", () => {
    const tree = compileTree(<Window>
      <Alert id="alert" title="Heads up" description="Something changed" variant="destructive" />
      <AspectRatio id="ratio" ratio={16 / 9} width={320} style={{ width: 999, height: 1 }}><Text>Media</Text></AspectRatio>
      <ButtonGroup id="buttons"><Button>One</Button><Button>Two</Button></ButtonGroup>
      <Empty id="empty" title="No data" description="Try again" />
      <Field id="field" label="Email" required error="Required"><TextInput value="" /></Field>
      <InputGroup id="input-group" prefix={<Text>$</Text>}><TextInput value="10" /></InputGroup>
      <Kbd id="kbd">Ctrl K</Kbd>
      <Label id="label" required>Name</Label>
      <Typography id="heading" variant="h1">Title</Typography>
      <Typography id="code" variant="code" style={{ foreground: "#123456", fontSize: 15 }}>const x = 1</Typography>
    </Window>);
    expect(tree.nodes.get("ratio")?.style.width).toBe(320);
    expect(tree.nodes.get("ratio")?.style.height).toBeUndefined();
    expect(tree.nodes.get("ratio")?.style.aspectRatio).toBe(16 / 9);
    expect(tree.nodes.get("field-error")?.text).toBe("Required");
    expect(tree.nodes.get("field-error")?.control?.role).toBe("alert");
    expect(tree.nodes.get("field")?.control).toEqual({ role: "group", label: "Email" });
    expect(tree.nodes.get("label")?.control?.role).toBe("label");
    expect(tree.nodes.get("buttons")?.control).toEqual({ role: "group", orientation: "horizontal" });
    expect(tree.nodes.get("heading")?.style.fontSize).toBe(32);
    expect(tree.nodes.get("code")?.kind).toBe("text");
    expect(tree.nodes.get("code")?.style.foreground).toBe("#123456");
    expect(tree.nodes.get("code")?.style.fontSize).toBe(15);
    expect(tree.nodes.get("alert")?.style.borderColor).toBe("#dc2626");
    expect(() => compileTree(<Window><AspectRatio ratio={0} /></Window>)).toThrow(RangeError);
    expect(() => compileTree(<Window><AspectRatio ratio={1} width={0} /></Window>)).toThrow(RangeError);
    expect(compileTree(<Window><AspectRatio id="responsive" ratio={4 / 3} width="100%" /></Window>).nodes.get("responsive")?.style.width).toBe("100%");
  });

  test("InputOTP uses one native input, filters changes and keeps mask visual-only", () => {
    const values: string[] = [];
    const tree = compileTree(<Window><InputOTP id="otp" value="12" length={4} onValueChange={value => values.push(value)} /></Window>);
    expect([...tree.nodes.values()].filter(node => node.kind === "input")).toHaveLength(1);
    expect(tree.nodes.get("otp-input")?.value).toBe("12");
    expect(tree.nodes.get("otp-input")?.style.focus?.outlineWidth).toBe(0);
    expect(tree.nodes.get("otp")?.style.width).toBe(168);
    expect(tree.nodes.get("otp-slot-0")?.children[0]?.text).toBe("1");
    expect(Array.from({ length: 4 }, (_, index) => tree.nodes.get(`otp-slot-${index}`)?.style.width)).toEqual([36, 36, 36, 36]);
    expect(Array.from({ length: 4 }, (_, index) => ({
      width: tree.nodes.get(`otp-slot-${index}`)?.style.borderWidth,
      color: tree.nodes.get(`otp-slot-${index}`)?.style.borderColor,
    }))).toEqual([
      { width: 1, color: "#aeaeb6" },
      { width: 1, color: "#aeaeb6" },
      { width: 1, color: "#e4e4e7" },
      { width: 1, color: "#e4e4e7" },
    ]);
    expect(tree.nodes.get("otp-slot-0")?.control).toEqual({ role: "otpSlot", group: "otp-input", value: 0, max: 3 });
    expect(tree.nodes.get("otp-slot-2")?.style.focus).toMatchObject({
      outlineWidth: 2,
      outlineOffset: 2,
      outlineStyle: "solid",
      outlineColor: "#a1a1aa",
    });
    expect(tree.nodes.get("otp-slot-0")?.children[0]?.style.fontSize).toBe(16);
    expect(tree.nodes.get("otp-slot-0")?.children[0]?.style.fontWeight).toBe(500);
    tree.handlers.get("otp-input")?.onChange?.("12a34");
    expect(values).toEqual(["1234"]);

    const masked = compileTree(<Window><InputOTP id="masked" value="12" length={4} mask /></Window>);
    expect(masked.nodes.get("masked-input")?.value).toBe("12");
    expect(masked.nodes.get("masked-slot-0")?.children[0]?.text).toBe("•");
    expect(() => compileTree(<Window><InputOTP value="" length={0} /></Window>)).toThrow(RangeError);
    expect(() => compileTree(<Window><InputOTP value="123" length={2} /></Window>)).toThrow(RangeError);
    expect(() => compileTree(<Window><InputOTP value="1x" length={2} /></Window>)).toThrow(TypeError);
    expect(() => compileTree(<Window><InputOTP value="" slotWidth={0} /></Window>)).toThrow(RangeError);
    expect(() => compileTree(<Window><InputOTP value="" pattern={"digits" as any} /></Window>)).toThrow(TypeError);
  });

  test("Field and InputGroup disable their form controls", () => {
    const tree = compileTree(<Window>
      <Field id="disabled-field" label="Email" disabled><TextInput id="field-input" value="a" /></Field>
      <InputGroup id="disabled-group" disabled><TextInput id="group-input" value="b" /></InputGroup>
      <Field disabled><Column><InputGroup><TextInput id="nested-input" value="c" /></InputGroup></Column></Field>
    </Window>);
    expect(tree.nodes.get("disabled-field")?.disabled).toBe(true);
    expect(tree.nodes.get("field-input")?.disabled).toBe(true);
    expect(tree.nodes.get("disabled-group")?.disabled).toBe(true);
    expect(tree.nodes.get("group-input")?.disabled).toBe(true);
    expect(tree.nodes.get("nested-input")?.disabled).toBe(true);
  });

  test("Item is inert without an action and Toggle exposes a controlled handler", () => {
    const events: string[] = [];
    const tree = compileTree(<Window>
      <Item id="item" title="Profile" selected onClick={() => events.push("item")} />
      <Item id="inert-item" title="Read only" selected />
      <Toggle id="toggle" pressed={false} onPressedChange={pressed => events.push(`toggle:${pressed}`)}>Bold</Toggle>
      <ToggleGroup id="group" type="multiple" value={["a"]} items={[{ value: "a", label: "A" }, { value: "b", label: "B" }]}
        onValueChange={value => events.push(`group:${Array.isArray(value) ? value.join(",") : value}`)} />
    </Window>);
    expect(tree.nodes.get("item")?.kind).toBe("pressable");
    expect(tree.nodes.get("item")?.control?.role).toBe("option");
    expect(tree.nodes.get("inert-item")?.kind).toBe("view");
    expect(tree.nodes.get("inert-item")?.control).toBeUndefined();
    expect(tree.nodes.get("toggle")?.control?.role).toBe("toggle");
    expect(tree.nodes.get("group")?.control).toEqual({ role: "togglegroup", orientation: "horizontal" });
    expect(tree.nodes.get("group-item-a")?.control?.group).toBe("group");
    tree.handlers.get("item")?.onClick?.();
    tree.handlers.get("toggle")?.onClick?.();
    tree.handlers.get("group-item-b")?.onClick?.();
    expect(events).toEqual(["item", "toggle:true", "group:a,b"]);
  });

  test("single ToggleGroup compiles to native radio semantics and validates controlled values", () => {
    const selected: string[] = [];
    const tree = compileTree(<Window><ToggleGroup id="single" type="single" value="a"
      items={[{ value: "a", label: "A" }, { value: "b", label: "B" }, { value: "c", label: "C", disabled: true }]}
      onValueChange={value => selected.push(value as string)} /></Window>);
    expect(tree.nodes.get("single")?.control).toEqual({ role: "radiogroup", orientation: "horizontal" });
    expect(tree.nodes.get("single-item-a")?.control).toEqual({ role: "radio", label: "A", checked: true, group: "single" });
    expect(tree.nodes.get("single-item-b")?.control).toEqual({ role: "radio", label: "B", checked: false, group: "single" });
    expect(tree.nodes.get("single-item-c")?.disabled).toBe(true);
    tree.handlers.get("single-item-b")?.onClick?.();
    expect(selected).toEqual(["b"]);

    expect(() => compileTree(<Window><ToggleGroup type="single" value={["a"]} items={[{ value: "a", label: "A" }]} /></Window>)).toThrow(TypeError);
    expect(() => compileTree(<Window><ToggleGroup type="multiple" value="a" items={[{ value: "a", label: "A" }]} /></Window>)).toThrow(TypeError);
    expect(() => compileTree(<Window><ToggleGroup type="single" value="missing" items={[{ value: "a", label: "A" }]} /></Window>)).toThrow(RangeError);
  });

  test("NativeSelect stays controlled and Direction preserves logical child order", () => {
    const selected: string[] = [];
    const tree = compileTree(<Window>
      <NativeSelect id="native" open value="a" options={[{ value: "a", label: "A" }, { value: "b", label: "B" }]}
        onValueChange={value => selected.push(value)} />
      <Direction id="rtl" dir="rtl"><Text id="first">First</Text><Text id="second">Second</Text></Direction>
    </Window>);
    tree.handlers.get("native-option-b")?.onClick?.();
    expect(selected).toEqual(["b"]);
    expect(tree.nodes.get("rtl")?.children.map(child => child.id)).toEqual(["first", "second"]);
    expect(tree.nodes.get("rtl")?.style.direction).toBe("row-reverse");
  });
});
