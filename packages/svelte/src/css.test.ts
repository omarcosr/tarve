import { describe, expect, test } from "bun:test";
import { interpolateFrames, keyframesOf } from "./dom-animation";
import { cssStyle, elementStyle, isComponentClass, parseCss, registerCss, resetCss } from "./css";
import { documentInstance as document, windowInstance, type TElement } from "./dom";

const styleOf = (element: TElement) => elementStyle(element, (element.getAttribute("class") ?? "").split(/\s+/).filter(Boolean));

describe("Svelte CSS", () => {
  test("declarations become Tarve style", () => {
    expect(cssStyle("padding: 4px 8px; background-color: #fff; border: 1px solid #ccc; flex-direction: column; opacity: 0.5; margin-top: 2px")).toEqual({
      padding: { top: 4, right: 8, bottom: 4, left: 8 }, backgroundColor: "#fff", borderWidth: 1, borderStyle: "solid", borderColor: "#ccc", direction: "column", opacity: 0.5, margin: { top: 2 },
    });
    expect(cssStyle("margin: 10px auto")).toEqual({ margin: { top: 10, right: "auto", bottom: 10, left: "auto" } });
    expect(cssStyle("direction: rtl; flex-direction: column")).toEqual({ textDirection: "rtl", direction: "column" });
    expect(cssStyle("border-top: 4px solid #e11; border-left: 1px solid #ff0")).toEqual({
      borderWidth: { top: 4, left: 1 }, borderStyle: "solid", borderColor: "#e11", borderColors: { top: "#e11", left: "#ff0" },
    });
    // A side colour over a whole border keeps the others; a whole colour drops the sides.
    expect(cssStyle("border: 1px solid #333; border-top-color: red").borderColors).toEqual({ top: "red", right: "#333", bottom: "#333", left: "#333" });
    expect(cssStyle("border-color: red blue").borderColors).toEqual({ top: "red", right: "blue", bottom: "red", left: "blue" });
    expect(cssStyle("border-top-color: red; border-color: blue")).toEqual({ borderColor: "blue" });
    expect(cssStyle("place-items: center; place-content: space-between start; place-self: end")).toEqual({
      alignItems: "center", justifyItems: "center", alignContent: "space-between", justifyContent: "start", alignSelf: "end", justifySelf: "end",
    });
    expect(cssStyle("border-radius: 4px 8px")).toEqual({ radius: { topLeft: 4, topRight: 8, bottomRight: 4, bottomLeft: 8 } });
    expect(cssStyle("top: calc(100% + 0.5rem); max-height: min(20rem, 60vh); min-width: clamp(10px, 5vw, 40px)", { width: 1000, height: 400, fontSize: 16 })).toEqual({
      top: "100%", margin: { top: 8 }, maxHeight: 240, minWidth: 40,
    });
    expect(cssStyle("padding: 0 clamp(0.75rem, 2vw, 1.75rem) calc(env(safe-area-inset-bottom) + 0.9rem); grid-template-columns: auto minmax(0, 1fr) auto; height: calc(100vh - 2 * 1rem)", { width: 1000, height: 400, fontSize: 16 })).toEqual({
      padding: { top: 0, right: 20, bottom: 14.4, left: 20 }, columns: "auto minmax(0, 1fr) auto", height: 368,
    });
    expect(cssStyle("width: calc(100% - 2rem)").width).toBe("calc(100% - 2rem)");
    // Transforms in Tarve's order stay box-independent (centre origin, percents of the box).
    expect(cssStyle("transform: rotate(180deg)")).toEqual({ transform: { rotate: 180 } });
    expect(cssStyle("transform: translateX(-50%) translateY(0.45rem) scale(0.97)")).toEqual({ transform: { y: 7.2, xPercent: -50, scale: 0.97 } });
    expect(cssStyle("transform: none")).toEqual({ transform: {} });
    expect(cssStyle("transform: scale(2) translateX(10px)").transformMatrix).toBeDefined();
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

  test("a rule under a hovered ancestor is the native group hover; other ancestor states are dropped", () => {
    resetCss();
    registerCss(parseCss(`
      .card { padding: 4px }
      .title { opacity: 0 }
      .card:hover .title { opacity: 1 }
      .card:focus .title { color: red }
      .tile { aspect-ratio: 2 / 3 }
    `));
    const card = document.createElement("div"); card.className = "card";
    const title = document.createElement("span"); title.className = "title";
    card.appendChild(title);
    expect(styleOf(card)).toEqual({ padding: 4, group: true });
    expect(styleOf(title)).toEqual({ opacity: 0, groupHover: { opacity: 1 } });
    const tile = document.createElement("div"); tile.className = "tile";
    expect(styleOf(tile)).toEqual({ aspectRatio: 2 / 3 });
    // A component class is not a Tailwind utility, unless the app's sheets import Tailwind.
    expect(isComponentClass("tile")).toBe(true);
    resetCss();
    // ::placeholder and the scrollbar parts style the element; thumb hover and the track are dropped.
    const warnings: string[] = [];
    registerCss(parseCss(`
      .field::placeholder { color: #888 }
      .list::-webkit-scrollbar { width: 5px }
      .list::-webkit-scrollbar-thumb { background: rgba(255, 255, 255, 0.12); border-radius: 9px }
      .list::-webkit-scrollbar-thumb:hover { background: red }
      .list::-webkit-scrollbar-track { background: transparent }
      .bare::-webkit-scrollbar { display: none }
      .anim { opacity: 1 }
      @media (prefers-reduced-motion: reduce) { .anim { opacity: 0.5 } }
      @media (display-mode: fullscreen) { .anim { color: red } }
    `, message => warnings.push(message)));
    expect(warnings).toEqual([]);
    const field = document.createElement("input"); field.className = "field";
    expect(styleOf(field)).toEqual({ placeholderColor: "#888" });
    const list = document.createElement("div"); list.className = "list";
    expect(styleOf(list)).toEqual({ scrollbarWidth: "thin", scrollbarColor: "rgba(255, 255, 255, 0.12)" });
    const bare = document.createElement("div"); bare.className = "bare";
    expect(styleOf(bare)).toEqual({ scrollbarWidth: "none" });
    const anim = document.createElement("div"); anim.className = "anim";
    expect(styleOf(anim)).toEqual({ opacity: 1 });
    windowInstance._fullscreen = true;
    expect(styleOf(anim)).toEqual({ opacity: 1, color: "red" });
    windowInstance._fullscreen = false;
    resetCss();
    registerCss(parseCss(`@import "tailwindcss";\n.tile { opacity: 1 }`));
    registerCss(parseCss(`@import "tailwindcss";\n.bg-linear-to-t { opacity: 1 }`));
    expect(isComponentClass("tile")).toBe(false);
    resetCss();
  });
});

test("a keyframe a @keyframes rule leaves out is implicit: the neutral value, so a to-only spinner turns", () => {
  const spin = keyframesOf([{ offset: 1, transform: "rotate(360deg)" }]);
  expect(spin.map(frame => frame.offset)).toEqual([0, 1]);
  expect(interpolateFrames(spin, 0.25)).toEqual({ transform: "rotate(90deg)" });
  // from-only: ends at the element's own value when it has one, else the neutral one.
  expect(keyframesOf([{ offset: 0, opacity: 0 }]).at(-1)!.values).toEqual({ opacity: "1" });
  expect(keyframesOf([{ offset: 0, opacity: 0 }], () => "0.5").at(-1)!.values).toEqual({ opacity: "0.5" });
  expect(keyframesOf([{ offset: 1, transform: "translate(50%, -50%) scale(0.5)" }])[0]!.values.transform).toBe("translate(0%, 0%) scale(1)");
});
