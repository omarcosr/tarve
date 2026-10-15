import { writeFileSync } from "node:fs";
import { mount } from "../packages/svelte/src/index";
import App from "../examples/svelte/App.svelte";

// A built executable mounts the Svelte example, checks what native laid out, and reports.
const reportPath = process.argv[process.argv.indexOf("--smoke-report") + 1]!;
const { app, target } = mount(App, { debug: true, window: { title: "Svelte smoke", width: 520, height: 560 } });
// Layout reads are synchronous: even before the window is up, native lays the tree out and answers.
const beforeReady = target.querySelector("h1")!.getBoundingClientRect();
let report: Record<string, unknown>;
try {
  await app.ready;
  await new Promise(resolve => setTimeout(resolve, 300));
  const snapshot = await app.inspect();
  const texts = snapshot.nodes.map(node => node.text).filter(Boolean);
  const expected = ["Todos", "1 of 2 open", "Compile .svelte with @tarve/svelte", "Add"];
  const missing = expected.filter(text => !texts.includes(text));
  const laidOut = snapshot.nodes.filter(node => node.text && node.width > 0 && node.height > 0).length;
  const heading = target.querySelector("h1")!;
  const rect = heading.getBoundingClientRect();
  const measured = rect.width > 0 && rect.height > 0 && rect.y > 0 && beforeReady.width > 0 && beforeReady.height === rect.height;
  // A read right after a change sees the new layout, as a browser forces layout.
  const before = heading.offsetHeight;
  const started = performance.now();
  heading.style.setProperty("padding-top", "40px");
  const grown = heading.offsetHeight;
  const syncMs = Math.round((performance.now() - started) * 100) / 100;
  heading.style.removeProperty("padding-top");
  const restored = heading.offsetHeight;
  const forced = grown === before + 40 && restored === before;
  report = {
    result: missing.length === 0 && laidOut >= expected.length && measured && forced ? "PASS" : "FAIL",
    missing, nodes: snapshot.nodes.length, laidOut, rect: [rect.x, rect.y, rect.width, rect.height],
    beforeReady: [beforeReady.width, beforeReady.height], heights: [before, grown, restored], syncMs,
  };
} catch (error) {
  report = { result: "FAIL", error: String((error as Error)?.stack ?? error) };
}
writeFileSync(reportPath, JSON.stringify(report));
app.close();
await app.closed;
