import { beforeEach, expect, test } from "bun:test";
import { compileTree } from "./reconciler";
import { Window } from "./components";
import { resetHtmlState } from "./html-elements";

beforeEach(resetHtmlState);
const kinds = (tree: ReturnType<typeof compileTree>, id: string) => tree.nodes.get(id)!;
const click = (tree: ReturnType<typeof compileTree>, id: string) => tree.handlers.get(id)!.onClick!();

test("checkbox, radio, range and date inputs compile to native controls", () => {
  const tree = compileTree(<Window>
    <input id="agree" type="checkbox" label="Agree" defaultChecked />
    <input id="size-s" type="radio" name="size" value="s" label="Small" defaultChecked />
    <input id="volume" type="range" min={0} max={10} defaultValue="4" />
    <input id="when" type="date" defaultValue="2026-10-04" />
  </Window>);
  expect(kinds(tree, "agree").control).toMatchObject({ role: "checkbox", checked: true, label: "Agree" });
  expect(tree.nodes.get("volume")!.kind).toBe("slider");
  expect(tree.nodes.get("volume")!.control).toMatchObject({ value: 4, min: 0, max: 10 });
  expect([...tree.nodes.values()].some(node => node.control?.role === "radio" && node.control.checked)).toBe(true);
  expect(tree.nodes.has("when")).toBe(true);
});

test("uncontrolled checkbox keeps its state across renders", () => {
  const view = () => <Window><input id="c" type="checkbox" label="C" /></Window>;
  click(compileTree(view()), "c");
  expect(compileTree(view()).nodes.get("c")!.control!.checked).toBe(true);
});

test("forms submit named values on Enter and on a submit button, after required fields", () => {
  const submitted: unknown[] = [];
  const invalid: string[] = [];
  const view = (email = "") => <Window>
    <form onSubmit={values => submitted.push(values)} onInvalid={name => invalid.push(name)}>
      <input id="email" name="email" required value={email} />
      <input id="news" type="checkbox" name="news" label="News" />
      <button id="cancel" type="button">Cancel</button>
      <button id="send">Send</button>
    </form>
  </Window>;
  let tree = compileTree(view());
  click(tree, "send");
  expect(invalid).toEqual(["email"]);
  click(tree, "cancel");
  expect(submitted).toEqual([]);
  tree = compileTree(view("a@b.c"));
  click(tree, "news");
  tree.handlers.get("email")!.onSubmit!("a@b.c");
  expect(submitted).toEqual([{ email: "a@b.c", news: true }]);
});

test("lists get markers and the user-agent 40px indent", () => {
  const tree = compileTree(<Window><ol id="steps" start={3}><li>a</li><li>b</li></ol><ul id="bullets"><li>x</li></ul></Window>);
  expect(tree.nodes.get("steps")!.style.padding).toEqual({ left: 40 });
  const texts = [...tree.nodes.values()].filter(node => node.kind === "text").map(node => node.text);
  expect(texts).toEqual(["3.", "a", "4.", "b", "•", "x"]);
});

test("tables lay out as a grid of auto columns with bold headers", () => {
  const tree = compileTree(<Window><table id="t"><thead><tr><th>Name</th><th>Age</th></tr></thead><tbody><tr><td>Ana</td><td>30</td></tr></tbody></table></Window>);
  expect(tree.nodes.get("t")!.style).toMatchObject({ display: "grid", columns: "repeat(2, auto)", gap: 2 });
  const cells = [...tree.nodes.values()].filter(node => node.kind === "text");
  expect(cells.map(node => [node.text, node.style.fontWeight])).toEqual([["Name", 700], ["Age", 700], ["Ana", 400], ["30", 400]]);
  expect(() => compileTree(<Window><tr /></Window>)).toThrow("must be inside a <table>");
});

test("colSpan and rowSpan place cells; pre, blockquote, meter and abbr follow user-agent styles", () => {
  const tree = compileTree(<Window>
    <table id="t"><tr><td id="wide" colSpan={2}>a</td></tr><tr><td id="tall" rowSpan={2}>b</td><td>c</td></tr><tr><td>d</td></tr></table>
    <pre id="code">{"a  b\n c"}</pre>
    <blockquote id="quote"><p>q</p></blockquote>
    <meter id="m" value={0.6} />
    <p id="p">An <abbr title="HyperText Markup Language">HTML</abbr> page</p>
  </Window>);
  expect(tree.nodes.get("t")!.style.columns).toBe("repeat(2, auto)");
  expect(tree.nodes.get("wide")!.style.gridColumn).toBe("span 2");
  expect(tree.nodes.get("tall")!.style.gridRow).toBe("span 2");
  expect(tree.nodes.get("code")!).toMatchObject({ text: "a  b\n c", style: { fontFamily: "monospace", whiteSpace: "pre" } });
  expect(tree.nodes.get("quote")!.style.margin).toEqual({ top: 14, bottom: 14, left: 40, right: 40 });
  expect(tree.nodes.get("m")!.control).toMatchObject({ role: "progress", value: 0.6, max: 1 });
  expect(tree.nodes.get("p")!.runs).toEqual([{ start: 3, end: 7, style: { textDecoration: "underline", textDecorationStyle: "dotted" } }]);
});

test("color and time inputs normalize their values like HTML", () => {
  const values: string[] = [];
  const view = () => <Window>
    <form id="f" onSubmit={v => values.push(JSON.stringify(v))}>
      <input id="c" type="color" name="color" defaultValue="#FF0000" />
      <input id="t" type="time" name="at" />
      <button id="go">Go</button>
    </form>
  </Window>;
  let tree = compileTree(view());
  expect(tree.nodes.get("c-hex")!.value).toBe("#ff0000");
  tree.handlers.get("t")!.onChange!("0930");
  tree = compileTree(view());
  expect(tree.nodes.get("t")!.value).toBe("09:30");
  click(tree, "c-swatch");
  tree = compileTree(view());
  click(tree, "c-3b82f6");
  tree = compileTree(view());
  click(tree, "go");
  expect(values.at(-1)).toBe(JSON.stringify({ color: "#3b82f6", at: "09:30" }));
  tree.handlers.get("t")!.onChange!("25:99");
  tree = compileTree(view());
  click(tree, "go");
  expect(JSON.parse(values.at(-1)!).at).toBe("");
});

test("details toggles its content and fieldset groups with a legend label", () => {
  const view = () => <Window><details id="d"><summary>More</summary><p id="hidden">body</p></details><fieldset><legend>Account</legend><p>x</p></fieldset></Window>;
  let tree = compileTree(view());
  expect(tree.nodes.has("hidden")).toBe(false);
  click(tree, "d-summary");
  tree = compileTree(view());
  expect(tree.nodes.has("hidden")).toBe(true);
  expect([...tree.nodes.values()].some(node => node.control?.role === "group" && node.control.label === "Account")).toBe(true);
});
