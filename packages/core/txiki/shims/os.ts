import { dlopen } from "tjs:ffi";
import { readFileSync } from "./fs";

declare const TARVE_TXIKI_PLATFORM: "win32" | "linux";
const windows = TARVE_TXIKI_PLATFORM === "win32";

interface TjsSystem {
  cpus: { model: string; speed: number; times: { user: number; nice: number; sys: number; idle: number; irq: number } }[];
  loadAvg: [number, number, number];
  uptime: number;
  networkInterfaces: { name: string; address: string; netmask: string; mac: string; internal: boolean; scopeId?: number }[];
  userInfo: { userName: string; userId: number; groupId: number; shell: string | null; homeDir: string };
}
const system = () => (tjs as unknown as { system: TjsSystem }).system;

export const EOL = windows ? "\r\n" : "\n";
export function tmpdir(): string { return tjs.tmpDir; }
export function homedir(): string { return tjs.homeDir; }
export function hostname(): string { return (tjs as unknown as { hostName: string }).hostName; }
export function platform(): string { return TARVE_TXIKI_PLATFORM; }
export function type(): string { return windows ? "Windows_NT" : "Linux"; }
export function arch(): string { return "x64"; }
export function cpus() { return system().cpus; }
export function availableParallelism(): number { return Math.max(1, system().cpus.length); }
export function loadavg(): number[] { return [...system().loadAvg]; }
export function uptime(): number { return system().uptime; }
export function userInfo() {
  const info = system().userInfo;
  return { username: info.userName, uid: info.userId, gid: info.groupId, shell: info.shell, homedir: info.homeDir };
}
export function networkInterfaces() {
  const out: Record<string, object[]> = {};
  for (const { name, ...entry } of system().networkInterfaces) {
    (out[name] ??= []).push({ ...entry, family: entry.address.includes(":") ? "IPv6" : "IPv4", cidr: null });
  }
  return out;
}

let kernel: ReturnType<typeof loadKernel> | undefined;
function loadKernel() {
  return dlopen("kernel32.dll", { GlobalMemoryStatusEx: { args: ["buffer"], returns: "i32" } }).symbols;
}

/** [total, available] physical memory in bytes. */
function memory(): [number, number] {
  if (windows) {
    // MEMORYSTATUSEX: dwLength at 0, ullTotalPhys at 8, ullAvailPhys at 16.
    const status = new Uint8Array(64);
    const view = new DataView(status.buffer);
    view.setUint32(0, 64, true);
    (kernel ??= loadKernel()).GlobalMemoryStatusEx(status);
    return [Number(view.getBigUint64(8, true)), Number(view.getBigUint64(16, true))];
  }
  const info = readFileSync("/proc/meminfo", "utf8") as string;
  const kib = (key: string) => Number(new RegExp(`^${key}:\\s+(\\d+)`, "m").exec(info)?.[1] ?? 0) * 1024;
  return [kib("MemTotal"), kib("MemAvailable")];
}

export function totalmem(): number { return memory()[0]; }
export function freemem(): number { return memory()[1]; }

/** Kernel version, e.g. "10.0.26100" on Windows (RtlGetVersion is not shimmed by compatibility modes). */
export function release(): string {
  if (!windows) return (readFileSync("/proc/sys/kernel/osrelease", "utf8") as string).trim();
  const info = new Uint8Array(276);
  const view = new DataView(info.buffer);
  view.setUint32(0, 276, true);
  dlopen("ntdll.dll", { RtlGetVersion: { args: ["buffer"], returns: "i32" } }).symbols.RtlGetVersion(info);
  return `${view.getUint32(4, true)}.${view.getUint32(8, true)}.${view.getUint32(12, true)}`;
}

export default { EOL, arch, availableParallelism, cpus, freemem, homedir, hostname, loadavg, networkInterfaces, platform, release, tmpdir, totalmem, type, uptime, userInfo };
