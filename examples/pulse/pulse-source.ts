// System data for the Pulse example. Windows: pulse-sampler.cs, compiled once
// into a small helper with the .NET Framework compiler every Windows has
// (PowerShell's Add-Type where it is missing), prints a JSON line a second with what a user (not
// admin) program can read: processes and threads (ntdll), memory lists, disk
// and network totals, GPU engines, thermal zones and RAPL energy (PDH by English
// counter names), the battery (WMI) and NVIDIA's own figures. Rates, load
// averages and per-app power are derived here. Elsewhere only node:os. Not
// part of Tarve.
import { existsSync, mkdirSync, readdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import os, { tmpdir } from "node:os";
import { join } from "node:path";
import samplerSource from "./pulse-sampler.cs" with { type: "file" };

export interface Proc {
  pid: number;
  parent: number;
  name: string;
  path: string | null;
  threads: number;
  /** Share of all cores, 0–1. */
  cpu: number;
  /** Busiest GPU engine this process keeps, 0–1. */
  gpu: number;
  memory: number;
  /** Seconds of CPU time so far. */
  cpuTime: number;
  /** Bytes per second read and written. */
  read: number;
  write: number;
  /** Watts: the package's power split by CPU share, plus the GPU's split by GPU share. */
  power: number;
  /** Established TCP connections. */
  connections: number;
}
/** One graphics adapter, as Task Manager's GPU page shows it. */
export interface Gpu {
  name: string;
  /** Busiest engine, summed over processes, 0–1. */
  util: number;
  /** Per engine type (3D, Copy, Video Decode, …): its busiest engine, 0–1. */
  engines: { name: string; util: number }[];
  /** Bytes in use and available, dedicated (on the card) and shared (system RAM). */
  dedicated: number; dedicatedTotal: number; shared: number; sharedTotal: number;
  temperature: number | null;
  power: number | null;
}
/** One physical disk, as Task Manager's Disk page shows it. */
export interface Disk {
  index: number;
  /** "Disk 0 (C:)" */
  name: string;
  model: string;
  /** "SSD (NVMe)", "HDD", … */
  kind: string;
  /** Share of the second the disk was busy, 0–1. */
  active: number;
  /** Bytes per second. */
  read: number; write: number;
  /** Average milliseconds per request. */
  response: number;
  size: number;
}
/** One connected network adapter. Virtual ones (VPN tunnels, WSL/Hyper-V switches) are left out of totals. */
export interface Adapter {
  name: string; description: string; wireless: boolean; virtual: boolean;
  /** Bytes per second. */
  down: number; up: number;
  /** Link speed, bits per second. */
  speed: number;
  /** Bytes received and sent since the adapter came up. */
  received: number; sent: number;
  ipv4: string[]; ipv6: string[];
  /** Hardware (MAC) address, "" where it has none. */
  mac: string;
}
export interface Sample {
  /** Utilization as Task Manager counts it; `speed` in GHz. */
  cpu: { user: number; system: number; cores: number[]; speed: number | null; baseSpeed: number | null; temperature: number | null; power: number | null; load: [number, number, number]; runnable: number };
  /** Bytes. app + wired + compressed + cached + free = total. */
  memory: { total: number; used: number; available: number; app: number; wired: number; compressed: number; cached: number; free: number; commit: number; commitLimit: number; paged: number; nonpaged: number; handles: number; threads: number };
  /** The adapter with the most dedicated memory; every adapter in `gpus`. */
  gpu: (Gpu & { memory: number }) | null;
  gpus: Gpu[];
  disk: { read: number; write: number; free: number; total: number; readTotal: number; written: number; disks: Disk[] };
  net: { down: number; up: number; received: number; sent: number; adapters: Adapter[] };
  battery: { percent: number; charging: boolean; plugged: boolean; health: number | null; cycles: number | null; designCapacity: number | null; fullCapacity: number | null; draw: number | null } | null;
  /** Watts measured: CPU package (RAPL) and GPU board; null where the hardware does not say. */
  power: { cpu: number | null; gpu: number | null; system: number | null };
  temperatures: { name: string; celsius: number }[];
  procs: Proc[];
  /** The first sample, shown at once while rates (which need two readings) are still zero; the next one replaces it. */
  warmup?: boolean;
}

type RawDisk = { index: number; model: string | null; bus: number; ssd: boolean | null; size: number; letters: string; read: number; written: number; readTime: number; writeTime: number; idle: number; reads: number; writes: number; query: number };
type RawNic = { name: string; description: string; wireless: boolean; virtual: boolean; speed: number; received: number; sent: number; ipv4?: string[]; ipv6?: string[]; mac?: string };
type Raw = {
  procs: [number, number, string, string | null, number, number, number, number, number][];
  runnable: number;
  /** Established TCP connections per process id. */
  connections?: [number, number][];
  memory: { total: number; available: number; zero: number; free: number; modified: number; standby: number; nonpaged: number; paged: number; compressed: number; commit: number; commitLimit: number; handles: number; threads: number };
  disk: { free: number; total: number; disks: RawDisk[] };
  net: RawNic[];
  at: number;
  cpuUtility: [string, number][];
  cpuPrivileged: [string, number][];
  cpuTime: [string, number][];
  cpuPerf: [string, number][];
  cpuBase: [string, number][];
  gpus: { name: string; luid: string; vendor: number; dedicated: number; shared: number }[];
  gpuEngines: [string, number][];
  gpuDedicated: [string, number][];
  gpuShared: [string, number][];
  thermal: [string, number][];
  energy: [string, number][];
  battery: { full: number; remaining: number; rate: number; cycles: number; online: boolean; charging: boolean; discharging: boolean } | null;
  nvidia: { temp: number | null; power: number | null; util: number | null; memory: number | null } | null;
};

const BUS: Record<number, string> = { 1: "SCSI", 3: "ATA", 7: "USB", 8: "RAID", 10: "SAS", 11: "SATA", 12: "SD", 13: "MMC", 15: "Virtual", 17: "NVMe", 18: "SCM", 19: "UFS" };
const ENGINE_ORDER = ["3D", "Copy", "VideoDecode", "VideoEncode", "Compute"];
const engineLabel = (type: string) => type.replace(/_\d+$/, "").replace(/([a-z])([A-Z])/g, "$1 $2").replace(/_/g, " ");

const cpuTimes = () => os.cpus().map(c => c.times);

/**
 * The helper to run: pulse-sampler.cs compiled by csc.exe from the .NET
 * Framework into the temp folder once per version of the source (a windowless
 * program: no console host beside it, a third of a PowerShell host's memory), or PowerShell compiling it
 * on each start where that compiler is missing.
 */
async function helperCommand(): Promise<string[]> {
  const source = readFileSync(samplerSource, "utf8");
  const file = join(tmpdir(), "tarve-pulse-" + Bun.hash(source).toString(36));
  if (existsSync(file + ".exe")) return [file + ".exe"];
  // Earlier versions' helpers: removed where no other instance still runs them.
  for (const old of readdirSync(tmpdir()).filter(f => f.startsWith("tarve-pulse-") && /\.(exe|cs|exe\.config)$/.test(f))) {
    try { unlinkSync(join(tmpdir(), old)); } catch { }
  }
  writeFileSync(file + ".cs", source);
  const csc = join(process.env.WINDIR ?? "C:\\Windows", "Microsoft.NET", "Framework64", "v4.0.30319", "csc.exe");
  if (existsSync(csc)) {
    const build = Bun.spawn([csc, "/nologo", "/optimize+", "/target:winexe", "/r:System.Management.dll", "/r:System.Drawing.dll", "/out:" + file + ".exe", file + ".cs"],
      { stdout: "ignore", stderr: "ignore", windowsHide: true } as never);
    if (await build.exited === 0 && existsSync(file + ".exe")) {
      // One GC thread is plenty for a sample a second.
      writeFileSync(file + ".exe.config", '<?xml version="1.0"?><configuration><runtime><gcConcurrent enabled="false"/></runtime></configuration>');
      return [file + ".exe"];
    }
  }
  return ["powershell", "-NoProfile", "-NonInteractive", "-Command",
    "Add-Type -Path '" + file + ".cs' -ReferencedAssemblies System.Management,System.Drawing; [PulseMain]::Main(@())"];
}

/** The battery's design capacity (mWh), which only the battery report states. */
async function designCapacity(): Promise<number | null> {
  try {
    const file = join(tmpdir(), "tarve-pulse-battery.xml");
    await Bun.spawn(["powercfg", "/batteryreport", "/xml", "/output", file], { stdout: "ignore", stderr: "ignore", windowsHide: true } as never).exited;
    const value = /<DesignCapacity>(\d+)</.exec(await readFile(file, "utf8"))?.[1];
    return value ? Number(value) : null;
  } catch { return null; }
}

/**
 * Which CPU figure to report. Task Manager on Windows 11 24H2 and later counts
 * time busy (the industry-standard figure); earlier versions counted utility,
 * work done relative to the base clock, which reads higher under turbo.
 */
export type CpuBasis = "time" | "utility";
const build = Number(os.release().split(".")[2] ?? 0);
let basis: CpuBasis = process.platform === "win32" && build > 0 && build < 26100 ? "utility" : "time";
export const cpuBasis = () => basis;
export function setCpuBasis(next: CpuBasis): void { basis = next; }

/** Calls `onSample` about once a second until the returned function is called. */
export function watch(onSample: (sample: Sample) => void): () => void {
  let previous = cpuTimes();
  // Busy time from the OS, per core: the figure where no utility counter exists.
  const cpu = () => {
    const now = cpuTimes();
    let user = 0, system = 0, total = 0;
    const cores = now.map((t, i) => {
      const p = previous[i] ?? t;
      const u = t.user + t.nice - p.user - p.nice, s = t.sys + t.irq - p.sys - p.irq;
      const all = u + s + t.idle - p.idle;
      user += u; system += s; total += all;
      return all > 0 ? (u + s) / all : 0;
    });
    previous = now;
    return { user: total ? user / total : 0, system: total ? system / total : 0, cores };
  };

  if (process.platform !== "win32") {
    const timer = setInterval(() => {
      const total = os.totalmem(), free = os.freemem();
      onSample({
        cpu: { ...cpu(), speed: null, baseSpeed: null, temperature: null, power: null, load: os.loadavg() as [number, number, number], runnable: 0 },
        memory: { total, used: total - free, available: free, app: total - free, wired: 0, compressed: 0, cached: 0, free, commit: 0, commitLimit: 0, paged: 0, nonpaged: 0, handles: 0, threads: 0 }, gpu: null, gpus: [],
        disk: { read: 0, write: 0, free: 0, total: 0, readTotal: 0, written: 0, disks: [] }, net: { down: 0, up: 0, received: 0, sent: 0, adapters: [] }, battery: null,
        power: { cpu: null, gpu: null, system: null }, temperatures: [], procs: [],
      });
    }, 1000);
    return () => clearInterval(timer);
  }

  let stopped = false;
  let child: { kill(): void } | null = null;
  const info: { designCapacity: number | null } = { designCapacity: null };
  void designCapacity().then(v => { info.designCapacity = v; });
  let last: { at: number; clock: number; procs: Map<number, { cpu: number; read: number; write: number }>; disks: Map<number, RawDisk>; nics: Map<string, RawNic> } | null = null;
  let received = 0, sent = 0;
  const load: [number, number, number] = [0, 0, 0];
  let loadStarted = false;
  const floors: { at: number; cpu: number; gpu: number }[] = [];

  void (async () => {
    const command = await helperCommand();
    if (stopped) return;
    const proc = Bun.spawn(command, { stdin: "pipe", stdout: "pipe", stderr: "ignore", windowsHide: true } as never);
    child = proc;
    const stdin = proc.stdin as unknown as { write(data: string): void; flush?(): void };
    connectIcons(line => { stdin.write(line + "\n"); stdin.flush?.(); });
    for await (const line of lines(proc.stdout as unknown as AsyncIterable<Uint8Array>)) {
      if (!line || stopped) continue;
      if (line.startsWith("icon|")) { iconAnswer(line.slice(5)); continue; }
      let raw: Raw;
      try { raw = JSON.parse(line); } catch { continue; }
      const now = performance.now(), dt = last ? Math.max(0.2, raw.at - last.clock) : 1;
      const cores = os.cpus().length;

      // GPU, per adapter as Task Manager shows it: each engine summed over
      // processes; the adapter's figure is its busiest engine, each engine
      // type's the busiest engine of that type.
      const engines = new Map<string, number>(), byPid = new Map<number, number>();
      for (const [name, value] of raw.gpuEngines) {
        const engine = name.replace(/^pid_\d+_/, "");
        engines.set(engine, (engines.get(engine) ?? 0) + value);
        const pid = Number(/pid_(\d+)/.exec(name)?.[1] ?? -1);
        byPid.set(pid, Math.max(byPid.get(pid) ?? 0, value));
      }
      const usedOn = (list: [string, number][], luid: string) => list.reduce((a, [name, v]) => name.startsWith(luid) ? a + v : a, 0);
      const gpus: Gpu[] = raw.gpus.map(g => {
        const types = new Map<string, number>();
        for (const [engine, value] of engines) {
          if (!engine.startsWith(g.luid)) continue;
          const type = /engtype_(.*)$/.exec(engine)?.[1] ?? "";
          if (type) types.set(type, Math.max(types.get(type) ?? 0, value));
        }
        const rank = (t: string) => { const i = ENGINE_ORDER.indexOf(t); return i < 0 ? ENGINE_ORDER.length : i; };
        const nvidia = g.vendor === 0x10de ? raw.nvidia : null;
        return {
          name: g.name, util: Math.min(1, Math.max(0, ...types.values()) / 100),
          engines: [...types].sort((a, b) => rank(a[0]) - rank(b[0]) || b[1] - a[1]).slice(0, 4).map(([t, v]) => ({ name: engineLabel(t), util: Math.min(1, v / 100) })),
          dedicated: usedOn(raw.gpuDedicated, g.luid), dedicatedTotal: g.dedicated, shared: usedOn(raw.gpuShared, g.luid), sharedTotal: g.shared,
          temperature: nvidia?.temp ?? null, power: nvidia?.power ?? null,
        };
      });
      const primary = gpus.reduce<Gpu | null>((best, g) => !best || g.dedicatedTotal > best.dedicatedTotal ? g : best, null);
      const perf = raw.cpuPerf.find(([n]) => n === "_Total")?.[1], base = raw.cpuBase.find(([n]) => n === "_Total")?.[1];
      // CPU as Task Manager counts it, all from one PDH sample, total and per
      // logical processor: time busy (% Processor Time, Task Manager since
      // Windows 11 24H2) or utilization (% Processor Utility, work at the
      // actual clock, earlier Task Managers). System is the kernel's share.
      const total = (list: [string, number][]) => list.find(([n]) => n === "_Total")?.[1];
      const counter = basis === "time" ? raw.cpuTime : raw.cpuUtility;
      const overall = total(counter), privileged = total(raw.cpuPrivileged), timeAll = total(raw.cpuTime);
      const fallback = overall === undefined ? cpu() : null;
      if (!fallback) previous = cpuTimes();
      const busy = fallback ? fallback.user + fallback.system : Math.min(1, overall! / 100);
      const kernel = fallback ? fallback.system : timeAll ? busy * Math.min(1, (privileged ?? 0) / timeAll) : 0;
      const perCore = counter.filter(([n]) => /^\d+,\d+$/.test(n)).map(([n, v]) => { const [g, k] = n.split(",").map(Number); return { at: g! * 64 + k!, v }; })
        .sort((a, b) => a.at - b.at).map(x => Math.min(1, x.v / 100));
      const usage = { user: busy - kernel, system: kernel, cores: fallback?.cores ?? perCore };
      const energy = new Map(raw.energy.map(([k, v]) => [k, v / 1000]));
      const cpuPower = energy.get("RAPL_Package0_PKG") ?? null;
      const gpuPower = primary?.power ?? raw.nvidia?.power ?? null;

      const seen = new Map<number, { cpu: number; read: number; write: number }>();
      const connections = new Map(raw.connections ?? []);
      const procs: Proc[] = raw.procs.map(([pid, parent, name, path, threads, cpuTime, memory, read, write]) => {
        seen.set(pid, { cpu: cpuTime, read, write });
        const before = last?.procs.get(pid);
        return {
          pid, parent, name, path, threads, memory, cpuTime,
          cpu: before ? Math.max(0, (cpuTime - before.cpu) / dt / cores) : 0,
          gpu: (byPid.get(pid) ?? 0) / 100,
          read: before ? Math.max(0, read - before.read) / dt : 0,
          write: before ? Math.max(0, write - before.write) / dt : 0,
          power: 0,
          connections: connections.get(pid) ?? 0,
        };
      });
      // Processes share the total exactly, as on Task Manager's Processes tab:
      // their CPU time, scaled from time busy to utilization.
      const timeBusy = procs.reduce((a, p) => a + p.cpu, 0);
      if (timeBusy > 0) for (const p of procs) p.cpu = Math.min(1, p.cpu * busy / timeBusy);
      // Per-app power: what the package and the GPU draw above their idle floor
      // (the lowest seen in the last ten minutes), split by each app's share of
      // CPU and of GPU time. The idle floor belongs to no app.
      floors.push({ at: now, cpu: cpuPower ?? 0, gpu: gpuPower ?? 0 });
      while (floors.length && now - floors[0]!.at > 600_000) floors.shift();
      const cpuActive = cpuPower === null ? 0 : Math.max(0, cpuPower - Math.min(...floors.map(f => f.cpu)));
      const gpuActive = gpuPower === null ? 0 : Math.max(0, gpuPower - Math.min(...floors.map(f => f.gpu)));
      const cpuSum = procs.reduce((a, p) => a + p.cpu, 0), gpuSum = procs.reduce((a, p) => a + p.gpu, 0);
      for (const p of procs) {
        p.power = (cpuSum > 0 ? cpuActive * p.cpu / cpuSum : 0) + (gpuSum > 0 ? gpuActive * p.gpu / gpuSum : 0);
      }

      // Unix-style load averages: runnable threads, damped over 1, 5 and 15 minutes.
      const runnable = Math.max(0, raw.runnable - 1);
      if (!loadStarted) { load.fill(runnable); loadStarted = true; }
      [60, 300, 900].forEach((window, i) => { const k = Math.exp(-dt / window); load[i] = load[i]! * k + runnable * (1 - k); });

      // Disks: busy share from idle time, speeds, and time per request.
      const disks: Disk[] = raw.disk.disks.map(d => {
        const p = last?.disks.get(d.index);
        const span = p ? d.query - p.query : 0, requests = p ? d.reads + d.writes - p.reads - p.writes : 0;
        return {
          index: d.index, name: "Disk " + d.index + (d.letters ? " (" + d.letters + ")" : ""), model: d.model ?? "Disk",
          kind: (d.ssd === null ? "" : d.ssd ? "SSD" : "HDD") + (BUS[d.bus] ? (d.ssd === null ? BUS[d.bus] : " (" + BUS[d.bus] + ")") : ""),
          active: span > 0 ? Math.min(1, Math.max(0, 1 - (d.idle - p!.idle) / span)) : 0,
          read: p ? Math.max(0, d.read - p.read) / dt : 0, write: p ? Math.max(0, d.written - p.written) / dt : 0,
          response: requests > 0 ? Math.max(0, d.readTime + d.writeTime - p!.readTime - p!.writeTime) / requests / 1e4 : 0, size: d.size,
        };
      });
      const adapters: Adapter[] = raw.net.map(n => {
        const p = last?.nics.get(n.name);
        return { name: n.name, description: n.description, wireless: n.wireless, virtual: n.virtual, speed: n.speed, received: n.received, sent: n.sent,
          ipv4: n.ipv4 ?? [], ipv6: (n.ipv6 ?? []).map(a => a.replace(/%\d+$/, "")), mac: n.mac ?? "",
          down: p ? Math.max(0, n.received - p.received) / dt : 0, up: p ? Math.max(0, n.sent - p.sent) / dt : 0 };
      });
      const physical = adapters.filter(a => !a.virtual);
      const down = physical.reduce((a, n) => a + n.down, 0), up = physical.reduce((a, n) => a + n.up, 0);
      // Totals since each adapter came up, as its own counters keep them.
      received = physical.reduce((t, n) => t + n.received, 0); sent = physical.reduce((t, n) => t + n.sent, 0);
      const diskRead = disks.reduce((a, d) => a + d.read, 0), diskWrite = disks.reduce((a, d) => a + d.write, 0);
      const m = raw.memory;
      const free = m.zero + m.free, cached = m.standby + m.modified, wired = m.nonpaged, compressed = m.compressed;
      const b = raw.battery;
      const percent = b && b.full > 0 ? Math.min(1, b.remaining / b.full) : null;
      const temperatures = [
        ...raw.thermal.map(([name, kelvin]) => ({ name: "ACPI " + name.replace(/^\\?_TZ\./, ""), celsius: kelvin - 273.15 })),
        ...gpus.filter(g => g.temperature != null).map(g => ({ name: g.name, celsius: g.temperature! })),
      ];
      // The first line has no previous one to take rates from: shown at once
      // as a warm-up sample, which the next one replaces.
      onSample({
        ...(last ? {} : { warmup: true }),
        cpu: { user: usage.user, system: usage.system, cores: usage.cores, speed: perf != null && base ? base * perf / 100 / 1000 : null, baseSpeed: base ? base / 1000 : null,
          temperature: raw.thermal.length ? Math.max(...raw.thermal.map(([, k]) => k)) - 273.15 : null, power: cpuPower, load: [...load], runnable },
        memory: { total: m.total, used: m.total - m.available, available: m.available, app: Math.max(0, m.total - free - cached - wired - compressed), wired, compressed, cached, free,
          commit: m.commit, commitLimit: m.commitLimit, paged: m.paged, nonpaged: m.nonpaged, handles: m.handles, threads: m.threads },
        gpu: primary ? { ...primary, memory: primary.dedicated } : null,
        gpus,
        disk: { read: diskRead, write: diskWrite, free: raw.disk.free, total: raw.disk.total, readTotal: raw.disk.disks.reduce((a, d) => a + d.read, 0), written: raw.disk.disks.reduce((a, d) => a + d.written, 0), disks },
        net: { down, up, received, sent, adapters },
        battery: b && percent !== null ? {
          percent, charging: b.charging, plugged: b.online,
          health: info.designCapacity ? b.full / info.designCapacity : null, cycles: b.cycles || null,
          designCapacity: info.designCapacity, fullCapacity: b.full, draw: b.rate ? b.rate / 1000 : null,
        } : null,
        power: { cpu: cpuPower, gpu: gpuPower, system: b?.discharging && b.rate ? b.rate / 1000 : cpuPower !== null || gpuPower !== null ? (cpuPower ?? 0) + (gpuPower ?? 0) + (energy.get("RAPL_Package0_DRAM") ?? 0) : null },
        temperatures,
        procs,
      });
      last = { at: now, clock: raw.at, procs: seen, disks: new Map(raw.disk.disks.map(d => [d.index, d])), nics: new Map(raw.net.map(n => [n.name, n])) };
    }
  })();
  return () => { stopped = true; child?.kill(); };
}

async function* lines(stream: AsyncIterable<Uint8Array>): AsyncGenerator<string> {
  const decoder = new TextDecoder();
  let buffer = "";
  for await (const chunk of stream) {
    buffer += decoder.decode(chunk, { stream: true });
    let nl: number;
    while ((nl = buffer.indexOf("\n")) >= 0) {
      yield buffer.slice(0, nl).trim();
      buffer = buffer.slice(nl + 1);
    }
  }
}

// ── program icons ───────────────────────────────────────────────────────────
// Each program's own icon, as Windows shows it: extracted once per executable
// into a temp folder by the sampler helper (System.Drawing), then shown with
// <Image src={path}>. Requests made before the helper runs wait for it.
const iconDir = join(tmpdir(), "tarve-pulse-icons");
const icons = new Map<string, string | null>();
const pending: string[] = [];
let requestIcon: ((line: string) => void) | null = null;
let onIcon: () => void = () => { };

function connectIcons(send: (line: string) => void): void {
  mkdirSync(iconDir, { recursive: true });
  requestIcon = send;
  for (const line of pending.splice(0)) send(line);
}

/** The helper's answer, "ok|program" or "no|program". */
function iconAnswer(line: string): void {
  const bar = line.indexOf("|");
  if (bar < 0) return;
  const source = line.slice(bar + 1);
  icons.set(source.toLowerCase(), line.startsWith("ok") ? iconFile(source) : null);
  onIcon();
}

function iconFile(exe: string): string {
  let h = 0;
  for (const ch of exe.toLowerCase()) h = (h * 33 + ch.charCodeAt(0)) >>> 0;
  return join(iconDir, h.toString(36) + ".png");
}

/** The icon of the program at `exe` as a PNG path, once extracted; undefined until then. */
export function iconFor(exe: string | null): string | undefined {
  if (!exe) return undefined;
  const key = exe.toLowerCase();
  if (icons.has(key)) return icons.get(key) ?? undefined;
  const file = iconFile(exe);
  if (existsSync(file)) { icons.set(key, file); return file; }
  icons.set(key, null);
  if (process.platform !== "win32") return undefined;
  if (requestIcon) requestIcon(exe + "|" + file); else pending.push(exe + "|" + file);
  return undefined;
}

/** Called whenever another icon is ready, to render again. */
export function onIconReady(callback: () => void): void { onIcon = callback; }
