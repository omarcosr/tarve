// bun scripts/smoke-fatal-dialog.ts [--runtime bun|node|txiki] [--no-dialog]
// Builds an executable whose render() fails and checks that it exits with code 1, writes
// <config>/logs/crash-*.log and (Windows) shows the fatal dialog naming that log, which it closes.
import { strict as assert } from "node:assert";
import { parseArgs } from "node:util";
import { mkdir, mkdtemp, readdir, readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { build } from "../packages/core/build";
import { hostBuildTarget, targetConfig } from "../packages/core/targets";
import { buildNative } from "./native";

const root = resolve(import.meta.dir, "..");
const { values } = parseArgs({ args: process.argv.slice(2), options: { runtime: { type: "string" } } });
const runtime = (values.runtime ?? "bun") as "bun" | "node" | "txiki";
const target = hostBuildTarget();
if (!target) throw new Error(`Fatal dialog smoke is not supported for ${process.platform}-${process.arch}`);
await mkdir(join(root, "work"), { recursive: true });
const directory = await mkdtemp(join(root, "work/fatal smoke "));
const name = `Fatal smoke ${runtime}`;
const executable = join(directory, `FatalSmoke${targetConfig(target).executableSuffix}`);
await build({ entrypoint: join(root, "scripts/fatal-smoke-entry.tsx"), outfile: executable, nativeLibrary: await buildNative(true), name, runtime });

const config = join(directory, "config");
await mkdir(config);
const env: NodeJS.ProcessEnv = { ...process.env, APPDATA: config, XDG_CONFIG_HOME: config };
delete env.TARVE_NATIVE;
delete env.TARVE_DEBUG;
delete env.BUN_BE_BUN;
const child = Bun.spawn([executable], { cwd: directory, env, stdout: "pipe", stderr: "pipe" });
const kill = setTimeout(() => child.kill(), 60_000);
let dialog: { found: boolean; text?: string } = { found: false };
try {
  if (process.platform === "win32") dialog = await closeDialog(`${name} stopped because of an error`, child.pid);
  const code = await child.exited;
  const stderr = await new Response(child.stderr).text();
  assert.equal(code, 1, `the executable must exit with code 1 (stderr: ${stderr.trim()})`);
} finally {
  clearTimeout(kill);
}
const logs = join(config, name, "logs");
const files = await readdir(logs);
assert.equal(files.length, 1, "one crash log");
const log = await readFile(join(logs, files[0]!), "utf8");
assert.match(log, /fatal smoke: the view failed to render/);
assert.match(log, new RegExp(`app: ${name}`));
if (process.platform === "win32") {
  assert.ok(dialog.found, "the fatal dialog must open");
  assert.match(dialog.text ?? "", /fatal smoke: the view failed to render/);
  assert.ok((dialog.text ?? "").includes(join(logs, files[0]!)), `the dialog names the log (got ${dialog.text})`);
}
console.log(JSON.stringify({ result: "PASS", runtime, dialog, log: join(logs, files[0]!) }, null, 2));

/** Waits for the process's message box, reads its text and closes it (WM_CLOSE answers OK). */
async function closeDialog(title: string, pid: number): Promise<{ found: boolean; text?: string }> {
  const script = [
    `Add-Type -Name W -Namespace U -MemberDefinition '[DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern IntPtr FindWindow(string c, string t); [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int GetDlgItemText(IntPtr h, int id, System.Text.StringBuilder s, int n); [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint p); [DllImport("user32.dll")] public static extern bool PostMessage(IntPtr h, uint m, IntPtr w, IntPtr l);'`,
    `for ($i = 0; $i -lt 400; $i++) { $h = [U.W]::FindWindow('#32770', '${title.replaceAll("'", "''")}'); if ($h -ne [IntPtr]::Zero) { $p = 0; [void][U.W]::GetWindowThreadProcessId($h, [ref]$p); if ($p -eq ${pid}) { $s = New-Object System.Text.StringBuilder 4096; [void][U.W]::GetDlgItemText($h, 65535, $s, 4096); [void][U.W]::PostMessage($h, 0x10, [IntPtr]::Zero, [IntPtr]::Zero); @{ found = $true; text = $s.ToString() } | ConvertTo-Json -Compress; exit } }; Start-Sleep -Milliseconds 100 }`,
    `@{ found = $false } | ConvertTo-Json -Compress`,
  ].join("; ");
  const probe = Bun.spawn(["powershell", "-NoProfile", "-NonInteractive", "-Command", script], { stdout: "pipe", stderr: "pipe" });
  const out = (await new Response(probe.stdout).text()).trim();
  await probe.exited;
  return out ? JSON.parse(out) : { found: false };
}
