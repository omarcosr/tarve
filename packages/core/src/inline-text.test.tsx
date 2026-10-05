import { expect, test } from "bun:test";
import { compileTree } from "./reconciler";
import { Text, Window } from "./components";

const textOf = (element: Parameters<typeof compileTree>[0], id: string) => compileTree(element).nodes.get(id)!;

test("white-space follows CSS: normal collapses, pre keeps, pre-line keeps newlines", () => {
  expect(textOf(<Window><p id="t">{"  a   b \n  c  "}</p></Window>, "t").text).toBe("a b c");
  expect(textOf(<Window><p id="t" style={{ whiteSpace: "pre" }}>{"a  b\n c"}</p></Window>, "t").text).toBe("a  b\n c");
  expect(textOf(<Window><p id="t" style={{ whiteSpace: "pre-line" }}>{"a   b \n  c"}</p></Window>, "t").text).toBe("a b\nc");
  expect(textOf(<Window><Text id="t">{"one\ntwo"}</Text></Window>, "t").text).toBe("one two");
});

test("phrasing elements become runs with user-agent styles and byte offsets", () => {
  const node = textOf(<Window><p id="t">Olá <strong>forte</strong> <em>itálico</em><br />fim <mark>m</mark></p></Window>, "t");
  expect(node.text).toBe("Olá forte itálico\nfim m");
  expect(node.runs).toEqual([
    { start: 5, end: 10, style: { fontWeight: 700 } },
    { start: 11, end: 19, style: { fontStyle: "italic" } },
    { start: 24, end: 25, style: { background: "#ffff00", foreground: "#000000" } },
  ]);
});

test("relative font keywords and decorations combine like CSS", () => {
  const node = textOf(<Window><p id="t" style={{ fontSize: 18 }}><strong>a<b>b</b></strong> <small>s</small> <u>x<s>y</s></u></p></Window>, "t");
  const styles = Object.fromEntries(node.runs!.map(run => [node.text!.slice(run.start, run.end), run.style]));
  expect(styles.a).toEqual({ fontWeight: 700 });
  expect(styles.b).toEqual({ fontWeight: 900 });
  expect(styles.s).toEqual({ fontSize: 15 });
  expect(styles.y).toEqual({ textDecoration: "underline line-through" });
});

test("text-transform applies to the displayed text", () => {
  expect(textOf(<Window><p id="t" style={{ textTransform: "capitalize" }}>hello big world</p></Window>, "t").text).toBe("Hello Big World");
  expect(textOf(<Window><p id="t">a <span style={{ textTransform: "uppercase" }}>b c</span></p></Window>, "t").text).toBe("a B C");
});

test("links and clickable spans inside text are click targets with handlers", () => {
  let clicks = 0;
  const tree = compileTree(<Window><p id="t">See <span id="more" onClick={() => clicks++}>more</span> or <a href="https://example.com">docs</a></p></Window>);
  const node = tree.nodes.get("t")!;
  expect(node.runs!.map(run => run.id)).toEqual(["more", "t/run:0"]);
  tree.handlers.get("more")!.onClick!();
  expect(clicks).toBe(1);
  expect(tree.handlers.has("t/run:0")).toBe(true);
});

test("font-family is inherited by every text descendant, as in CSS", () => {
  const tree = compileTree(<Window style={{ fontFamily: "Inter Variable" }}>
    <div style={{ fontFamily: "Georgia", fontStyle: "italic" }}>
      <p id="nested">a <code>b</code></p>
      <button id="button">ok</button>
    </div>
    <p id="top">c</p>
    <p id="own" style={{ fontFamily: "Arial" }}>d</p>
  </Window>);
  const style = (id: string) => tree.nodes.get(id)!.style;
  expect(style("nested")).toMatchObject({ fontFamily: "Georgia", fontStyle: "italic" });
  expect(tree.nodes.get("nested")!.runs).toEqual([{ start: 2, end: 3, style: { fontFamily: "monospace" } }]);
  expect(style("button").fontFamily).toBe("Georgia");
  expect(style("top").fontFamily).toBe("Inter Variable");
  expect(style("own").fontFamily).toBe("Arial");
  expect(compileTree(<Window><p id="t">x</p></Window>).nodes.get("t")!.style.fontFamily).toBe("system-ui");
});

test("colour, size, weight and line height are inherited by text, as in CSS", () => {
  const tree = compileTree(<Window>
    <div style={{ color: "#ff0000", fontSize: 20, fontWeight: 600, lineHeight: 1.2, textAlign: "center" }}>
      <p id="inherits">a</p>
      <p id="own" style={{ color: "#00ff00", fontSize: 12 }}>b</p>
      <button id="button">ok</button>
    </div>
    <p id="initial">c</p>
  </Window>);
  const style = (id: string) => tree.nodes.get(id)!.style;
  expect(style("inherits")).toMatchObject({ foreground: "#ff0000", fontSize: 20, fontWeight: 600, lineHeight: 1.2, textAlign: "center" });
  expect(style("own")).toMatchObject({ foreground: "#00ff00", fontSize: 12, fontWeight: 600 });
  expect(style("button").fontSize).toBe(14);
  expect(style("initial")).toMatchObject({ fontSize: 14, fontWeight: 400, lineHeight: 1.5 });
});

test("sub and sup shift the baseline like Chromium and nest", () => {
  const node = textOf(<Window><p id="t" style={{ fontSize: 18 }}>x<sup>n<sup>k</sup></sup>H<sub>2</sub></p></Window>, "t");
  const styles = Object.fromEntries(node.runs!.map(run => [node.text!.slice(run.start, run.end), run.style]));
  expect(styles.n).toEqual({ fontSize: 15, baselineShift: 7 });
  expect(styles.k).toEqual({ fontSize: 12.5, baselineShift: 13 });
  expect(styles["2"]).toEqual({ fontSize: 15, baselineShift: -4.6 });
});

test("block elements inside text are rejected", () => {
  expect(() => compileTree(<Window><p>a <div>b</div></p></Window>)).toThrow("cannot be inside text");
});
