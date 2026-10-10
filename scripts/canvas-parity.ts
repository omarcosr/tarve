// Canvas 2D parity with Chromium. Each drawing runs once on a real <canvas> in
// Chromium (recorded to tests/fixtures/canvas-parity.json) and once through
// Tarve's <canvas> recorder in a hidden window; pixels must agree within
// anti-aliasing noise.
//   bun scripts/canvas-parity.ts serve   # open http://localhost:4798 in Chromium to record
//   bun scripts/canvas-parity.ts check
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { CanvasRenderingContext2D as Ctx } from "../packages/core/src/canvas";

const fixture = join(import.meta.dirname, "..", "tests", "fixtures", "canvas-parity.json");
const W = 160, H = 120;
const imageFile = join(import.meta.dirname, "..", "examples", "assets", "studio.png");
const interFile = join(import.meta.dirname, "..", "packages", "headless", "fonts", "InterVariable.ttf");
/** The image drawings use: a loaded <img> in Chromium, a path in Tarve. */
declare const IMG: string;
(globalThis as Record<string, unknown>).IMG = imageFile;
/** Upright text uses hinted glyph bitmaps whose edge pixels differ from Chromium's;
 * those drawings allow more edge pixels but must put the ink at the same place. */
const tolerance: Record<string, number> = { "text alignment and baselines": 0.04 };
/** Hinted upright glyphs snap their baseline to a device pixel. The fixture was
 * recorded at 1x; at a fractional scale (125%) the snap lands up to one device
 * pixel elsewhere, so those drawings allow that much more drift. */
const snapsBaseline = new Set(["text alignment and baselines"]);

export const drawings: Record<string, (ctx: Ctx) => void> = {
  "fill and stroke rects": ctx => {
    ctx.fillStyle = "#3b82f6"; ctx.fillRect(10, 10, 60, 40);
    ctx.strokeStyle = "#ef4444"; ctx.lineWidth = 4; ctx.strokeRect(90, 20, 50, 70);
  },
  "path with lines and curves": ctx => {
    ctx.beginPath(); ctx.moveTo(10, 100); ctx.lineTo(50, 20); ctx.quadraticCurveTo(80, 0, 110, 40);
    ctx.bezierCurveTo(130, 70, 150, 90, 120, 110); ctx.closePath();
    ctx.fillStyle = "rgba(34, 197, 94, 0.8)"; ctx.fill();
    ctx.lineWidth = 3; ctx.lineJoin = "round"; ctx.strokeStyle = "#111827"; ctx.stroke();
  },
  "arcs and circles": ctx => {
    ctx.beginPath(); ctx.arc(40, 60, 30, 0, Math.PI * 2); ctx.fillStyle = "#f97316"; ctx.fill();
    ctx.beginPath(); ctx.arc(115, 60, 30, Math.PI * 0.25, Math.PI * 1.5); ctx.lineWidth = 6; ctx.strokeStyle = "#6366f1"; ctx.stroke();
  },
  "transforms": ctx => {
    ctx.translate(80, 60); ctx.rotate(Math.PI / 6); ctx.scale(1.5, 1);
    ctx.fillStyle = "#14b8a6"; ctx.fillRect(-30, -20, 60, 40);
    ctx.setTransform(1, 0, 0, 1, 0, 0); ctx.fillStyle = "#000000"; ctx.fillRect(4, 4, 10, 10);
  },
  "save restore and alpha": ctx => {
    ctx.save(); ctx.globalAlpha = 0.5; ctx.fillStyle = "#ef4444"; ctx.fillRect(20, 20, 80, 60); ctx.restore();
    ctx.fillStyle = "#3b82f6"; ctx.fillRect(60, 40, 80, 60);
  },
  "linear and radial gradients": ctx => {
    const linear = ctx.createLinearGradient(0, 0, 160, 0);
    linear.addColorStop(0, "#ef4444"); linear.addColorStop(1, "#3b82f6");
    ctx.fillStyle = linear; ctx.fillRect(0, 0, 160, 50);
    const radial = ctx.createRadialGradient(80, 90, 0, 80, 90, 30);
    radial.addColorStop(0, "#ffffff"); radial.addColorStop(1, "#22c55e");
    ctx.fillStyle = radial; ctx.fillRect(50, 60, 60, 60);
  },
  "round rect, dashes and caps": ctx => {
    ctx.beginPath(); ctx.roundRect(10, 10, 80, 50, 12); ctx.fillStyle = "#a855f7"; ctx.fill();
    ctx.beginPath(); ctx.setLineDash([8, 4]); ctx.lineWidth = 4; ctx.lineCap = "butt"; ctx.moveTo(10, 90); ctx.lineTo(150, 90); ctx.strokeStyle = "#111827"; ctx.stroke();
    ctx.setLineDash([]); ctx.lineCap = "round"; ctx.lineWidth = 10; ctx.beginPath(); ctx.moveTo(110, 20); ctx.lineTo(140, 50); ctx.stroke();
  },
  "even-odd fill": ctx => {
    ctx.beginPath(); ctx.rect(20, 20, 120, 80); ctx.rect(50, 40, 60, 40); ctx.fillStyle = "#0ea5e9"; ctx.fill("evenodd");
  },
  "arcTo corners": ctx => {
    ctx.beginPath(); ctx.moveTo(20, 20); ctx.arcTo(140, 20, 140, 100, 30); ctx.arcTo(140, 100, 20, 100, 15); ctx.lineTo(20, 100);
    ctx.lineWidth = 5; ctx.strokeStyle = "#dc2626"; ctx.stroke();
  },
  "partial clearRect cuts earlier drawing": ctx => {
    ctx.fillStyle = "#2563eb"; ctx.fillRect(10, 10, 140, 100);
    ctx.fillStyle = "#f97316"; ctx.beginPath(); ctx.arc(80, 60, 40, 0, Math.PI * 2); ctx.fill();
    ctx.clearRect(40, 30, 50, 40);
    ctx.translate(120, 90); ctx.rotate(Math.PI / 4); ctx.clearRect(-10, -10, 20, 20);
    ctx.setTransform(1, 0, 0, 1, 0, 0); ctx.fillStyle = "#16a34a"; ctx.fillRect(60, 50, 20, 20);
  },
  "drawImage scaled and cropped": ctx => {
    ctx.drawImage(IMG, 10, 10, 60, 40);
    ctx.drawImage(IMG, 0, 0, 40, 40, 80, 10, 70, 70);
    ctx.fillStyle = "#dc2626"; ctx.fillRect(20, 60, 30, 30);
    ctx.globalAlpha = 0.5; ctx.drawImage(IMG, 30, 70, 60, 40);
  },
  "rotated and scaled text": ctx => {
    ctx.font = "600 22px 'Inter Variable'"; ctx.fillStyle = "#111827";
    ctx.translate(30, 90); ctx.rotate(-Math.PI / 8); ctx.fillText("Tarve", 0, 0);
    ctx.setTransform(1, 0, 0, 1, 0, 0); ctx.scale(1.5, 1); ctx.font = "16px 'Inter Variable'"; ctx.fillStyle = "#b91c1c"; ctx.fillText("wide", 50, 30);
  },
  "text alignment and baselines": ctx => {
    ctx.font = "18px 'Inter Variable'"; ctx.fillStyle = "#1e3a8a";
    ctx.textAlign = "center"; ctx.textBaseline = "middle"; ctx.fillText("center", 80, 30);
    ctx.textAlign = "right"; ctx.textBaseline = "alphabetic"; ctx.fillText("right", 150, 80);
    ctx.textAlign = "left"; ctx.textBaseline = "top"; ctx.fillText("top", 10, 90);
  },
  "ellipse rotated": ctx => {
    ctx.beginPath(); ctx.ellipse(80, 60, 60, 25, Math.PI / 5, 0, Math.PI * 2); ctx.fillStyle = "#eab308"; ctx.fill();
  },
};

function page(): string {
  const entries = Object.entries(drawings).map(([name, draw]) => `[${JSON.stringify(name)}, ${draw.toString()}]`).join(",\n");
  return `<!doctype html><meta charset="utf-8"><style>@font-face{font-family:'Inter Variable';src:url(/inter.ttf);font-weight:100 900}</style><body style="margin:0"><script type="module">
const drawings = [${entries}];
const IMG = new Image(); IMG.src = "/image.png"; await IMG.decode();
await document.fonts.load("16px 'Inter Variable'"); await document.fonts.load("600 16px 'Inter Variable'");
const out = {};
for (const [name, draw] of drawings) {
  const canvas = document.createElement("canvas"); canvas.width = ${W}; canvas.height = ${H};
  const ctx = canvas.getContext("2d");
  draw(ctx);
  // Composite onto white, as the Tarve window behind the canvas is white.
  const flat = document.createElement("canvas"); flat.width = ${W}; flat.height = ${H};
  const fctx = flat.getContext("2d"); fctx.fillStyle = "#ffffff"; fctx.fillRect(0, 0, ${W}, ${H}); fctx.drawImage(canvas, 0, 0);
  out[name] = Array.from(fctx.getImageData(0, 0, ${W}, ${H}).data);
  document.body.appendChild(flat);
}
fetch("/save", { method: "POST", body: JSON.stringify({ userAgent: navigator.userAgent, images: out }) }).then(() => { document.title = "saved"; });
</script>`;
}

async function check(): Promise<number> {
  if (!existsSync(fixture)) throw new Error("No recorded canvases. Run: bun scripts/canvas-parity.ts serve");
  const recorded = JSON.parse(readFileSync(fixture, "utf8")) as { images: Record<string, number[]> };
  const { createTestRenderer, Window, readPngRgba } = await import("@tarve/core");
  const { jsx } = await import("@tarve/core/jsx-runtime");
  let current = Object.keys(drawings)[0]!;
  const renderer = await createTestRenderer(() => jsx(Window, { width: 400, height: 300, style: { background: "#ffffff" },
    children: jsx("canvas", { id: "c", width: W, height: H, onDraw: drawings[current] }) }), { headless: true, fontFaces: [interFile] });
  let failures = 0;
  const path = join(import.meta.dirname, "..", "work", "canvas-parity.png");
  for (const name of Object.keys(drawings)) {
    current = name;
    renderer.app.update();
    await new Promise(resolve => setTimeout(resolve, 200));
    const snapshot = await renderer.app.inspect();
    const box = snapshot.nodes.find(node => node.id === "c")!;
    await renderer.app.capture(path);
    const image = await readPngRgba(path);
    const scale = image.width / snapshot.width;
    const expected = recorded.images[name]!;
    let different = 0;
    let worst = 0;
    const filtered = new Float64Array(W * H * 3);
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
      // Box-filter the device pixels that cover this CSS pixel: at a fractional
      // device scale, point sampling would read a half-covered edge as all or nothing.
      const x0 = (box.x + x) * scale, x1 = x0 + scale, y0 = (box.y + y) * scale, y1 = y0 + scale;
      const sum = [0, 0, 0];
      let area = 0;
      for (let py = Math.floor(y0); py < Math.ceil(y1); py++) for (let px = Math.floor(x0); px < Math.ceil(x1); px++) {
        const weight = (Math.min(x1, px + 1) - Math.max(x0, px)) * (Math.min(y1, py + 1) - Math.max(y0, py));
        const t = (py * image.width + px) * 4;
        for (let k = 0; k < 3; k++) sum[k]! += image.rgba[t + k]! * weight;
        area += weight;
      }
      const e = (y * W + x) * 4;
      const actual = sum.map(v => v / area);
      for (let k = 0; k < 3; k++) filtered[(y * W + x) * 3 + k] = actual[k]!;
      const delta = Math.round(Math.max(...[0, 1, 2].map(k => Math.abs(actual[k]! - expected[e + k]!))));
      worst = Math.max(worst, delta);
      if (delta > 48) { different++; if (process.env.CANVAS_DEBUG === name) console.log("diff", x, y, actual.map(Math.round), [0, 1, 2].map(k => expected[e + k])); }
    }
    const centroid = (get: (x: number, y: number) => number[]) => { let sx = 0, sy = 0, n = 0, minY = 1e9, maxY = 0, minX = 1e9, maxX = 0; for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) { const p = get(x, y); const ink = 765 - p[0]! - p[1]! - p[2]!; if (ink > 20) { sx += x * ink; sy += y * ink; n += ink; } if (ink > 150) { minY = Math.min(minY, y); maxY = Math.max(maxY, y); minX = Math.min(minX, x); maxX = Math.max(maxX, x); } } return [sx / n, sy / n, minX, maxX, minY, maxY].map(v => Math.round(v * 10) / 10); };
    const inkChromium = centroid((x, y) => [0, 1, 2].map(k => expected[(y * W + x) * 4 + k]!));
    // The same box-filtered pixels as above: point-sampling one device pixel per CSS
    // pixel at a fractional scale skips whole device columns and drifts the centre.
    const inkTarve = centroid((x, y) => [0, 1, 2].map(k => filtered[(y * W + x) * 3 + k]!));
    const drift = Math.hypot(inkChromium[0]! - inkTarve[0]!, inkChromium[1]! - inkTarve[1]!);
    if (process.env.CANVAS_DEBUG === name) console.log("chromium", inkChromium, "tarve", inkTarve);
    // Only anti-aliased edge pixels may differ.
    const ratio = different / (W * H);
    // The ink's centre of mass must agree within half a pixel, whatever the edges do.
    const maxDrift = 0.5 + (snapsBaseline.has(name) && !Number.isInteger(scale) ? 1 / scale : 0);
    const bad = ratio > (tolerance[name] ?? 0.005) || drift > maxDrift;
    if (bad) failures++;
    console.log(`${bad ? "FAIL" : "ok  "} ${name}: ${(ratio * 100).toFixed(2)}% of pixels differ (max channel delta ${worst}), ink centre ${drift.toFixed(2)}px apart`);
  }
  renderer.app.close();
  console.log(failures ? `${failures} drawings differ from Chromium` : `[tarve canvas-parity] PASS (${Object.keys(drawings).length} drawings match Chromium)`);
  return failures ? 1 : 0;
}

if ((process.argv[2] ?? "check") === "serve") {
  Bun.serve({ port: 4798, async fetch(request) {
    const path = new URL(request.url).pathname;
    if (path === "/image.png") return new Response(Bun.file(imageFile));
    if (path === "/inter.ttf") return new Response(Bun.file(interFile));
    if (path === "/save") {
      const body = await request.json() as { userAgent: string; images: Record<string, number[]> };
      writeFileSync(fixture, JSON.stringify({ recordedWith: body.userAgent, width: W, height: H, images: body.images }));
      console.log(`saved ${Object.keys(body.images).length} canvases from ${body.userAgent}`);
      return new Response("ok");
    }
    return new Response(page(), { headers: { "content-type": "text/html" } });
  } });
  console.log("open http://localhost:4798");
} else {
  process.exit(await check());
}
