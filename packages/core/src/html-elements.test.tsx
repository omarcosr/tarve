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

test("details toggles its content and fieldset groups with a legend label", () => {
  const view = () => <Window><details id="d"><summary>More</summary><p id="hidden">body</p></details><fieldset><legend>Account</legend><p>x</p></fieldset></Window>;
  let tree = compileTree(view());
  expect(tree.nodes.has("hidden")).toBe(false);
  click(tree, "d-summary");
  tree = compileTree(view());
  expect(tree.nodes.has("hidden")).toBe(true);
  expect([...tree.nodes.values()].some(node => node.control?.role === "group" && node.control.label === "Account")).toBe(true);
});
