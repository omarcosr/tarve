// Plays the same clips, looped and muted, in a tarve window and in Chrome, and
// measures each app from outside over the same window of time: CPU (every process
// of the app), private and working-set memory, I/O read, GPU engine utilisation
// and GPU memory (empty when the GPU performance counters are unavailable).
// Both sides are whole apps (Chrome: a fresh profile with one --app window; tarve:
// the Bun process). The `empty` scenario is each app with nothing playing, and
// the `Δ` columns subtract it: what the video itself costs. Windows only; needs ffmpeg.
// bun scripts/bench-video-chrome.ts [--seconds 6] [--only tarve|chrome] [--scenarios empty,1080p60,...]
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const work = join(import.meta.dirname, "..", "work", "bench-video");
mkdirSync(work, { recursive: true });
const arg = (name: string) => { const i = process.argv.indexOf(name); return i >= 0 ? process.argv[i + 1] : undefined; };
const seconds = Number(arg("--seconds") ?? 6);
const only = arg("--only");

/** A looped H.264/AAC clip, made once. */
function clip(width: number, height: number, rate: number) {
  const path = join(work, `${height}p${rate}-av.mp4`);
  if (!existsSync(path)) {
    const made = spawnSync("ffmpeg", ["-y", "-loglevel", "error", "-f", "lavfi", "-i", `testsrc2=size=${width}x${height}:rate=${rate}:duration=20`,
      "-f", "lavfi", "-i", "sine=frequency=440:duration=20", "-c:v", "libx264", "-preset", "veryfast", "-pix_fmt", "yuv420p",
      "-c:a", "aac", "-shortest", path], { stdio: "inherit" });
    if (made.status !== 0) throw new Error("ffmpeg could not make the clip");
  }
  return path;
}

interface Scenario { videos: { src: string; width: string; height: string }[]; paused?: boolean; stacked?: boolean; sound?: boolean; warmup?: number }
const full = { width: "100%", height: "100%" };
const scenarios: Record<string, () => Scenario> = {
  empty: () => ({ videos: [] }),
  "720p30": () => ({ videos: [{ src: clip(1280, 720, 30), ...full }] }),
  "1080p60": () => ({ videos: [{ src: clip(1920, 1080, 60), ...full }] }),
  // Not muted (the audio output is silent in tarve with TARVE_AUDIO=silent, real in Chrome).
  "1080p60-sound": () => ({ videos: [{ src: clip(1920, 1080, 60), ...full }], sound: true }),
  // Measured after 18 s: past the 15 s after which a paused video lets go of its decoder.
  "1080p60-paused": () => ({ videos: [{ src: clip(1920, 1080, 60), ...full }], paused: true, warmup: 18_000 }),
  "1080p60-small": () => ({ videos: [{ src: clip(1920, 1080, 60), width: "320px", height: "180px" }] }),
  "2160p60": () => ({ videos: [{ src: clip(3840, 2160, 60), ...full }] }),
  "4x720p30": () => ({ videos: [0, 1, 2, 3].map(() => ({ src: clip(1280, 720, 30), width: "50%", height: "50%" })) }),
  // One above the other, 40 px apart: two show, two play below the window's edge.
  "4x720p30-offscreen": () => ({ videos: [0, 1, 2, 3].map(() => ({ src: clip(1280, 720, 30), width: "640px", height: "360px" })), stacked: true }),
};
const chosen = (arg("--scenarios") ?? "empty,720p30,1080p60,1080p60-sound,1080p60-paused,1080p60-small,4x720p30,4x720p30-offscreen").split(",");

const sampler = `param([string]$match, [int]$seconds)
function procs { @(Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -and $_.CommandLine.Contains($match) -and $_.Name -ne 'powershell.exe' }) }
function cpu($list) { ($list | Measure-Object -Property KernelModeTime -Sum).Sum + ($list | Measure-Object -Property UserModeTime -Sum).Sum }
function io($list) { ($list | Measure-Object -Property ReadTransferCount -Sum).Sum }
$before = procs; $ids = $before | ForEach-Object { [int]$_.ProcessId }
$cpu0 = cpu $before; $io0 = io $before; $t0 = Get-Date
$d3 = @(); $dec = @(); $ded = @(); $sh = @(); $gpu = $true
for ($i = 0; $i -lt $seconds; $i++) {
  Start-Sleep -Milliseconds 1000
  if (-not $gpu) { continue }
  try { $null = Get-CimInstance Win32_PerfFormattedData_GPUPerformanceCounters_GPUEngine -ErrorAction Stop } catch { $gpu = $false; continue }
  $eng = Get-CimInstance Win32_PerfFormattedData_GPUPerformanceCounters_GPUEngine | Where-Object { $n = $_.Name; $ids | Where-Object { $n -like "pid_$($_)_*" } }
  $d3 += (($eng | Where-Object { $_.Name -like '*engtype_3D' } | Measure-Object -Property UtilizationPercentage -Sum).Sum)
  $dec += (($eng | Where-Object { $_.Name -like '*engtype_VideoDecode' } | Measure-Object -Property UtilizationPercentage -Sum).Sum)
  $mem = Get-CimInstance Win32_PerfFormattedData_GPUPerformanceCounters_GPUProcessMemory | Where-Object { $n = $_.Name; $ids | Where-Object { $n -like "pid_$($_)_*" } }
  $ded += (($mem | Measure-Object -Property DedicatedUsage -Sum).Sum)
  $sh += (($mem | Measure-Object -Property SharedUsage -Sum).Sum)
}
$after = @(Get-CimInstance Win32_Process | Where-Object { $ids -contains [int]$_.ProcessId })
$wall = ((Get-Date) - $t0).TotalSeconds
$avg = { param($a) if ($gpu -and $a.Count) { ($a | Measure-Object -Average).Average } else { $null } }
$round = { param($v, $d) if ($null -eq $v) { $null } else { [math]::Round($v / $d, 1) } }
[pscustomobject]@{
  processes = $after.Count
  cpuPercentOfOneCore = [math]::Round(((cpu $after) - $cpu0) / 1e5 / $wall, 1)
  privateMb = [math]::Round((($after | Measure-Object -Property PrivatePageCount -Sum).Sum) / 1MB, 1)
  workingSetMb = [math]::Round((($after | Measure-Object -Property WorkingSetSize -Sum).Sum) / 1MB, 1)
  ioReadMbPerSecond = [math]::Round(((io $after) - $io0) / 1MB / $wall, 2)
  gpu3dPercent = & $round (& $avg $d3) 1
  gpuVideoDecodePercent = & $round (& $avg $dec) 1
  gpuDedicatedMb = & $round (& $avg $ded) 1MB
  gpuSharedMb = & $round (& $avg $sh) 1MB
} | ConvertTo-Json -Compress
`;
const samplerPath = join(work, "sample.ps1");
writeFileSync(samplerPath, sampler);

function chromePath() {
  for (const path of [process.env.CHROME, join(process.env.ProgramFiles ?? "", "Google/Chrome/Application/chrome.exe"),
    join(process.env["ProgramFiles(x86)"] ?? "", "Google/Chrome/Application/chrome.exe"), join(process.env.LOCALAPPDATA ?? "", "Google/Chrome/Application/chrome.exe")]) {
    if (path && existsSync(path)) return path;
  }
  throw new Error("Chrome not found (set CHROME)");
}

const px = (value: string) => value.endsWith("%") ? `${value.slice(0, -1)}%` : Number.parseFloat(value);

function tarveSubject(name: string, scenario: Scenario) {
  const path = join(work, `subject-${name}.tsx`);
  const tag = (video: Scenario["videos"][number], i: number) => `<video id="v${i}" src={${JSON.stringify(video.src)}} ${scenario.paused ? "" : "autoPlay "}${scenario.sound ? "" : "muted "}loop style={{ width: ${JSON.stringify(px(video.width))}, height: ${JSON.stringify(px(video.height))}${scenario.stacked ? `, position: "absolute", left: 0, top: ${i * (Number.parseFloat(video.height) + 40)}` : ""} }} />`;
  // A 2×2 grid as two rows, as the page's flex wrap lays it out.
  const grid = scenario.videos.length > 1 && !scenario.stacked;
  const body = grid
    ? [0, 2].map(start => `<row style={{ width: "100%", height: "50%" }}>${scenario.videos.slice(start, start + 2).map((video, i) => tag({ ...video, height: "100%" }, start + i)).join("")}</row>`).join("\n    ")
    : scenario.videos.map(tag).join("\n    ");
  writeFileSync(path, `import { createApp, Window } from "@tarve/core";
const app = createApp(() => (
  <Window title="bench video" width={1280} height={720} style={{ background: "#000000" }}>
    ${body}
  </Window>
));
await app.ready;
await app.closed;
`);
  return path;
}

function chromePage(name: string, scenario: Scenario) {
  const path = join(work, `page-${name}.html`);
  const videos = scenario.videos.map(video => `<video src="${pathToFileURL(video.src)}" ${scenario.paused ? "preload=auto" : "autoplay"} ${scenario.sound ? "" : "muted"} loop style="width:${video.width};height:${video.height};flex-shrink:0;display:block;object-fit:contain"></video>`).join("");
  writeFileSync(path, `<!doctype html><body style="margin:0;background:#000;width:100vw;height:100vh;display:flex;flex-wrap:${scenario.stacked ? "nowrap;flex-direction:column;overflow:hidden;gap:40px" : "wrap"}">${videos}</body>`);
  return path;
}

async function measure(command: string, args: string[], match: string, warmup = 4000) {
  const child = spawn(command, args, { stdio: "ignore" });
  await new Promise(resolve => setTimeout(resolve, warmup));
  const run = spawnSync("powershell", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", samplerPath, match, String(seconds)], { encoding: "utf8" });
  spawnSync("taskkill", ["/T", "/F", "/PID", String(child.pid)], { stdio: "ignore" });
  const line = run.stdout.trim().split(/\r?\n/).pop() ?? "";
  if (!line.startsWith("{")) throw new Error(`sampler failed: ${run.stderr || run.stdout}`);
  return JSON.parse(line) as Record<string, number | null>;
}

const rows: Record<string, unknown>[] = [];
const empty: Record<string, Record<string, number | null>> = {};
for (const name of ["empty", ...chosen.filter(name => name !== "empty")]) {
  const make = scenarios[name];
  if (!make) throw new Error(`unknown scenario ${name} (${Object.keys(scenarios).join(", ")})`);
  const scenario = make();
  for (const app of ["tarve", "chrome"]) {
    if (only && only !== app) continue;
    let result;
    if (app === "tarve") {
      const subject = tarveSubject(name, scenario);
      result = await measure(process.execPath, [subject], subject, scenario.warmup);
    } else {
      const profile = join(work, "chrome-profile");
      rmSync(profile, { recursive: true, force: true });
      result = await measure(chromePath(), [`--user-data-dir=${profile}`, "--no-first-run", "--no-default-browser-check",
        "--autoplay-policy=no-user-gesture-required", "--window-size=1280,720", `--app=${pathToFileURL(chromePage(name, scenario))}`], profile, scenario.warmup);
    }
    if (name === "empty") empty[app] = result;
    const base = empty[app];
    const delta = (key: string) => base && name !== "empty" ? Math.round(((result[key] ?? 0) - (base[key] ?? 0)) * 10) / 10 : null;
    rows.push({ scenario: name, app, procs: result.processes, cpu: result.cpuPercentOfOneCore, "Δcpu": delta("cpuPercentOfOneCore"),
      privateMb: result.privateMb, "ΔprivateMb": delta("privateMb"), wsMb: result.workingSetMb, "ΔwsMb": delta("workingSetMb"),
      ioMBs: result.ioReadMbPerSecond, gpu3d: result.gpu3dPercent, gpuDecode: result.gpuVideoDecodePercent });
    if (chosen.includes(name) || name !== "empty") console.log(JSON.stringify(rows.at(-1)));
  }
}
console.table(rows);
