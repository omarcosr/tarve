// Keeps source files small enough to read whole: a tracked source file may not pass LIMIT
// lines. Files already past it are listed in scripts/lines-baseline.json and may only shrink;
// split them when touching them. `bun run check:lines --update` rewrites the baseline after a
// file shrank (or, deliberately, to accept growth).
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

const LIMIT = 600;
const root = resolve(import.meta.dir, "..");
const baselinePath = resolve(import.meta.dir, "lines-baseline.json");
const sources = /\.(ts|tsx|mts|rs|go|svelte|zig)$/;

const listed = Bun.spawnSync(["git", "ls-files", "-z", "--cached", "--others", "--exclude-standard"], { cwd: root });
if (listed.exitCode !== 0) throw new Error(`git ls-files failed: ${listed.stderr.toString()}`);
const counts = new Map<string, number>();
for (const path of listed.stdout.toString().split("\0")) {
  if (!sources.test(path) || path.endsWith(".d.ts") || /(^|\/)(vendor|node_modules)\//.test(path)) continue;
  let text: string;
  try { text = readFileSync(resolve(root, path), "utf8"); } catch { continue; }
  counts.set(path, text.split("\n").length - (text.endsWith("\n") ? 1 : 0));
}

const oversized = Object.fromEntries([...counts].filter(([, lines]) => lines > LIMIT).sort(([a], [b]) => a.localeCompare(b)));
if (process.argv.includes("--update")) {
  writeFileSync(baselinePath, JSON.stringify(oversized, null, 2) + "\n");
  console.log(`lines baseline: ${Object.keys(oversized).length} file(s) over ${LIMIT} lines recorded`);
  process.exit(0);
}

const baseline: Record<string, number> = JSON.parse(readFileSync(baselinePath, "utf8"));
const failures: string[] = [];
const shrunk: string[] = [];
for (const [path, lines] of Object.entries(oversized)) {
  const allowed = baseline[path];
  if (allowed === undefined) failures.push(`${path}: ${lines} lines (limit ${LIMIT}); split it`);
  else if (lines > allowed) failures.push(`${path}: grew to ${lines} lines (baseline ${allowed}); split it instead of growing it`);
  else if (lines < allowed) shrunk.push(path);
}
for (const path of Object.keys(baseline)) if (!(path in oversized)) shrunk.push(path);
if (shrunk.length) console.log(`lines: ${shrunk.length} file(s) shrank below their baseline; run \`bun run check:lines --update\` to lock it in`);
if (failures.length) {
  console.error(failures.join("\n"));
  process.exit(1);
}
console.log(`lines ok: no new file over ${LIMIT} lines, ${Object.keys(oversized).length} legacy file(s) not grown`);
