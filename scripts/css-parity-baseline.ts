// Records how Chrome lays out each CSS parity case (packages/svelte/css-parity/cases.ts) into
// baseline.json: the reference `css-parity.test.ts` holds Tarve to. Rerun when cases change:
//   bun scripts/css-parity-baseline.ts        (CHROME=path to override the browser)
//   ONLY=<visual case name> re-shoots just that screenshot and leaves the rest as recorded.
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BASE_CSS, CASES, slug, VIEWPORT, VISUAL_CASES, VISUAL_CSS } from "../packages/svelte/css-parity/cases";

function chromePath(): string {
  for (const path of [process.env.CHROME, join(process.env.ProgramFiles ?? "", "Google/Chrome/Application/chrome.exe"),
    join(process.env["ProgramFiles(x86)"] ?? "", "Google/Chrome/Application/chrome.exe"), join(process.env.LOCALAPPDATA ?? "", "Google/Chrome/Application/chrome.exe"),
    join(process.env["ProgramFiles(x86)"] ?? "", "Microsoft/Edge/Application/msedge.exe"), "/usr/bin/google-chrome", "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"]) {
    if (path && existsSync(path)) return path;
  }
  throw new Error("Chrome not found (set CHROME)");
}

const MEASURE = `<script>
addEventListener("load", () => {
  const root = document.getElementById("case").getBoundingClientRect();
  const boxes = {};
  for (const element of document.querySelectorAll("#case [id]")) {
    const box = element.getBoundingClientRect();
    boxes[element.id] = [box.left - root.left, box.top - root.top, box.width, box.height].map(value => Math.round(value * 100) / 100);
  }
  boxes.case = [0, 0, Math.round(root.width * 100) / 100, Math.round(root.height * 100) / 100];
  boxes.__viewport = [innerWidth, innerHeight];
  const out = document.createElement("pre");
  out.id = "parity-result";
  out.textContent = JSON.stringify(boxes);
  document.body.appendChild(out);
});
</script>`;

const chrome = chromePath();
const dir = mkdtempSync(join(tmpdir(), "css-parity-"));
const only = process.env.ONLY;
const baseline: Record<string, Record<string, number[]>> = {};
try {
  for (const item of only ? [] : CASES) {
    const file = join(dir, "case.html");
    writeFileSync(file, `<!doctype html><html><head><meta charset="utf-8"><style>${BASE_CSS}\n${item.css}</style></head><body><div id="case">${item.html}</div>${MEASURE}</body></html>`);
    const { width, height } = VIEWPORT;
    const run = spawnSync(chrome, ["--headless=new", "--disable-gpu", "--hide-scrollbars", "--force-device-scale-factor=1", `--window-size=${width},${height}`,
      `--user-data-dir=${join(dir, "profile")}`, "--dump-dom", `file:///${file.replace(/\\/g, "/")}`], { encoding: "utf8", timeout: 60_000 });
    const match = /<pre id="parity-result">([^<]*)<\/pre>/.exec(run.stdout ?? "");
    if (!match) throw new Error(`${item.name}: Chrome produced no result\n${run.stderr}`);
    baseline[item.name] = JSON.parse(match[1]!.replace(/&quot;/g, '"').replace(/&amp;/g, "&"));
    console.log(`✓ ${item.name}`);
  }
  const visualDir = join(import.meta.dirname, "../packages/svelte/css-parity/visual");
  if (!only) rmSync(visualDir, { recursive: true, force: true });
  mkdirSync(visualDir, { recursive: true });
  for (const item of VISUAL_CASES.filter(item => !only || item.name === only)) {
    const file = join(dir, "visual.html");
    writeFileSync(file, `<!doctype html><html><head><meta charset="utf-8"><style>${BASE_CSS}\n${VISUAL_CSS}\n${item.css}</style></head><body><div id="case">${item.html}</div></body></html>`);
    const out = join(visualDir, `${slug(item.name)}.png`);
    rmSync(out, { force: true });
    spawnSync(chrome, ["--headless=new", "--disable-gpu", "--hide-scrollbars", "--force-device-scale-factor=1", `--window-size=${VIEWPORT.width},${VIEWPORT.height}`,
      `--user-data-dir=${join(dir, "profile")}`, `--screenshot=${out}`, `file:///${file.replace(/\\/g, "/")}`], { encoding: "utf8", timeout: 60_000 });
    if (!existsSync(out)) throw new Error(`${item.name}: Chrome took no screenshot`);
    console.log(`✓ ${item.name} (visual)`);
  }
} finally {
  rmSync(dir, { recursive: true, force: true });
}
if (!only) writeFileSync(join(import.meta.dirname, "../packages/svelte/css-parity/baseline.json"), JSON.stringify(baseline, null, 1) + "\n");
if (!only) console.log(`${CASES.length} cases → packages/svelte/css-parity/baseline.json`);
