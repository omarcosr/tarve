/**
 * Runs bench/render/memory.tsx (built per runtime as an app ships) and prints the private bytes
 * it holds after each stage:   bun bench/render/memory.ts      RUNTIMES=bun,node,txiki
 */
import { join, resolve } from "node:path";

const root = resolve(import.meta.dir, "../..");
const out = join(root, "work/render");
// One PowerShell for the whole run: a Get-Process per request in milliseconds, not a process start.
const probe = Bun.spawn(["powershell", "-NoProfile", "-Command", "$in=[Console]::In; while(($l=$in.ReadLine()) -ne $null){ $p=Get-Process -Id $l -EA 0; [Console]::Out.WriteLine($(if($p){$p.PrivateMemorySize64}else{'x'})); [Console]::Out.Flush() }"], { stdin: "pipe", stdout: "pipe" });
const probeReader = probe.stdout.getReader();
let probeBuffer = "";
async function privateMb(pid: number): Promise<number> {
  probe.stdin.write(pid + "\n");
  probe.stdin.flush();
  while (!probeBuffer.includes("\n")) probeBuffer += new TextDecoder().decode((await probeReader.read()).value);
  const index = probeBuffer.indexOf("\n");
  const line = probeBuffer.slice(0, index).trim();
  probeBuffer = probeBuffer.slice(index + 1);
  return Math.round(Number(line) / 104857.6) / 10;
}
for (const runtime of (process.env.RUNTIMES ?? "bun,node,txiki").split(",")) {
  const exe = join(out, `memory-${runtime}.exe`);
  const build = Bun.spawnSync(["bun", "run", "tarve", "build", "../bench/render/memory.tsx", "--runtime", runtime, "--outfile", exe], { cwd: join(root, "examples"), stdout: "pipe", stderr: "pipe" });
  if (build.exitCode !== 0) { console.error(runtime, build.stderr.toString().slice(-600)); continue; }
  const child = Bun.spawn([exe], { stdout: "pipe", stderr: "inherit", env: process.env });
  const stages: Record<string, number> = {};
  const decoder = new TextDecoder();
  let buffer = "";
  for await (const chunk of child.stdout) {
    buffer += decoder.decode(chunk);
    let index: number;
    while ((index = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, index).trim();
      buffer = buffer.slice(index + 1);
      const stage = /^@mark (\S+)/.exec(line)?.[1];
      if (!stage) continue;
      stages[stage] = await privateMb(child.pid);
    }
  }
  await child.exited;
  const base = stages.base ?? 0;
  console.log(runtime.padEnd(6), Object.entries(stages).map(([stage, mb]) => `${stage} +${(mb - base).toFixed(1)}`).join("  "), `(base ${base} MB)`);
}
probe.stdin.end();
