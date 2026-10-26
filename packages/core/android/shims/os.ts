/** node:os on Android. */
import { host } from "../host";

function proc(path: string): string {
  try {
    return host.decode(host.readFile(path));
  } catch {
    return "";
  }
}

export const EOL = "\n";
export function tmpdir(): string { return host.cacheDir; }
export function homedir(): string { return host.filesDir; }
export function hostname(): string { return proc("/proc/sys/kernel/hostname").trim() || "localhost"; }
export function platform(): string { return "android"; }
export function type(): string { return "Linux"; }
export function arch(): string { return (globalThis as { process?: { arch?: string } }).process?.arch ?? "arm64"; }
export function machine(): string { return host.arch; }
export function release(): string { return proc("/proc/sys/kernel/osrelease").trim(); }
export function version(): string { return proc("/proc/version").trim(); }
export function uptime(): number { return Number(proc("/proc/uptime").split(" ")[0]) || 0; }
export function loadavg(): number[] { return proc("/proc/loadavg").split(" ").slice(0, 3).map(Number).map(value => value || 0); }
export function cpus() {
  const count = proc("/proc/cpuinfo").split("\n").filter(line => /^processor\s*:/.test(line)).length || 1;
  return Array.from({ length: count }, () => ({ model: "", speed: 0, times: { user: 0, nice: 0, sys: 0, idle: 0, irq: 0 } }));
}
export function availableParallelism(): number { return cpus().length; }
function meminfo(key: string): number {
  return Number(new RegExp(`^${key}:\\s+(\\d+)`, "m").exec(proc("/proc/meminfo"))?.[1] ?? 0) * 1024;
}
export function totalmem(): number { return meminfo("MemTotal"); }
export function freemem(): number { return meminfo("MemAvailable"); }
export function userInfo() { return { username: "app", uid: -1, gid: -1, shell: null, homedir: host.filesDir }; }
export function networkInterfaces(): Record<string, object[]> { return {}; }
export function endianness(): "LE" { return "LE"; }

export default { EOL, arch, availableParallelism, cpus, endianness, freemem, homedir, hostname, loadavg, machine, networkInterfaces, platform, release, tmpdir, totalmem, type, uptime, userInfo, version };
