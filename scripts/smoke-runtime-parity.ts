/**
 * The same example app must behave the same on every runtime. Each example view renders
 * under Bun (the reference), then as a Node.js SEA and a txiki.js executable, plain and
 * with --compile-jsx, through the packaged CLI. Every run drives the same input: hover,
 * clicks, focusing an input, typing, Tab and a wheel scroll. The node tree (ids,
 * geometry, text) and the captures must match the Bun run exactly. Feature scenarios
 * (scripts/runtime-parity-scenarios.ts: router, deep links, device APIs, a native plugin,
 * the inspector) drive their feature instead and their `result` must match Bun's too.
 *
 *   bun run smoke:runtime-parity [example|scenario ...]     (RUNTIME_PARITY_VARIANTS=node,txiki,txiki-c)
 */
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { readPngRgba } from "../packages/core/src/index";
import { PROLOGUE, SCENARIOS, viewEntry, type Scenario } from "./runtime-parity-scenarios";

const root = resolve(import.meta.dir, "..");
const examples = join(root, "examples");
// The repository CLI, as examples run it (scripts/setup-examples.ts).
const cli = join(root, "packages/core/cli.ts");
const VIEWS = ["basic","components","diff","drag-and-drop","forms","glass","gradients","html","intrinsics","large-list","liquid","motion","performance","rich-content","tailwind","text"];
const views = process.argv.slice(2).length ? process.argv.slice(2) : [...VIEWS, ...Object.keys(SCENARIOS)];
const variants = (process.env.RUNTIME_PARITY_VARIANTS ?? "node,node-c,txiki,txiki-c,bun-c").split(",");
const out = join(root, "work/runtime-parity");
const scenarioOf = (view: string): Scenario => SCENARIOS[view] ?? { source: viewEntry(view) };
const entryDirectories = [...new Set(views.map(view => join(examples, scenarioOf(view).dir ?? "_runtime-parity")))];
for (const directory of entryDirectories) {
  rmSync(directory, { recursive: true, force: true });
  mkdirSync(directory, { recursive: true });
}
mkdirSync(out, { recursive: true });

/** Runs an app whose last argument is its report path (a stale report must not count). */
async function run(command: string[], env: Record<string, string> = {}) {
  rmSync(command.at(-1) + ".json", { force: true });
  // Every app here uses the CPU renderer: check each partial redraw against a full one.
  const child = Bun.spawn(command, { cwd: examples, stdout: "pipe", stderr: "pipe", env: { ...process.env, TARVE_CPU_DAMAGE_CHECK: "1", ...env } });
  const timer = setTimeout(() => child.kill(), 60_000);
  const [code, stderr] = await Promise.all([child.exited, new Response(child.stderr).text()]);
  clearTimeout(timer);
  return { code, stderr: stderr.trim().split(/\r?\n/).filter(line => !/^\s+at /.test(line)).slice(0, 4).join(" | ") };
}
/** A crashed run's report has only `crash` and `errors`. */
interface Report { errors: string[]; stages: Record<string, unknown[][]>; result: Record<string, unknown> | null; crash?: string }
const report = (name: string): Report | undefined => existsSync(join(out, name + ".json")) ? JSON.parse(readFileSync(join(out, name + ".json"), "utf8")) : undefined;
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

/** Per-runtime fields (`result.runtime`) are checked against the scenario, not against Bun. */
const comparable = (got: Report) => JSON.stringify({ ...got.result, runtime: undefined });

const failures: string[] = [];
const prepared = new Set<Scenario>();
try {
  for (const view of views) {
    const scenario = scenarioOf(view);
    if (scenario.prepare && !prepared.has(scenario)) { scenario.prepare(root); prepared.add(scenario); }
    const source = `${scenario.dir ?? "_runtime-parity"}/${view}.tsx`;
    writeFileSync(join(examples, source), PROLOGUE + scenario.source);
    const args = scenario.args ?? [];
    const env = scenario.env ?? {};
    const bun = await run(["bun", source, ...args, join(out, view + "-bun")], env);
    let reference = report(view + "-bun");
    if (!reference?.stages) { failures.push(`${view} bun: ${reference?.crash ?? bun.stderr}`); continue; }
    if (reference.errors.length) failures.push(`${view} bun reported errors: ${reference.errors.join("; ")}`);
    const runtimeProblems = (variant: string, got: Report): string[] => {
      if (!scenario.runtime) return [];
      const expected = JSON.stringify(scenario.runtime(variant)), actual = JSON.stringify(got.result?.runtime);
      return expected === actual ? [] : [`runtime: expected ${expected}, got ${actual}`];
    };
    const referenceProblems = runtimeProblems("bun", reference);
    if (referenceProblems.length) failures.push(`${view} bun: ${referenceProblems.join(" | ")}`);
    const compare = async (variant: string, got: Report): Promise<string[]> => {
      const problems: string[] = [];
      for (const stage of Object.keys(reference!.stages)) {
        if (!got.stages[stage]) { problems.push(`${stage}: missing`); continue; }
        const diffs = nodeDiffs(reference!.stages[stage]!, got.stages[stage]!);
        if (diffs.length) problems.push(`${stage}: ${diffs.length} nodes differ, e.g. ${diffs[0]}`);
        const pixels = await pixelDiff(`${view}-bun-${stage}.png`, `${view}-${variant}-${stage}.png`);
        if (pixels > 0) problems.push(`${stage}: ${pixels.toFixed(3)}% pixels differ`);
      }
      if (comparable(got) !== comparable(reference!)) problems.push(`result: ${comparable(got)} (Bun: ${comparable(reference!)})`);
      problems.push(...runtimeProblems(variant, got));
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
        const result = await run([executable, ...args, join(out, `${view}-${variant}`)], env);
        const got = report(`${view}-${variant}`);
        if (!got?.stages) { crashed = got?.crash ?? result.stderr; break; }
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
      await run(["bun", source, ...args, join(out, view + "-bun")], env);
      const again = report(view + "-bun");
      if (again?.stages) {
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
    console.log(`${view.padEnd(14)} ${JSON.stringify(reference.result)} ${line.join(" ")}`);
  }
} finally {
  for (const directory of entryDirectories) rmSync(directory, { recursive: true, force: true });
}
if (failures.length) {
  console.error(failures.join("\n"));
  process.exit(1);
}
console.log(`runtime parity: ${views.length} examples x ${variants.length} variants match Bun`);
