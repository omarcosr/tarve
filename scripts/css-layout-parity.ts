// Layout parity with CSS. Each case is written once as CSS and once as Tarve
// style; `record` lays the CSS out in a real Chromium and saves every box to
// tests/fixtures/css-layout.json, and `check` lays the Tarve version out in a
// hidden native window and fails on any box more than one pixel away: Tarve
// snaps boxes to whole pixels where Chromium keeps 1/64px layout units.
//   bun scripts/css-layout-parity.ts serve    # open http://localhost:4799 in Chromium to record
//   bun scripts/css-layout-parity.ts check
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

type Css = Record<string, string | number>;
type Tarve = Record<string, unknown>;
type Jsx = (type: unknown, props: Record<string, unknown>, key?: string | number) => unknown;
/** `html`/`inline` make the item a paragraph: the same text in HTML and in Tarve JSX. */
interface Item { css: Css; tarve: Tarve; html?: string; inline?: (jsx: Jsx, id?: string) => unknown; raw?: boolean }
/** `tolerance`: px allowed per box; each text box rounds its width up to a whole pixel, so a row of n texts may drift n px. */
interface Case { name: string; container: Item; items: Item[]; tolerance?: number }
type Box = [number, number, number, number];

const fixture = join(import.meta.dirname, "..", "tests", "fixtures", "css-layout.json");
const h = 20;
const repeatItem = (count: number, css: Css, tarve: Tarve): Item[] =>
  Array.from({ length: count }, () => ({ css: { height: `${h}px`, ...css }, tarve: { height: h, ...tarve } }));
const row = (width: number, css: Css = {}, tarve: Tarve = {}): Item => ({
  css: { display: "flex", "flex-direction": "row", "align-items": "flex-start", width: `${width}px`, ...css },
  tarve: { direction: "row", align: "start", width, ...tarve },
});
const grid = (width: number, columns: string, gap = 0, rows?: string): Item => ({
  css: { display: "grid", "grid-template-columns": columns, ...(rows ? { "grid-template-rows": rows } : {}), gap: `${gap}px`, width: `${width}px` },
  tarve: { display: "grid", columns, ...(rows ? { rows } : {}), gap, width },
});

// Text cases use the bundled Inter on both sides (an @font-face in Chromium,
// `fontFaces` in Tarve), so they measure the same glyphs on every OS.
const interFile = join(import.meta.dirname, "..", "packages", "headless", "fonts", "InterVariable.ttf");
const arial = { css: { "font-family": "'Inter Variable'", "font-size": "16px", "line-height": "1.5", "font-weight": "400" }, tarve: { fontFamily: "Inter Variable", fontSize: 16, lineHeight: 1.5, fontWeight: 400 } };
const para = (html: string, inline: (jsx: Jsx) => unknown, css: Css = {}, tarve: Tarve = {}): Item => ({
  css: { ...arial.css, ...css }, tarve: { ...arial.tarve, ...tarve }, html, inline,
});
const column = (width: number): Item => ({
  css: { display: "flex", "flex-direction": "column", "align-items": "stretch", width: `${width}px` },
  tarve: { direction: "column", align: "stretch", width },
});
const quick = "The quick brown fox jumps over the lazy dog";
const textCases: Case[] = [
  { name: "text wraps at the container width", container: column(200), items: [para(quick, () => quick)] },
  { name: "text shrink-to-fit width", container: row(600), items: [para("Hello world", () => "Hello world")] },
  { name: "white-space normal collapses runs", container: row(600), items: [para("  a   b \n  c  ", () => "  a   b \n  c  ")] },
  { name: "white-space nowrap keeps one line", container: column(120), items: [para(quick, () => quick, { "white-space": "nowrap" }, { whiteSpace: "nowrap" })] },
  { name: "white-space pre keeps newlines and spaces", container: row(600), items: [para("a  b\nc\n  d", () => "a  b\nc\n  d", { "white-space": "pre" }, { whiteSpace: "pre" })] },
  { name: "white-space pre-line keeps only newlines", container: row(600), items: [para("a   b\nc", () => "a   b\nc", { "white-space": "pre-line" }, { whiteSpace: "pre-line" })] },
  { name: "br breaks the line", container: row(600), items: [para("one<br>two three", j => ["one", j("br", {}), "two three"])] },
  { name: "strong and em change the measured width", container: row(600),
    items: [para("Hello <strong>bold</strong> and <em>italic</em> world", j => ["Hello ", j("strong", { children: "bold" }), " and ", j("em", { children: "italic" }), " world"])] },
  { name: "nested inline font size", container: row(600),
    items: [para("Big <span style=\"font-size: 24px\">large</span> end", j => ["Big ", j("span", { style: { fontSize: 24 }, children: "large" }), " end"])] },
  { name: "letter-spacing widens text", container: row(600), items: [para("Spacing", () => "Spacing", { "letter-spacing": "3px" }, { letterSpacing: 3 })] },
  { name: "word-spacing widens gaps", container: row(600), items: [para("a b c d", () => "a b c d", { "word-spacing": "10px" }, { wordSpacing: 10 })] },
  { name: "text-transform uppercase", container: row(600), items: [para("upper case", () => "upper case", { "text-transform": "uppercase" }, { textTransform: "uppercase" })] },
  { name: "font-style italic", container: row(600), items: [para("Italic text", () => "Italic text", { "font-style": "italic" }, { fontStyle: "italic" })] },
  { name: "ellipsis keeps one line in the box", container: column(120),
    items: [para(quick, () => quick, { "white-space": "nowrap", overflow: "hidden", "text-overflow": "ellipsis" }, { whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" })] },
  { name: "line clamp limits the height", container: column(150),
    items: [para(quick + " " + quick, () => quick + " " + quick, { display: "-webkit-box", "-webkit-box-orient": "vertical", "-webkit-line-clamp": "2", overflow: "hidden" }, { lineClamp: 2, overflow: "hidden" })] },
];
/** A whole HTML element (list, table…) written as markup and as Tarve JSX; `inline` puts the id on its root. */
const element = (html: string, tree: (jsx: Jsx, id?: string) => unknown): Item => ({ css: {}, tarve: {}, html, inline: tree, raw: true });
const font = "font-family: 'Inter Variable'; font-size: 16px; line-height: 1.5";
const htmlCases: Case[] = [
  { name: "unordered list indents 40px", container: column(300),
    items: [element(`<ul style="${font}"><li>One</li><li>Two longer item</li><li>Three</li></ul>`,
      (j, id) => j("ul", { id, style: arial.tarve, children: [j("li", { children: "One" }), j("li", { children: "Two longer item" }), j("li", { children: "Three" })] }))] },
  { name: "ordered list wraps inside its indent", container: column(160),
    items: [element(`<ol style="${font}"><li>${quick}</li><li>b</li></ol>`,
      (j, id) => j("ol", { id, style: arial.tarve, children: [j("li", { children: quick }), j("li", { children: "b" })] }))] },
  { name: "table auto columns with spacing and padding", container: row(600), tolerance: 2,
    items: [element(`<table style="${font}"><tr><th>Name</th><th>Age</th></tr><tr><td>Ana Maria</td><td>30</td></tr><tr><td>Bo</td><td>101</td></tr></table>`,
      (j, id) => j("table", { id, style: arial.tarve, children: [
        j("tr", { children: [j("th", { children: "Name" }), j("th", { children: "Age" })] }),
        j("tr", { children: [j("td", { children: "Ana Maria" }), j("td", { children: "30" })] }),
        j("tr", { children: [j("td", { children: "Bo" }), j("td", { children: "101" })] }),
      ] }))] },
];
// flow-root: a Tarve container is a flex item, which starts its own block
// formatting context, so child margins never escape it.
const blockFlow = (width: number): Item => ({ css: { display: "flow-root", width: `${width}px` }, tarve: { display: "block", width } });
htmlCases.push(
  // Shifted runs: Chromium positions their font metrics with its own rounding,
  // about 0.6px apart from Parley's; with the whole-pixel height that is < 2px.
  { name: "sup raises and grows the line box", container: blockFlow(400), tolerance: 2,
    items: [para("E = mc<sup>2</sup> and x<sup>n<sup>k</sup></sup>", j => ["E = mc", j("sup", { children: "2" }), " and x", j("sup", { children: ["n", j("sup", { children: "k" })] })])] },
  { name: "sub lowers and grows the line box", container: blockFlow(400), tolerance: 2,
    items: [para("H<sub>2</sub>O and CO<sub>2</sub>", j => ["H", j("sub", { children: "2" }), "O and CO", j("sub", { children: "2" })])] },
  { name: "sup on a wrapped line shifts the lines below", container: blockFlow(120),
    items: [para(`${quick}<sup>1</sup> ${quick}`, j => [quick, j("sup", { children: "1" }), " " + quick])] },
  { name: "paragraph margins collapse in block flow", container: blockFlow(300),
    items: [para("First paragraph", () => "First paragraph"), para(quick, () => quick), para("Last", () => "Last")] },
  { name: "paragraph margins add up in a flex column", container: column(300),
    items: [para("First paragraph", () => "First paragraph"), para("Last", () => "Last")] },
  { name: "heading margins scale with their font size", container: blockFlow(400),
    items: [element(`<h2 style="${font}; font-size: 24px">Heading</h2>`, (j, id) => j("h2", { id, style: { ...arial.tarve, fontSize: 24 }, children: "Heading" })),
      para("Body text", () => "Body text")] },
  { name: "table colspan and rowspan", container: row(600), tolerance: 2,
    items: [element(`<table style="${font}"><tr><td colspan="2">Wide header cell</td></tr><tr><td rowspan="2">Tall</td><td>b</td></tr><tr><td>c</td></tr></table>`,
      (j, id) => j("table", { id, style: arial.tarve, children: [
        j("tr", { children: [j("td", { colSpan: 2, children: "Wide header cell" })] }),
        j("tr", { children: [j("td", { rowSpan: 2, children: "Tall" }), j("td", { children: "b" })] }),
        j("tr", { children: [j("td", { children: "c" })] }),
      ] }))] },
  { name: "pre keeps spaces in monospace", container: row(600),
    items: [element(`<pre style="font-family: monospace; font-size: 13px; line-height: 1.5">a  b\n  c</pre>`,
      (j, id) => j("pre", { id, style: { fontSize: 13, lineHeight: 1.5 }, children: "a  b\n  c" }))] },
  { name: "blockquote indents 40px on both sides", container: column(300),
    items: [element(`<blockquote style="${font}">${quick}</blockquote>`,
      (j, id) => j("blockquote", { id, style: arial.tarve, children: quick }))] },
);
const overflowCases: Case[] = [
  { name: "overflow hidden lets a flex item shrink below its content", container: row(200),
    items: [{ css: { flex: "0 1 300px", overflow: "hidden", height: "20px" }, tarve: { flex: "0 1 300px", overflow: "hidden", height: 20 } },
      { css: { width: "50px", height: "20px", "flex-shrink": "0" }, tarve: { width: 50, height: 20, shrink: 0 } }] },
  { name: "overflow visible item keeps its min-content", container: row(200),
    items: [{ css: { flex: "0 1 300px", height: "20px", "min-width": "250px" }, tarve: { flex: "0 1 300px", height: 20, minWidth: 250 } }] },
];

export const cases: Case[] = [
  ...textCases,
  ...htmlCases,
  ...overflowCases,
  { name: "flex 1 with min-width wraps three per line", container: row(600, { "flex-wrap": "wrap", gap: "14px" }, { wrap: true, gap: 14 }),
    items: repeatItem(7, { flex: "1", "min-width": "176px" }, { flex: "1", minWidth: 176 }) },
  { name: "numeric flex is the css shorthand", container: row(300),
    items: [
      ...repeatItem(1, { flex: "1", "min-width": "60px" }, { flex: 1, minWidth: 60 }),
      ...repeatItem(1, { flex: "2" }, { flex: 2 }),
      ...repeatItem(1, { flex: "0 1 200px" }, { flex: "0 1 200px" }),
    ] },
  { name: "numeric flex shrinks fixed siblings first-come", container: row(200),
    items: [...repeatItem(1, { flex: "1", width: "150px" }, { flex: 1, width: 150 }), ...repeatItem(1, { width: "150px" }, { width: 150, shrink: 1 })] },
  { name: "items shrink by default", container: row(300),
    items: [...repeatItem(1, { width: "200px" }, { width: 200 }), ...repeatItem(1, { width: "200px" }, { width: 200 })] },
  { name: "shrink 0 keeps the width", container: row(300),
    items: [...repeatItem(1, { width: "200px", "flex-shrink": 0 }, { width: 200, shrink: 0 }), ...repeatItem(1, { width: "200px" }, { width: 200 })] },
  { name: "column items shrink by default", container: { css: { display: "flex", "flex-direction": "column", width: "100px", height: "100px" }, tarve: { direction: "column", width: 100, height: 100 } },
    items: [{ css: { height: "80px" }, tarve: { height: 80 } }, { css: { height: "80px" }, tarve: { height: 80 } }] },
  { name: "flex 1 1 176px wraps by basis", container: row(600, { "flex-wrap": "wrap", gap: "14px" }, { wrap: true, gap: 14 }),
    items: repeatItem(5, { flex: "1 1 176px" }, { flex: "1 1 176px" }) },
  { name: "grow and basis longhands", container: row(500),
    items: [
      ...repeatItem(1, { "flex-grow": 1, "flex-basis": "100px" }, { grow: 1, basis: 100 }),
      ...repeatItem(1, { "flex-grow": 3, "flex-basis": "100px" }, { grow: 3, basis: 100 }),
    ] },
  { name: "basis percentage", container: row(400),
    items: [...repeatItem(1, { "flex-basis": "25%" }, { basis: "25%" }), ...repeatItem(1, { "flex-basis": "50%" }, { basis: "50%" })] },
  { name: "shrink by default with css flex", container: row(300),
    items: repeatItem(3, { flex: "0 1 150px" }, { flex: "0 1 150px" }) },
  { name: "shrink weights", container: row(300),
    items: [...repeatItem(1, { flex: "0 1 200px" }, { flex: "0 1 200px" }), ...repeatItem(1, { flex: "0 3 200px" }, { flex: "0 3 200px" })] },
  { name: "flex none does not shrink", container: row(300),
    items: repeatItem(2, { flex: "none", width: "200px" }, { flex: "none", width: 200 }) },
  { name: "flex auto grows from width", container: row(500),
    items: [...repeatItem(1, { flex: "auto", width: "100px" }, { flex: "auto", width: 100 }), ...repeatItem(1, { flex: "auto", width: "200px" }, { flex: "auto", width: 200 })] },
  { name: "max-width caps growth", container: row(600),
    items: [...repeatItem(1, { flex: "1", "max-width": "120px" }, { flex: "1", maxWidth: 120 }), ...repeatItem(1, { flex: "1" }, { flex: "1" })] },
  { name: "min-width stops shrinking", container: row(200),
    items: [...repeatItem(1, { flex: "0 1 300px", "min-width": "150px" }, { flex: "0 1 300px", minWidth: 150 }), ...repeatItem(1, { flex: "0 1 300px" }, { flex: "0 1 300px" })] },
  { name: "column direction grow", container: { css: { display: "flex", "flex-direction": "column", width: "100px", height: "300px" }, tarve: { direction: "column", width: 100, height: 300 } },
    items: [...repeatItem(1, { flex: "1" }, { flex: "1" }), ...repeatItem(1, { flex: "2" }, { flex: "2" })].map(item => ({ css: { ...item.css, height: "auto" }, tarve: { ...item.tarve, height: undefined } })) },
  { name: "grid auto-fill minmax", container: grid(600, "repeat(auto-fill, minmax(176px, 1fr))", 14), items: repeatItem(7, {}, {}) },
  { name: "grid auto-fit minmax with few items", container: grid(600, "repeat(auto-fit, minmax(120px, 1fr))", 10), items: repeatItem(2, {}, {}) },
  { name: "grid auto-fill keeps empty tracks", container: grid(600, "repeat(auto-fill, minmax(120px, 1fr))", 10), items: repeatItem(2, {}, {}) },
  { name: "grid fixed and fr tracks", container: grid(500, "100px 1fr 2fr", 10), items: repeatItem(6, {}, {}) },
  { name: "grid repeat count", container: grid(400, "repeat(4, 1fr)", 8), items: repeatItem(5, {}, {}) },
  { name: "grid percent and auto", container: grid(400, "25% auto 100px", 0), items: repeatItem(3, { width: "40px" }, { width: 40 }) },
  { name: "grid explicit rows", container: { ...grid(300, "1fr 1fr", 0, "40px 1fr"), css: { ...grid(300, "1fr 1fr", 0, "40px 1fr").css, height: "200px" }, tarve: { ...grid(300, "1fr 1fr", 0, "40px 1fr").tarve, height: 200 } },
    items: Array.from({ length: 4 }, () => ({ css: {}, tarve: {} })) },
];

function cssText(css: Css): string {
  return Object.entries(css).map(([key, value]) => `${key}: ${value}`).join("; ");
}

function page(): string {
  const blocks = cases.map((c, index) => `<div class="case" id="case-${index}" style="${cssText(c.container.css)}">${c.items.map(item => item.raw ? item.html! : item.html !== undefined ? `<p style="${cssText(item.css)}">${item.html}</p>` : `<div style="${cssText(item.css)}"></div>`).join("")}</div>`).join("\n");
  return `<!doctype html><meta charset="utf-8"><style>@font-face{font-family:'Inter Variable';src:url(/inter.ttf);font-weight:100 900}*{box-sizing:border-box;padding:0}body{margin:0}ul,ol{padding-left:40px}td,th{padding:1px}body{font:12px sans-serif}.case{position:relative;margin-bottom:40px}.case>div,.case>p{background:#89b4fa;outline:1px solid #1e1e2e}</style>
${blocks}
<script>
document.fonts.ready.then(() => { const out = [...document.querySelectorAll(".case")].map(c => { const o = c.getBoundingClientRect(); return [...c.children].map(el => { const r = el.getBoundingClientRect(); return [r.left - o.left, r.top - o.top, r.width, r.height].map(v => Math.round(v * 100) / 100); }); });
fetch("/save", { method: "POST", body: JSON.stringify({ userAgent: navigator.userAgent, cases: out }) }).then(() => { document.title = "saved"; }); });
</script>`;
}

async function check(): Promise<number> {
  if (!existsSync(fixture)) throw new Error("No recorded CSS layout. Run: bun scripts/css-layout-parity.ts serve, then open it in Chromium.");
  const recorded = JSON.parse(readFileSync(fixture, "utf8")) as { names: string[]; cases: Box[][] };
  const { createTestRenderer, Window, View } = await import("@tarve/core");
  const { jsx } = await import("@tarve/core/jsx-runtime");
  let current = 0;
  const strip = (style: Tarve) => Object.fromEntries(Object.entries(style).filter(([, value]) => value !== undefined));
  const renderer = await createTestRenderer(() => jsx(Window, { width: 900, height: 700, children:
    jsx(View, { id: "parity", style: strip(cases[current]!.container.tarve) as never, children: cases[current]!.items.map((item, i) => item.raw
      ? item.inline!(jsx as unknown as Jsx, `parity-${i}`)
      : item.inline
      ? jsx("p", { id: `parity-${i}`, style: strip(item.tarve) as never, children: item.inline(jsx as unknown as Jsx) as never }, i)
      : jsx(View, { id: `parity-${i}`, style: strip(item.tarve) as never }, i)) }) }), { headless: true, fontFaces: [interFile] });
  let failures = 0;
  for (let index = 0; index < cases.length; index++) {
    current = index;
    renderer.app.update();
    await new Promise(resolve => setTimeout(resolve, 120));
    const snapshot = await renderer.app.inspect();
    const origin = snapshot.nodes.find(node => node.id === "parity")!;
    const boxes = cases[index]!.items.map((_, i) => {
      const node = snapshot.nodes.find(candidate => candidate.id === `parity-${i}`)!;
      return [node.x - origin.x, node.y - origin.y, node.width, node.height] as Box;
    });
    const expected = recorded.cases[recorded.names.indexOf(cases[index]!.name)];
    const bad = !expected || boxes.some((box, i) => box.some((value, k) => Math.abs(value - expected[i]![k]!) >= (cases[index]!.tolerance ?? 1)));
    if (bad) failures++;
    console.log(`${bad ? "FAIL" : "ok  "} ${cases[index]!.name}${bad ? `\n     css   ${JSON.stringify(expected)}\n     tarve ${JSON.stringify(boxes.map(b => b.map(v => Math.round(v * 100) / 100)))}` : ""}`);
  }
  renderer.app.close();
  console.log(failures ? `${failures}/${cases.length} layouts differ from CSS` : `[tarve css-layout-parity] PASS (${cases.length} layouts match Chromium)`);
  return failures ? 1 : 0;
}

const mode = process.argv[2] ?? "check";
if (mode === "serve") {
  Bun.serve({ port: 4799, async fetch(request) {
    const url = new URL(request.url);
    if (url.pathname === "/inter.ttf") return new Response(Bun.file(interFile));
    if (url.pathname === "/save") {
      const body = await request.json() as { userAgent: string; cases: Box[][] };
      writeFileSync(fixture, JSON.stringify({ recordedWith: body.userAgent, names: cases.map(c => c.name), cases: body.cases }, null, 1) + "\n");
      console.log(`saved ${body.cases.length} layouts from ${body.userAgent}`);
      return new Response("ok");
    }
    return new Response(page(), { headers: { "content-type": "text/html" } });
  } });
  console.log("open http://localhost:4799");
} else {
  process.exit(await check());
}
