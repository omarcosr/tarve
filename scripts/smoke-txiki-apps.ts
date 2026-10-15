/**
 * Runs the full example apps (their real entry files, with live timers, processes and
 * network) under Bun and as txiki.js executables, and compares what each shows after
 * a few seconds. Live data (frame rates, CPU load, YouTube's recommendations) differs
 * between any two runs, so this fails only on what a runtime gap causes: a crash, a
 * build error, reported errors, error-looking text that Bun does not show, or a node
 * count off by more than 15% (YouTube's shelves alone vary by ~6% between requests).
 *
 *   bun run smoke:txiki-apps [example ...]      (needs network for youtube-music)
 */
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
const examples = join(import.meta.dir, "../examples");
const cli = join(examples, "node_modules/@tarve/core/dist/npm/cli.js");
const dir = join(examples, "_entry-parity");
const out = join(import.meta.dir, "../work/txiki-apps");
rmSync(dir, { recursive: true, force: true }); mkdirSync(dir, { recursive: true }); mkdirSync(out, { recursive: true });
const failures: string[] = [];
const names = process.argv.slice(2).length ? process.argv.slice(2) : ["counter", "diff", "fps", "html", "liquid", "performance", "player", "pulse", "tailwind", "text", "tray", "widget", "youtube-music"];
const wait = Number(process.env.WAIT ?? 9000);
const probe = `await (async () => {
  const __errors: string[] = [];
  app.onEvent((event: any) => { if (event.type === "error") __errors.push(event.message); });
  await app.ready;
  await new Promise(resolve => setTimeout(resolve, ${wait}));
  const snapshot = await app.inspect();
  const texts = snapshot.nodes.map((n: any) => n.text).filter((t: any) => typeof t === "string" && t.trim());
  (await import("node:fs")).writeFileSync(process.argv[process.argv.length - 1]!, JSON.stringify({ errors: __errors, nodes: snapshot.nodes.length, ids: snapshot.nodes.map((n: any) => n.id), texts }));
})();
app.close();
await app.closed;`;
for (const name of names) {
  let source = readFileSync(join(examples, name, name + ".tsx"), "utf8").replaceAll('from "./', `from "../${name}/`).replaceAll("from './", `from '../${name}/`);
  if (!source.includes("await app.closed;")) { console.log(name, "no await app.closed"); continue; }
  source = source.replace("await app.closed;", probe);
  writeFileSync(join(dir, name + ".tsx"), source);
  const runOne = async (cmd: string[]) => { const p = Bun.spawn(cmd, { cwd: examples, stdout: "pipe", stderr: "pipe" }); const t = setTimeout(() => p.kill(), wait + 30000); const [code, err] = await Promise.all([p.exited, new Response(p.stderr).text()]); clearTimeout(t); return { code, err: err.trim().split(/\r?\n/).filter(l => !/^\s+at /.test(l)).slice(0, 3).join(" | ").slice(0, 300) }; };
  const bun = await runOne(["bun", `_entry-parity/${name}.tsx`, join(out, name + "-bun.json")]);
  const exe = join(out, name + "-txiki.exe");
  const b = Bun.spawnSync(["bun", cli, "build", `_entry-parity/${name}.tsx`, "--outfile", exe, "--runtime", "txiki"], { cwd: examples, stdout: "pipe", stderr: "pipe" });
  if (b.exitCode !== 0) { failures.push(`${name}: txiki build failed: ${(b.stderr.toString() + b.stdout.toString()).trim().split("\n")[0]}`); continue; }
  const tx = await runOne([exe, join(out, name + "-txiki.json")]);
  const read = (k: string) => existsSync(join(out, name + "-" + k + ".json")) ? JSON.parse(readFileSync(join(out, name + "-" + k + ".json"), "utf8")) : null;
  const a = read("bun"), c = read("txiki");
  if (!a || !c) { failures.push(`${name}: no report (bun ${bun.code} ${bun.err}; txiki ${tx.code} ${tx.err})`); continue; }
  const bad = (t: string[]) => t.filter(x => /error|failed|HTTP \d{3}|not available|undefined|NaN|Invalid/i.test(x));
  const ta = new Set(a.texts), tc = new Set(c.texts);
  const onlyBun = a.texts.filter((t: string) => !tc.has(t)), onlyTx = c.texts.filter((t: string) => !ta.has(t));
  const ia = new Set(a.ids); const idDiff = c.ids.filter((i: string) => !ia.has(i)).length + a.ids.filter((i: string) => !new Set(c.ids).has(i)).length;
  const newBad = bad(c.texts).filter((t: string) => !ta.has(t));
  if (c.errors.length) failures.push(`${name}: txiki reported ${c.errors.join("; ")}`);
  if (newBad.length) failures.push(`${name}: txiki shows ${newBad.slice(0, 3).join(" | ")}`);
  if (Math.abs(a.nodes - c.nodes) > a.nodes * 0.15) failures.push(`${name}: ${a.nodes} nodes on Bun, ${c.nodes} on txiki`);
  console.log(name.padEnd(14), JSON.stringify({ nodes: [a.nodes, c.nodes], idDiff, errors: [a.errors, c.errors], badBun: bad(a.texts).slice(0, 3), badTx: bad(c.texts).slice(0, 3), onlyBun: onlyBun.slice(0, 4), onlyTx: onlyTx.slice(0, 4) }));
}
rmSync(dir, { recursive: true, force: true });
if (failures.length) { console.error(failures.join("\n")); process.exit(1); }
console.log(`txiki.js apps: ${names.length} examples behave as under Bun`);
