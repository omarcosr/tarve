/** Synchronous node:fs on Android, over the host's file calls (native/src/android/qjs.rs). */
import { Buffer } from "../../txiki/shims/buffer";
import { host, hostCall } from "../host";

type Encoding = BufferEncoding | { encoding?: BufferEncoding | null; flag?: string; recursive?: boolean; withFileTypes?: boolean } | null | undefined;

function encodingOf(options: Encoding): BufferEncoding | undefined {
  return typeof options === "string" ? options : options?.encoding ?? undefined;
}

function failure(code: string, syscall: string, path: string): Error {
  return Object.assign(new Error(`${code}: no such file or directory, ${syscall} '${path}'`), { code, syscall, path });
}

export interface Stats {
  size: number;
  mtimeMs: number;
  mtime: Date;
  mode: number;
  isFile(): boolean;
  isDirectory(): boolean;
  isSymbolicLink(): boolean;
}

export function statSync(path: string, options?: { throwIfNoEntry?: boolean }): Stats {
  const stat = host.stat(String(path));
  if (!stat) {
    if (options?.throwIfNoEntry === false) return undefined as unknown as Stats;
    throw failure("ENOENT", "stat", path);
  }
  const [kind, size, mtimeMs] = stat;
  return {
    size, mtimeMs, mtime: new Date(mtimeMs), mode: kind === 2 ? 0o40755 : 0o100644,
    isFile: () => kind === 1, isDirectory: () => kind === 2, isSymbolicLink: () => false,
  };
}
export const lstatSync = statSync;

export function existsSync(path: string): boolean {
  return typeof path === "string" && host.stat(path) !== undefined;
}

export function accessSync(path: string): void {
  if (!existsSync(path)) throw failure("ENOENT", "access", path);
}

export function readFileSync(path: string, options?: Encoding): any {
  const bytes = Buffer.fromValue(hostCall(() => host.readFile(String(path))));
  const encoding = encodingOf(options);
  return encoding ? bytes.toString(encoding as "utf8") : bytes;
}

export function writeFileSync(path: string, data: string | Uint8Array, options?: Encoding): void {
  const flag = typeof options === "object" && options ? options.flag ?? "w" : "w";
  if (flag.includes("x") && existsSync(path)) throw Object.assign(new Error(`EEXIST: file already exists, open '${path}'`), { code: "EEXIST", syscall: "open", path });
  const bytes = typeof data === "string" ? Buffer.from(data, (encodingOf(options) ?? "utf8") as "utf8") : data;
  hostCall(() => host.writeFile(String(path), bytes, flag.startsWith("a")));
}

export function appendFileSync(path: string, data: string | Uint8Array, options?: Encoding): void {
  writeFileSync(path, data, { ...typeof options === "object" && options ? options : { encoding: options ?? undefined }, flag: "a" });
}

export function mkdirSync(path: string, options?: { recursive?: boolean } | number): string | undefined {
  const recursive = typeof options === "object" && !!options?.recursive;
  if (recursive && host.stat(path)?.[0] === 2) return undefined;
  hostCall(() => host.mkdir(String(path), recursive));
  return recursive ? path : undefined;
}

export function renameSync(from: string, to: string): void {
  hostCall(() => host.rename(String(from), String(to)));
}

export function copyFileSync(from: string, to: string): void {
  hostCall(() => host.copyFile(String(from), String(to)));
}

export function rmSync(path: string, options?: { force?: boolean; recursive?: boolean }): void {
  if (!existsSync(path)) {
    if (options?.force) return;
    throw failure("ENOENT", "rm", path);
  }
  if (host.stat(path)?.[0] === 2 && !options?.recursive) {
    throw Object.assign(new Error(`Path is a directory: rm returned EISDIR (is a directory) ${path}`), { code: "ERR_FS_EISDIR", path });
  }
  hostCall(() => host.remove(String(path), !!options?.recursive));
}

export function rmdirSync(path: string, options?: { recursive?: boolean }): void {
  hostCall(() => host.remove(String(path), !!options?.recursive));
}

export function unlinkSync(path: string): void {
  hostCall(() => host.remove(String(path), false));
}

export function readdirSync(path: string, options?: Encoding): any[] {
  const entries = hostCall(() => host.readDir(String(path)));
  const withFileTypes = typeof options === "object" && !!options?.withFileTypes;
  return entries.map(entry => {
    const directory = entry.endsWith("/");
    const name = directory ? entry.slice(0, -1) : entry;
    return withFileTypes ? { name, parentPath: path, path, isFile: () => !directory, isDirectory: () => directory, isSymbolicLink: () => false } : name;
  });
}

export function mkdtempSync(prefix: string): string {
  for (let attempt = 0; attempt < 16; attempt++) {
    const path = prefix + crypto.randomUUID().replace(/-/g, "").slice(0, 6);
    if (existsSync(path)) continue;
    hostCall(() => host.mkdir(path, false));
    return path;
  }
  throw Object.assign(new Error(`EEXIST: mkdtemp '${prefix}'`), { code: "EEXIST" });
}

export function realpathSync(path: string): string {
  accessSync(path);
  return path;
}

export function chmodSync(path: string, _mode: number): void {
  accessSync(path);
}

/** File descriptors exist only in the Bun flavor (its bridge socket, bridge/remote.ts); the
 * QuickJS app has none, so these are reachable in the bundle but never called. */
function noDescriptors(name: string): never {
  throw Object.assign(new Error(`ENOSYS: ${name} is not available in the Android QuickJS runtime`), { code: "ENOSYS" });
}

export function readSync(_fd: number, _buffer: Uint8Array, _offset?: number, _length?: number, _position?: number | null): number {
  return noDescriptors("readSync");
}

export function writeSync(_fd: number, _buffer: Uint8Array, _offset?: number, _length?: number): number {
  return noDescriptors("writeSync");
}

export const constants = { F_OK: 0, R_OK: 4, W_OK: 2, X_OK: 1 };

export default {
  accessSync, appendFileSync, chmodSync, constants, copyFileSync, existsSync, lstatSync, mkdirSync, mkdtempSync,
  readFileSync, readSync, readdirSync, realpathSync, renameSync, rmSync, rmdirSync, statSync, unlinkSync, writeFileSync,
  writeSync,
};
