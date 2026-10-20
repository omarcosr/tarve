/**
 * The same example app must behave the same on every runtime. Each example view renders
 * under Bun (the reference), then as a Node.js SEA and a txiki.js executable, plain and
 * with --compile-jsx, through the packaged CLI. Every run drives the same input: hover,
 * clicks, focusing an input, typing, Tab and a wheel scroll. The node tree (ids,
 * geometry, text) and the captures must match the Bun run exactly.
 *
 *   bun run smoke:runtime-parity [example ...]     (RUNTIME_PARITY_VARIANTS=node,txiki,txiki-c)
 */
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { readPngRgba } from "../packages/core/src/index";

const root = resolve(import.meta.dir, "..");
const examples = join(root, "examples");
// The repository CLI, as examples run it (scripts/setup-examples.ts).
const cli = join(root, "packages/core/cli.ts");
const VIEWS = ["basic","components","diff","drag-and-drop","forms","glass","gradients","html","intrinsics","large-list","liquid","motion","performance","rich-content","tailwind","text"];
const views = process.argv.slice(2).length ? process.argv.slice(2) : VIEWS;
const variants = (process.env.RUNTIME_PARITY_VARIANTS ?? "node,node-c,txiki,txiki-c,bun-c").split(",");
const entries = join(examples, "_runtime-parity");
const out = join(root, "work/runtime-parity");
rmSync(entries, { recursive: true, force: true });
mkdirSync(entries, { recursive: true });
mkdirSync(out, { recursive: true });

// Runs inside each app: settle, capture, then drive input and capture again.
const entry = (view: string) => `import { writeFileSync } from "node:fs";
import { createApp } from "@tarve/core";
import { lucideReactAdapter, phosphorReactAdapter, reactSvgAdapter } from "@tarve/react-icons";
import { App } from "../${view}/${view}-view";
const out = process.argv[process.argv.length - 1]!;
const errors: string[] = [];
const app = createApp(App as any, { renderer: "cpu", debug: true, componentAdapters: [reactSvgAdapter, lucideReactAdapter, phosphorReactAdapter] });
app.onEvent(event => { if (event.type === "error") errors.push(event.message); });
const wait = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
const nodes = (snapshot: any) => snapshot.nodes.map((n: any) => [n.id, Math.round(n.x), Math.round(n.y), Math.round(n.width), Math.round(n.height), n.text ?? ""]);
const centre = (n: any) => ({ x: n.x + n.width / 2, y: n.y + n.height / 2 });
const visible = (snapshot: any, kinds: string[]) => snapshot.nodes.filter((n: any) => kinds.includes(n.kind) && n.width > 0 && n.height > 0 && n.y >= 0 && n.y + n.height <= snapshot.height);
let code = 0;
try {
  await app.ready;
  let snapshot = await app.inspect();
  for (let i = 0; i < 100 && snapshot.frames === 0; i++) { await wait(20); snapshot = await app.inspect(); }
  await wait(600);
  snapshot = await app.inspect();
  await app.capture(out + "-initial.png");
  const buttons = visible(snapshot, ["button", "pressable"]).slice(0, 3);
  if (buttons[0]) { app.debug({ type: "input", action: "move", ...centre(buttons[0]) }); await wait(250); }
  const hover = await app.inspect();
  await app.capture(out + "-hover.png");
  for (const button of buttons) {
    app.debug({ type: "input", action: "move", ...centre(button) });
    app.debug({ type: "input", action: "down" });
    app.debug({ type: "input", action: "up" });
    await wait(150);
  }
  const input = visible(await app.inspect(), ["input", "textarea"])[0];
  if (input) {
    app.debug({ type: "input", action: "move", ...centre(input) });
    app.debug({ type: "input", action: "down" });
    app.debug({ type: "input", action: "up" });
    await wait(100);
    app.debug({ type: "input", action: "text", text: "tarve 123" });
    app.debug({ type: "input", action: "key", text: "Tab" });
    await wait(150);
  }
  app.debug({ type: "input", action: "move", x: snapshot.width / 2, y: snapshot.height / 2 });
  app.debug({ type: "input", action: "wheel", deltaX: 0, deltaY: 240 });
  await wait(300);
  app.debug({ type: "input", action: "move", x: -1, y: -1 });
  await wait(400);
  const after = await app.inspect();
  await app.capture(out + "-after.png");
  writeFileSync(out + ".json", JSON.stringify({ errors, initial: nodes(snapshot), hover: nodes(hover), after: nodes(after), driven: { buttons: buttons.length, input: !!input } }));
} catch (error) {
  code = 1;
  writeFileSync(out + ".json", JSON.stringify({ crash: String((error as Error)?.stack ?? error), errors }));
}
app.close();
await app.closed;
process.exit(code);
`;

async function run(command: string[]) {
  // Every app here uses the CPU renderer: check each partial redraw against a full one.
  const child = Bun.spawn(command, { cwd: examples, stdout: "pipe", stderr: "pipe", env: { ...process.env, TARVE_CPU_DAMAGE_CHECK: "1" } });
  const timer = setTimeout(() => child.kill(), 60_000);
  const [code, stderr] = await Promise.all([child.exited, new Response(child.stderr).text()]);
  clearTimeout(timer);
  return { code, stderr: stderr.trim().split(/\r?\n/).filter(line => !/^\s+at /.test(line)).slice(0, 4).join(" | ") };
}
const report = (name: string) => existsSync(join(out, name + ".json")) ? JSON.parse(readFileSync(join(out, name + ".json"), "utf8")) : undefined;
async function pixelDiff(a: string, b: string): Promise<number> {
  const left = await readPngRgba(join(out, a)), right = await readPngRgba(join(out, b));
  if (left.width !== right.width || left.height !== right.height) return 100;
  let different = 0;
  for (let i = 0; i < left.rgba.length; i += 4) {
    if (Math.abs(left.rgba[i]! - right.rgba[i]!) + Math.abs(left.rgba[i + 1]! - right.rgba[i + 1]!) + Math.abs(left.rgba[i + 2]! - right.rgba[i + 2]!) > 24) different++;
  }
  return 100 * different / (left.width * left.height);
}
function nodeDiffs(a: unknown[][], b: unknown[][]): string[] {
  const reference = new Map(a.map(node => [node[0], JSON.stringify(node)]));
  const diffs = b.filter(node => reference.get(node[0]) !== JSON.stringify(node)).map(node => `${reference.get(node[0]) ?? "(new)"} -> ${JSON.stringify(node)}`);
  if (a.length !== b.length) diffs.push(`${a.length} nodes -> ${b.length}`);
  return diffs;
}

const failures: string[] = [];
try {
  for (const view of views) {
    writeFileSync(join(entries, view + ".tsx"), entry(view));
    const source = `_runtime-parity/${view}.tsx`;
    const bun = await run(["bun", source, join(out, view + "-bun")]);
    let reference = report(view + "-bun");
    if (!reference?.initial) { failures.push(`${view} bun: ${reference?.crash ?? bun.stderr}`); continue; }
    if (reference.errors.length) failures.push(`${view} bun reported errors: ${reference.errors.join("; ")}`);
    const compare = async (variant: string, got: NonNullable<ReturnType<typeof report>>): Promise<string[]> => {
      const problems: string[] = [];
      for (const stage of ["initial", "hover", "after"] as const) {
        const diffs = nodeDiffs(reference![stage], got[stage]);
        if (diffs.length) problems.push(`${stage}: ${diffs.length} nodes differ, e.g. ${diffs[0]}`);
        const pixels = await pixelDiff(`${view}-bun-${stage}.png`, `${view}-${variant}-${stage}.png`);
        if (pixels > 0) problems.push(`${stage}: ${pixels.toFixed(3)}% pixels differ`);
      }
      if (got.errors.length) problems.push(`errors: ${got.errors.join("; ")}`);
      return problems;
    };
    const line: string[] = [];
    const mismatched = new Map<string, string[]>();
    let compared = 0;
    for (const variant of variants) {
      const [runtime, compiled] = variant.split("-");
      const executable = join(out, `${view}-${variant}.exe`);
      const build = Bun.spawnSync(["bun", cli, "build", source, "--outfile", executable, "--runtime", runtime!, ...(compiled ? ["--compile-jsx"] : [])], { cwd: examples, stdout: "pipe", stderr: "pipe", env: { ...process.env, TARVE_NATIVE_FEATURES: process.env.TARVE_NATIVE_FEATURES ?? "all" } });
      if (build.exitCode !== 0) { failures.push(`${view} ${variant} build: ${(build.stderr.toString() + build.stdout.toString()).trim().split(/\r?\n/)[0]}`); line.push(`${variant}=BUILD`); continue; }
      // Animations finish in wall-clock time (the motion example reports which ended first):
      // a mismatch counts only when a second run reproduces it.
      let problems: string[] = [];
      let crashed = "";
      for (let attempt = 0; attempt < 2; attempt++) {
        const result = await run([executable, join(out, `${view}-${variant}`)]);
        const got = report(`${view}-${variant}`);
        if (!got?.initial) { crashed = got?.crash ?? result.stderr; break; }
        problems = await compare(variant, got);
        if (!problems.length) break;
      }
      if (crashed) { failures.push(`${view} ${variant}: ${crashed}`); line.push(`${variant}=CRASH`); continue; }
      compared++;
      if (problems.length) mismatched.set(variant, problems);
    }
    // Every variant agreeing with each other but not with Bun says the Bun run was the
    // odd one (a caret mid-blink at a capture): take a second Bun reference and compare
    // the captures the variants already made against it.
    if (compared > 1 && mismatched.size === compared) {
      await run(["bun", source, join(out, view + "-bun")]);
      const again = report(view + "-bun");
      if (again?.initial) {
        reference = again;
        for (const variant of [...mismatched.keys()]) {
          const problems = await compare(variant, report(`${view}-${variant}`)!);
          if (problems.length) mismatched.set(variant, problems); else mismatched.delete(variant);
        }
      }
    }
    for (const variant of variants) {
      if (line.some(entry => entry.startsWith(variant + "="))) continue;
      const problems = mismatched.get(variant);
      if (problems) failures.push(`${view} ${variant}: ${problems.join(" | ")}`);
      line.push(`${variant}=${problems ? "FAIL" : "ok"}`);
    }
    console.log(`${view.padEnd(14)} ${JSON.stringify(reference.driven)} ${line.join(" ")}`);
  }
} finally {
  rmSync(entries, { recursive: true, force: true });
}
if (failures.length) {
  console.error(failures.join("\n"));
  process.exit(1);
}
console.log(`runtime parity: ${views.length} examples x ${variants.length} variants match Bun`);
