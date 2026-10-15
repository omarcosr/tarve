import { describe, expect, test } from "bun:test";
import { cssStyle, elementStyle, parseCss, registerCss, resetCss } from "./css";
import { documentInstance as document, windowInstance, type TElement } from "./dom";

const styleOf = (element: TElement) => elementStyle(element, (element.getAttribute("class") ?? "").split(/\s+/).filter(Boolean));

describe("Svelte CSS", () => {
  test("declarations become Tarve style", () => {
    expect(cssStyle("padding: 4px 8px; background-color: #fff; border: 1px solid #ccc; flex-direction: column; opacity: 0.5; margin-top: 2px")).toEqual({
      padding: { top: 4, right: 8, bottom: 4, left: 8 }, backgroundColor: "#fff", borderWidth: 1, borderStyle: "solid", borderColor: "#ccc", direction: "column", opacity: 0.5, margin: { top: 2 },
    });
    expect(cssStyle("border-radius: 4px 8px")).toEqual({ radius: { topLeft: 4, topRight: 8, bottomRight: 4, bottomLeft: 8 } });
    expect(cssStyle("font: italic 600 14px/20px Inter, sans-serif; width: 50vw", { width: 1000, height: 800, fontSize: 16 })).toEqual({
      fontStyle: "italic", fontWeight: 600, fontSize: 14, lineHeight: 20 / 14, fontFamily: "Inter, sans-serif", width: 500,
    });
  });

  test("compound, descendant, child, sibling and structural selectors", () => {
    resetCss();
    const warnings: string[] = [];
    registerCss(parseCss(`
      .card.s1 { padding: 8px }
      button.s1:hover { color: red }
      .list.s1 > .item.s1 { gap: 1px }
      .list.s1 .label.s1 { font-size: 12px }
      .item.s1 + .item.s1 { margin-top: 4px }
      .item.s1:nth-child(odd) { background: #eee }
      .item.s1:not(.active) { opacity: 0.5 }
      input.s1:checked ~ span.s1 { color: green }
      .x::before { content: "" }
      .x::selection { color: red }
    `, message => warnings.push(message)));
    expect(warnings).toHaveLength(1);
    const card = document.createElement("div"); card.className = "card s1";
    expect(styleOf(card)).toEqual({ padding: 8 });
    const button = document.createElement("button"); button.className = "s1";
    expect(styleOf(button)).toEqual({ hover: { color: "red" } });
    const list = document.createElement("div"); list.className = "list s1";
    const items = [0, 1, 2].map(index => {
      const item = document.createElement("div"); item.className = `item s1${index === 1 ? " active" : ""}`;
      const label = document.createElement("span"); label.className = "label s1";
      item.appendChild(label);
      list.appendChild(item);
      return item;
    });
    expect(styleOf(items[0]!)).toEqual({ gap: 1, background: "#eee", opacity: 0.5 });
    expect(styleOf(items[1]!)).toEqual({ gap: 1, margin: { top: 4 } });
    expect(styleOf(items[2]!)).toEqual({ gap: 1, margin: { top: 4 }, background: "#eee", opacity: 0.5 });
    expect(styleOf(items[0]!.firstChild as TElement)).toEqual({ fontSize: 12 });
    const box = document.createElement("label");
    const input = document.createElement("input"); input.setAttribute("type", "checkbox"); input.className = "s1";
    const text = document.createElement("span"); text.className = "s1";
    box.append(input, text);
    expect(styleOf(text)).toBeUndefined();
    input.checked = true;
    expect(styleOf(text)).toEqual({ color: "green" });
    resetCss();
  });

  test("@media width queries and custom properties", () => {
    resetCss();
    registerCss(parseCss(`
      .root { --accent: #f00; --gap: 6px }
      .panel { color: var(--accent); gap: var(--gap); padding: var(--missing, 3px) }
      @media (max-width: 600px) { .panel { gap: 2px } }
    `));
    const root = document.createElement("div"); root.className = "root";
    const panel = document.createElement("div"); panel.className = "panel";
    root.appendChild(panel);
    windowInstance.innerWidth = 1000;
    expect(styleOf(panel)).toEqual({ color: "#f00", gap: 6, padding: 3 });
    windowInstance.innerWidth = 500;
    expect(styleOf(panel)).toEqual({ color: "#f00", gap: 2, padding: 3 });
    windowInstance.innerWidth = 1120;
    resetCss();
  });
});
