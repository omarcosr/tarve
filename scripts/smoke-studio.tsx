// Clicks through every Studio section and every component preview in a hidden
// window and fails on any render or native error.
import { createTestRenderer } from "@tarve/core";
import { App, connectStudio, componentRows } from "../examples/studio-view";
const errors: string[] = [];
let r: any;
connectStudio({ refresh: () => r?.app.update(), openFile: async () => undefined, build: { unavailable: "x" } });
r = await createTestRenderer(App, { headless: true, onError: (e: any) => errors.push(e.source + ": " + e.error.message) });
r.app.onEvent((e: any) => { if (e.type === "error") errors.push("native: " + e.message); });
const wait = (ms: number) => new Promise(res => setTimeout(res, ms));
const text = async () => (await r.app.inspect()).nodes.map((n: any) => n.text).join(" ");
const out: string[] = [];
for (const s of ["Overview", "Layout", "Renderer", "Profiler", "Accessibility", "Settings", "Components"]) {
  await r.getByText(s, { exact: true }).click(); await wait(250);
  const t = await text();
  out.push(s + ": " + (t.includes(s) ? "ok" : "MISSING") + (errors.length ? " ERR " + errors.splice(0).join(" | ") : ""));
}
for (const row of componentRows) {
  await r.getById("studio-search").fill(row.name); await wait(200);
  await r.getById("studio-grid-row-" + row.name).click(); await wait(250);
  const t = await text();
  out.push(row.name + ": " + (t.includes("<" + row.name + "> — live preview") ? "preview" : "NO PREVIEW") + (errors.length ? " ERR " + errors.splice(0).join(" | ") : ""));
}
await r.getById("studio-search").fill("Button"); await wait(200);
await r.getById("studio-grid-row-Button").click(); await wait(250);
await r.getById("p-button").click(); await wait(150); await r.getById("p-button").click(); await wait(150);
out.push("code tab: " + ((await text()).includes("Button.tsx") ? "ok" : "FAIL"));
out.push("button clicks: " + ((await text()).includes("2 clicks") ? "ok" : "FAIL"));
await r.getById("studio-search").fill("Slider"); await wait(200);
await r.getById("studio-grid-row-Slider").click(); await wait(250);
await r.getById("p-slider").press("ArrowRight"); await wait(150);
out.push("slider: " + ((await text()).match(/Value: \d+/)?.[0] ?? "FAIL"));
console.log(out.join("\n"));
const bad = out.filter(line => /MISSING|NO PREVIEW|NOT FOUND|FAIL|ERR/.test(line));
if (bad.length || errors.length) { console.error("studio smoke FAILED", bad, errors); process.exit(1); }
console.log("[tarve smoke:studio] PASS");
r.app.close();
