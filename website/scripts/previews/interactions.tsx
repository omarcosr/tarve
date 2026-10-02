// Clicks every interactive control of every documentation example with the real Tarve runtime
// (the WebAssembly build, through @tarve/headless: no window needed) and reports controls whose
// click changes nothing (layout, text, state or scroll), plus errors.
//   bun run docs:interactions            all components
//   bun run docs:interactions DataGrid   only the named components
import { readFileSync, readdirSync, writeFileSync, mkdirSync } from "node:fs";
import { basename, resolve } from "node:path";
import { Column, Window, darkTheme, type VNode } from "@tarve/core";
import { createHeadlessApp } from "@tarve/headless";
import { toPreviewModule } from "../../src/lib/playground/example-transform";

type Snapshot = Awaited<ReturnType<Awaited<ReturnType<typeof createHeadlessApp>>["inspect"]>>;
type Report = { name: string; controls: number; dead: string[]; errors: string[] };

const here = import.meta.dir;
const website = resolve(here, "../..");
const examplesDir = resolve(website, "src/lib/docs/examples");
const generatedDir = resolve(here, ".generated");
const INTERACTIVE = new Set(["button", "pressable", "input", "textarea", "link", "select", "slider"]);

function signature(snapshot: Snapshot): string {
  return JSON.stringify(
    snapshot.nodes.map((node) => [
      node.id,
      node.kind,
      Math.round(node.x),
      Math.round(node.y),
      Math.round(node.width),
      Math.round(node.height),
      node.text,
      Math.round(node.scroll),
      node.control ?? null,
    ]),
  ) + snapshot.focused;
}

/** A fresh copy of the example module, so every control is tested from the initial state. */
let copies = 0;
async function freshView(name: string, code: string, fullWindow: boolean): Promise<() => VNode> {
  const file = resolve(generatedDir, `${name}.interact-${copies++}.tsx`);
  writeFileSync(file, code);
  const mod = (await import(file)) as { preview: () => VNode };
  return fullWindow
    ? mod.preview
    : () => (
        <Window title={name} width={960} height={720} theme={darkTheme}>
          <Column flex={1} align="center" justify="center" padding={24}>
            {mod.preview()}
          </Column>
        </Window>
      );
}

async function checkOne(name: string): Promise<Report> {
  mkdirSync(generatedDir, { recursive: true });
  const { code, fullWindow } = toPreviewModule(name, readFileSync(resolve(examplesDir, name + ".tsx"), "utf8"));
  const errors: string[] = [];
  const app = await createHeadlessApp(await freshView(name, code, fullWindow), {
    assetRoot: resolve(website, "public"),
    onError: (event) => errors.push(event.error.message),
  });
  const settle = () => app.settle();
  try {
    const first = await app.inspect();
    const controls = first.nodes
      .filter((node) => (node.control || INTERACTIVE.has(node.kind)) && node.width > 4 && node.height > 4)
      .filter((node) => node.x >= 0 && node.y >= 0 && node.x + node.width <= first.width && node.y + node.height <= first.height)
      .slice(0, 16);
    const dead: string[] = [];
    for (const [index, control] of controls.entries()) {
      if (index > 0) {
        app.remount(await freshView(name, code, fullWindow));
        await settle();
      }
      const snapshot = await app.inspect();
      const target = snapshot.nodes.find((node) => node.id === control.id);
      if (!target) continue;
      const before = signature(snapshot);
      app.debug({ type: "input", action: "move", x: target.x + target.width / 2, y: target.y + target.height / 2 });
      app.debug({ type: "input", action: "down" });
      app.debug({ type: "input", action: "up" });
      await settle();
      if (target.kind === "input" || target.kind === "textarea") {
        app.debug({ type: "input", action: "text", text: "x" });
        await settle();
      }
      if (signature(await app.inspect()) === before) {
        const label = target.control?.label ?? target.text.slice(0, 30);
        dead.push(`${target.kind}#${target.id}${label ? ` "${label}"` : ""}${target.control?.role ? ` [${target.control.role}]` : ""}`);
      }
    }
    // Scrollable regions must actually scroll when wheeled (controlled lists need onScroll wired up).
    app.remount(await freshView(name, code, fullWindow));
    await settle();
    const scrollables = (await app.inspect()).nodes.filter((node) => node.scrollMax > 0 || (node.scrollMaxY ?? 0) > 0 || (node.scrollMaxX ?? 0) > 0);
    for (const region of scrollables.slice(0, 4)) {
      const before = signature(await app.inspect());
      app.debug({ type: "input", action: "move", x: region.x + region.width / 2, y: region.y + region.height / 2 });
      if ((region.scrollMaxX ?? 0) > 0 && !region.scrollMax && !(region.scrollMaxY ?? 0)) {
        app.debug({ type: "input", action: "wheel", deltaX: 200, deltaY: 0 });
      } else {
        app.debug({ type: "input", action: "wheel", delta: 200 });
      }
      await settle();
      if (signature(await app.inspect()) === before) dead.push(`${region.kind}#${region.id} does not scroll`);
    }
    return { name, controls: controls.length + scrollables.length, dead, errors };
  } finally {
    app.close();
  }
}

async function checkAll(selected: string[]): Promise<void> {
  const names = readdirSync(examplesDir)
    .filter((file) => file.endsWith(".tsx"))
    .map((file) => basename(file, ".tsx"))
    .filter((name) => selected.length === 0 || selected.includes(name))
    .sort();
  const reports: Report[] = [];
  for (const name of names) {
    try {
      reports.push(await checkOne(name));
    } catch (error) {
      reports.push({ name, controls: 0, dead: [], errors: [error instanceof Error ? error.message : String(error)] });
    }
  }
  let problems = 0;
  for (const report of reports) {
    if (report.errors.length || report.dead.length) problems++;
    const status = report.errors.length ? "✗" : report.dead.length ? "·" : "✓";
    console.log(`  ${status} ${report.name} (${report.controls} controls)`);
    for (const error of report.errors) console.log(`      error: ${error}`);
    for (const control of report.dead) console.log(`      no reaction: ${control}`);
  }
  console.log(`[interactions] ${reports.length} examples, ${problems} with errors or controls that did not react`);
  if (reports.some((report) => report.errors.length)) process.exit(1);
}

await checkAll(process.argv.slice(2));
