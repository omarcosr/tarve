import { expect, test } from "bun:test";
import { compileTree } from "./reconciler";
import { Window } from "./components";
import { CanvasRenderingContext2D, parseCanvasFont } from "./canvas";

test("the recorder emits device-space paths, gradients and alpha", () => {
  const ctx = new CanvasRenderingContext2D(100, 50);
  ctx.translate(10, 5);
  ctx.fillStyle = "red";
  ctx.fillRect(0, 0, 20, 10);
  ctx.globalAlpha = 0.5;
  const g = ctx.createLinearGradient(0, 0, 10, 0);
  g.addColorStop(0, "#000"); g.addColorStop(1, "#fff");
  ctx.strokeStyle = g; ctx.lineWidth = 2;
  ctx.beginPath(); ctx.moveTo(0, 0); ctx.lineTo(5, 5); ctx.stroke();
  const svg = ctx.toSvg();
  expect(svg).toContain('d="M10 5L30 5L30 15L10 15Z" fill="red"');
  expect(svg).toContain('<linearGradient id="g0" gradientUnits="userSpaceOnUse" x1="10" y1="5" x2="20" y2="5">');
  expect(svg).toContain('stroke="url(#g0)" stroke-width="2"');
  expect(svg).toContain('opacity="0.5"');
});

test("clearing the whole canvas discards earlier drawing; save/restore scopes state", () => {
  const ctx = new CanvasRenderingContext2D(40, 40);
  ctx.fillRect(0, 0, 10, 10);
  ctx.clearRect(0, 0, 40, 40);
  expect(ctx.elements).toEqual([]);
  ctx.save(); ctx.fillStyle = "blue"; ctx.scale(2, 2); ctx.restore();
  expect(ctx.fillStyle).toBe("#000000");
  expect(ctx.getTransform()).toEqual([1, 0, 0, 1, 0, 0]);
});

test("canvas compiles to a sized native SVG scene plus positioned text", () => {
  const tree = compileTree(<Window><canvas id="c" width={200} height={100} onDraw={ctx => {
    ctx.fillRect(0, 0, 10, 10);
    ctx.font = "bold 20px Inter"; ctx.textAlign = "center"; ctx.textBaseline = "top"; ctx.fillStyle = "#123456";
    ctx.fillText("Hi", 100, 40);
  }} /></Window>);
  expect(tree.nodes.get("c")!.style).toMatchObject({ width: 200, height: 100, overflow: "hidden" });
  expect(tree.nodes.get("c-scene")!.kind).toBe("svg");
  const text = [...tree.nodes.values()].find(node => node.kind === "text" && node.text === "Hi")!;
  expect(text.style).toMatchObject({ fontSize: 20, fontWeight: 700, fontFamily: "Inter", foreground: "#123456" });
  expect(compileTree(<Window><canvas id="d" /></Window>).nodes.get("d")!.style).toMatchObject({ width: 300, height: 150 });
});

test("canvas font shorthand", () => {
  expect(parseCanvasFont("italic 600 14px/1.2 'Fira Code', monospace")).toEqual({ fontStyle: "italic", fontWeight: 600, fontSize: 14, fontFamily: "Fira Code" });
  expect(parseCanvasFont("12px sans-serif")).toEqual({ fontSize: 12, fontFamily: "sans-serif" });
});
