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
  "ellipse rotated": ctx => {
    ctx.beginPath(); ctx.ellipse(80, 60, 60, 25, Math.PI / 5, 0, Math.PI * 2); ctx.fillStyle = "#eab308"; ctx.fill();
  },
};

function page(): string {
  const entries = Object.entries(drawings).map(([name, draw]) => `[${JSON.stringify(name)}, ${draw.toString()}]`).join(",\n");
  return `<!doctype html><meta charset="utf-8"><body style="margin:0"><script>
const drawings = [${entries}];
const out = {};
for (const [name, draw] of drawings) {
  const canvas = document.createElement("canvas"); canvas.width = ${W}; canvas.height = ${H};
  const ctx = canvas.getContext("2d"); ctx.fillStyle = "#ffffff"; ctx.fillRect(0, 0, ${W}, ${H});
  ctx.fillStyle = "#000000"; draw(ctx);
  out[name] = Array.from(ctx.getImageData(0, 0, ${W}, ${H}).data);
  document.body.appendChild(canvas);
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
    children: jsx("canvas", { id: "c", width: W, height: H, onDraw: drawings[current] }) }), { headless: true });
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
      const delta = Math.round(Math.max(...[0, 1, 2].map(k => Math.abs(actual[k]! - expected[e + k]!))));
      worst = Math.max(worst, delta);
      if (delta > 48) { different++; if (process.env.CANVAS_DEBUG === name) console.log("diff", x, y, actual.map(Math.round), [0, 1, 2].map(k => expected[e + k])); }
    }
    // Only anti-aliased edge pixels may differ.
    const ratio = different / (W * H);
    const bad = ratio > 0.005;
    if (bad) failures++;
    console.log(`${bad ? "FAIL" : "ok  "} ${name}: ${(ratio * 100).toFixed(2)}% of pixels differ (max channel delta ${worst})`);
  }
  renderer.app.close();
  console.log(failures ? `${failures} drawings differ from Chromium` : `[tarve canvas-parity] PASS (${Object.keys(drawings).length} drawings match Chromium)`);
  return failures ? 1 : 0;
}

if ((process.argv[2] ?? "check") === "serve") {
  Bun.serve({ port: 4798, async fetch(request) {
    if (new URL(request.url).pathname === "/save") {
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
