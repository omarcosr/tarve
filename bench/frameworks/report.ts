/**
 * Writes bench/frameworks/README.md from work/frameworks/results.json (run.ts) and a phase
 * breakdown of Tarve's update (the bench apps with STATS=1), and copies the raw results next to it.
 *   bun bench/frameworks/report.ts        DATE=2026-11-21 (default: the results' date)
 */
import { cpSync, existsSync, mkdirSync, readdirSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";

const root = resolve(import.meta.dir, "../..");
const work = join(root, "work/frameworks");
const here = import.meta.dir;
const results = await Bun.file(join(work, "results.json")).json() as { at: string; runs: number; summary: Record<string, any>[] };
const summary = results.summary;
const date = process.env.DATE ?? results.at.slice(0, 10);
const commit = Bun.spawnSync(["git", "rev-parse", "--short", "HEAD"], { cwd: root }).stdout.toString().trim();

const names: Record<string, string> = {
  "tarve-bun": "Tarve · Bun", "tarve-bun-lowpower": "Tarve · Bun `lowPower`", "tarve-node": "Tarve · Node",
  "tarve-node-lowpower": "Tarve · Node `lowPower`", "tarve-txiki": "Tarve · txiki", "tarve-txiki-lowpower": "Tarve · txiki `lowPower`",
  electron: "Electron", tauri: "Tauri", flutter: "Flutter", "dioxus-native": "Dioxus Native", egui: "egui",
};
const order = Object.keys(names);
const apps = order.filter(app => summary.some(row => row.app === app));
const row = (app: string, scene: string) => summary.find(entry => entry.app === app && entry.scene === scene)!;
const tarve = (app: string) => app.startsWith("tarve");

interface Metric { group: string; title: string; key: string; scene: string; unit: string; extraLabel: string; extra: (app: string) => unknown; what: string }
const metrics: Metric[] = [
  { group: "Size and startup", title: "Disk size", key: "diskMb", scene: "list", unit: "MB", extraLabel: "Zipped MB", extra: app => row(app, "list").zipMb,
    what: 'What has to ship (the executable and the files next to it). "Zipped" is the download size as a .zip. Tauri relies on the WebView2 runtime already installed on Windows, which is not counted.' },
  { group: "Size and startup", title: "First frame, empty screen", key: "firstFrameMs", scene: "empty", unit: "ms", extraLabel: "Window created (ms)", extra: app => row(app, "empty").firstWindowMs,
    what: "From `CreateProcess` until the content shows on screen." },
  { group: "Size and startup", title: "First frame, 2,000 rows", key: "firstFrameMs", scene: "list", unit: "ms", extraLabel: "Window created (ms)", extra: app => row(app, "list").firstWindowMs,
    what: "The same, with the whole list built." },
  { group: "Memory", title: "Idle RAM, empty screen", key: "idle.privateWsMb", scene: "empty", unit: "MB", extraLabel: "Committed (MB)", extra: app => row(app, "empty")["idle.privateMb"],
    what: 'Private working set: physical RAM used only by the app, summed over all its processes. "Committed" is the reserved memory (private bytes).' },
  { group: "Memory", title: "Idle RAM, 2,000 rows", key: "idle.privateWsMb", scene: "list", unit: "MB", extraLabel: "Committed (MB)", extra: app => row(app, "list")["idle.privateMb"],
    what: "The same, with the list built." },
  { group: "Memory", title: "GPU memory", key: "gpuDedicatedMb", scene: "empty", unit: "MB", extraLabel: "With 2,000 rows (MB)", extra: app => row(app, "list").gpuDedicatedMb,
    what: "Dedicated video memory from the Windows `GPU Process Memory` counter. The `lowPower` variants draw on the CPU and use no GPU." },
  { group: "Interaction", title: "CPU while scrolling", key: "busyCpuPct", scene: "list", unit: "% of one core", extraLabel: "GPU 3D use %", extra: app => row(app, "list").busyGpu3dPct,
    what: "240 real mouse-wheel steps (SendInput), about 60 per second, over the list." },
  { group: "Interaction", title: "Update time", key: "updateMs.p50", scene: "list", unit: "ms (median)", extraLabel: "95th percentile (ms)", extra: app => row(app, "list")["updateMs.p95"],
    what: 'Real clicks on the "Update" button, each one changing the text of all 2,000 rows. Measured from the click until the new colour shows on screen.' },
];
const slug = (text: string) => text.toLowerCase().replace(/[^a-z0-9 -]/g, "").replace(/ /g, "-");
const ordinal = (n: number) => n + (n % 10 === 1 && n !== 11 ? "st" : n % 10 === 2 && n !== 12 ? "nd" : n % 10 === 3 && n !== 13 ? "rd" : "th");
const ranked = (metric: Metric) => apps.map(app => ({ app, value: row(app, metric.scene)[metric.key] as number, extra: metric.extra(app) }))
  .sort((a, b) => a.value - b.value || order.indexOf(a.app) - order.indexOf(b.app));

let summaryTable = "| # | Metric | 1st place | Best Tarve | Tarve rank |\n| ---: | --- | --- | --- | :---: |\n";
const wins: string[] = [], losses: string[] = [];
metrics.forEach((metric, index) => {
  const rows = ranked(metric);
  const best = rows.find(entry => tarve(entry.app))!;
  const rank = rows.filter(entry => entry.value < best.value).length + 1;
  (rank === 1 ? wins : losses).push(`${index + 1}`);
  summaryTable += `| ${index + 1} | [${metric.title}](#${index + 1}-${slug(metric.title)}) | ${names[rows[0]!.app]} · ${rows[0]!.value} ${metric.unit} | ${names[best.app]} · ${best.value} ${metric.unit} | ${ordinal(rank)} of ${apps.length} |\n`;
});

let sections = "";
let group = "";
metrics.forEach((metric, index) => {
  if (metric.group !== group) { group = metric.group; sections += `\n## ${group}\n`; }
  const rows = ranked(metric);
  const first = rows[0]!.value;
  sections += `\n### ${index + 1}. ${metric.title}\n\n${metric.what}\n\n| # | App | ${metric.unit} | vs 1st | ${metric.extraLabel} |\n| ---: | --- | ---: | ---: | ---: |\n`;
  rows.forEach((entry, position) => {
    const versus = entry.value === first ? "—" : first === 0 ? `+${entry.value}` : `${(entry.value / first).toFixed(1)}×`;
    const name = tarve(entry.app) ? `**${names[entry.app]}**` : names[entry.app];
    sections += `| ${position + 1} | ${name} | ${entry.value} | ${versus} | ${entry.extra ?? "—"} |\n`;
  });
});

// Where Tarve's update goes, from the app itself (app.stats()).
const phases: Record<string, Record<string, string>> = {};
for (const runtime of ["bun", "txiki"]) {
  const exe = join(work, `tarve-${runtime}/bench.exe`);
  if (!existsSync(exe)) continue;
  const run = Bun.spawnSync([exe], { env: { ...process.env, SCENE: "list", STATS: "1" }, stdout: "pipe", stderr: "pipe" });
  try { phases[runtime] = JSON.parse(run.stdout.toString().trim().split("\n").pop()!); } catch {}
}
const p50 = (value: string | undefined) => value ? `${value.replace("/", " / ")} ms` : "—";
const phaseRows: [string, string][] = [["JS update (render + diff + send)", "update"], ["↳ JS render", "render"], ["↳ JS diff", "diff"],
  ["Native apply", "apply"], ["Native layout (taffy + text)", "layout"], ["Native paint", "paint"], ["Native frame (CPU)", "frame"]];
const phaseTable = "| Phase | Bun | txiki |\n| --- | ---: | ---: |\n" + phaseRows.map(([label, key]) => `| ${label} | ${p50(phases.bun?.[key])} | ${p50(phases.txiki?.[key])} |\n`).join("");

const columns: [string, string][] = [["diskMb", "Disk MB"], ["zipMb", "Zipped MB"], ["firstWindowMs", "Window ms"], ["firstFrameMs", "First frame ms"],
  ["idle.privateMb", "Committed MB"], ["idle.privateWsMb", "Private WS MB"], ["idle.wsMb", "Working set MB"], ["idle.threads", "Threads"],
  ["idle.handles", "Handles"], ["idle.procs", "Processes"], ["idleCpuPct", "Idle CPU %"], ["gpuDedicatedMb", "Dedicated GPU MB"],
  ["gpuSharedMb", "Shared GPU MB"], ["busyCpuPct", "Scroll CPU %"], ["busyGpu3dPct", "Scroll GPU 3D %"], ["updateMs.p50", "Update median ms"],
  ["updateMs.p95", "Update p95 ms"], ["updateMs.max", "Update max ms"], ["updateMs.misses", "Missed clicks"], ["peakPrivateMb", "Peak committed MB"],
  ["peakWsMb", "Peak working set MB"], ["after.privateMb", "Final committed MB"], ["after.privateWsMb", "Final private WS MB"],
  ["machineBusyPct", "Machine busy %"], ["runs", "Runs"]];
let full = "";
for (const [scene, title] of [["empty", "Empty screen"], ["list", "2,000 rows"]] as const) {
  full += `\n### ${title}\n\n| App | ${columns.map(column => column[1]).join(" | ")} |\n| --- | ${columns.map(() => "---:").join(" | ")} |\n`;
  for (const app of apps) full += `| ${names[app]} | ${columns.map(([key]) => row(app, scene)[key] ?? "—").join(" | ")} |\n`;
}

const readme = `# Cross-framework GUI benchmark

The same screen built in Tarve and in 5 other GUI frameworks (Electron, Tauri, Flutter, Dioxus Native, egui), all measured from outside the process in exactly the same way.

- **Date:** ${date} · median of ${results.runs} runs per app and scene · **lower is better for every metric**
- **Machine:** Intel Core Ultra 7 255HX, RTX 5070 Laptop, 31 GB, Windows 11 Insider 26340, 125% scaling, 240 Hz
- **Versions:** Tarve 0.13.6 at \`${commit}\` (Bun 1.4.4, Node 26.10, txiki), Electron 45.4.1 + React 19.3, Tauri 2.12 (WebView2 157) + React 19.3, Flutter 3.50.1, Dioxus Native 0.7.10, egui/eframe 0.33
- **Tarve variants:** Bun, Node or txiki as the JavaScript runtime; GPU rendering by default (\`auto\`, D3D11) or the \`lowPower\` option (CPU rendering).

## Summary

${summaryTable}
**At a glance:** Tarve is 1st in metric${wins.length > 1 ? "s" : ""} ${wins.join(", ")}${losses.length ? ` and behind in ${losses.join(", ")}` : ""} (each with its best variant; see [PERFORMANCE.md](../../PERFORMANCE.md) for what changed between runs).
${sections}
## Where Tarve spends the 2,000-row update

Measured inside the app with \`app.stats()\` (\`STATS=1\`), median / 95th percentile over its frames. Layout runs only for the rows that show; the rest lays out after the frame is presented, in a frame of its own.

${phaseTable}
## Method

The meter lives in \`harness/\`; it is the same for every app and runs on Windows only.

- **Screen:** a 48×48 marker at the top-left corner, an "Update" button and, in the list scene, 2,000 rows (text and button) in a scroll area. Each click on "Update" changes the text of **every** row and the marker's colour.
- **First frame:** the magenta marker is read from the composited screen with BitBlt.
- **Memory and CPU:** summed over the whole process tree, since Electron and WebView2 spawn child processes. The app idles for 3 s after the first frame, then idle CPU is measured for 5 s.
- **Input:** real mouse input through SendInput, after checking that the window is on top before each click.
- **Order:** runs are interleaved round by round, so slow drifts on the machine hit every app alike.

To reproduce:

\`\`\`
bun bench/frameworks/build.ts          # FLUTTER=<flutter.bat> if it is not on PATH
RUNS=5 bun bench/frameworks/run.ts     # → work/frameworks/results.json, results.jsonl, shots/
bun bench/frameworks/report.ts         # → this README and results/
\`\`\`

## Limitations

- A single machine, warm starts only (files already in the OS cache). Other work used part of the CPU, recorded in the "Machine busy %" column.
- No app virtualizes the list: Electron and Tauri use React 19 without virtualization and Flutter uses a \`Column\`; the idiomatic \`ListView.builder\` would build only the visible rows. egui is immediate mode and redraws the whole window on every input.
- Update times include vsync and Windows composition (DWM), about 4 ms at 240 Hz. On the empty screen every app takes 4–12 ms.
- An accessibility client was active on this machine (Windows asked every app for its accessibility tree), as on many desktops.
- Dioxus Native 0.7.10 still describes itself as experimental.

## Full data

Every collected metric, median of ${results.runs} runs. Individual runs are in \`results/results.jsonl\`, medians in \`results/results.json\` and first-run screenshots in \`results/shots/\`. "Missed clicks" counts clicks whose change did not reach the screen within 3 s.
${full}`;
await Bun.write(join(here, "README.md"), readme);

const out = join(here, "results");
mkdirSync(join(out, "shots"), { recursive: true });
cpSync(join(work, "results.json"), join(out, "results.json"));
cpSync(join(work, "results.jsonl"), join(out, "results.jsonl"));
for (const file of readdirSync(join(out, "shots"))) rmSync(join(out, "shots", file));
for (const file of readdirSync(join(work, "shots")).filter(name => name.endsWith(".bmp"))) {
  // PNG through PowerShell's System.Drawing: no image dependency for a report script.
  const source = join(work, "shots", file), target = join(out, "shots", file.replace(/\.bmp$/, ".png"));
  Bun.spawnSync(["powershell", "-NoProfile", "-Command", `Add-Type -AssemblyName System.Drawing; $i=[System.Drawing.Image]::FromFile('${source}'); $i.Save('${target}', [System.Drawing.Imaging.ImageFormat]::Png); $i.Dispose()`]);
}
console.log(`README.md and results/ written (${wins.length} of ${metrics.length} metrics 1st)`);
