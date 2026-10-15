/**
 * Synchronous node:fs over the C runtime, through tjs:ffi: txiki.js only has an
 * asynchronous file API, and the core reads icons, fonts and assets synchronously.
 */
import { dlopen } from "tjs:ffi";
import { Buffer } from "./buffer";

declare const TARVE_TXIKI_PLATFORM: "win32" | "linux";
const windows = TARVE_TXIKI_PLATFORM === "win32";

const S_IFMT = 0xf000;
const S_IFDIR = 0x4000;
const S_IFREG = 0x8000;

function load() {
  if (windows) {
    const c = dlopen("ucrtbase.dll", {
      _wfopen: { args: ["buffer", "buffer"], returns: "ptr" },
      fclose: { args: ["ptr"], returns: "i32" },
      fread: { args: ["buffer", "size_t", "size_t", "ptr"], returns: "size_t" },
      fwrite: { args: ["buffer", "size_t", "size_t", "ptr"], returns: "size_t" },
      _wstat64: { args: ["buffer", "buffer"], returns: "i32" },
      _wmkdir: { args: ["buffer"], returns: "i32" },
      _wremove: { args: ["buffer"], returns: "i32" },
      _wrmdir: { args: ["buffer"], returns: "i32" },
    }).symbols;
    const kernel = dlopen("kernel32.dll", {
      MoveFileExW: { args: ["buffer", "buffer", "u32"], returns: "i32" },
      FindFirstFileW: { args: ["buffer", "buffer"], returns: "ptr" },
      FindNextFileW: { args: ["ptr", "buffer"], returns: "i32" },
      FindClose: { args: ["ptr"], returns: "i32" },
    }).symbols;
    const wide = (value: string) => {
      const units = new Uint16Array(value.length + 1);
      for (let index = 0; index < value.length; index++) units[index] = value.charCodeAt(index);
      return new Uint8Array(units.buffer);
    };
    return {
      open: (path: string, mode: string) => c._wfopen(wide(path), wide(mode)),
      close: c.fclose, read: c.fread, write: c.fwrite,
      // struct _stat64: st_mode is a u16 at 6, st_size an i64 at 24, st_mtime an i64 at 40.
      stat(path: string) {
        const buffer = new Uint8Array(56);
        if (c._wstat64(wide(path), buffer) !== 0) return undefined;
        const view = new DataView(buffer.buffer);
        return { mode: view.getUint16(6, true), size: Number(view.getBigInt64(24, true)), mtimeMs: Number(view.getBigInt64(40, true)) * 1000 };
      },
      mkdir: (path: string) => c._wmkdir(wide(path)),
      remove: (path: string) => c._wremove(wide(path)),
      rmdir: (path: string) => c._wrmdir(wide(path)),
      // MOVEFILE_REPLACE_EXISTING | MOVEFILE_COPY_ALLOWED, like Node's renameSync.
      rename: (from: string, to: string) => kernel.MoveFileExW(wide(from), wide(to), 3) !== 0 ? 0 : -1,
      chmod: (_path: string, _mode: number) => 0,
      // WIN32_FIND_DATAW: dwFileAttributes at 0, cFileName (WCHAR[260]) at 44.
      readdir(path: string): { name: string; directory: boolean }[] | undefined {
        const data = new Uint8Array(592);
        const handle = kernel.FindFirstFileW(wide(path.replace(/[\\/]*$/, "\\*")), data);
        if (isNull(handle) || (handle as { addr?: bigint | number }).addr === -1n || BigInt((handle as { addr?: bigint | number }).addr ?? 0) === 0xffffffffffffffffn) return undefined;
        const entries: { name: string; directory: boolean }[] = [];
        const view = new DataView(data.buffer);
        try {
          do {
            const units = new Uint16Array(data.buffer, 44, 260);
            const name = String.fromCharCode(...units.subarray(0, units.indexOf(0)));
            if (name !== "." && name !== "..") entries.push({ name, directory: (view.getUint32(0, true) & 0x10) !== 0 });
          } while (kernel.FindNextFileW(handle, data) !== 0);
        } finally {
          kernel.FindClose(handle);
        }
        return entries;
      },
    };
  }
  const c = dlopen("c", {
    fopen: { args: ["string", "string"], returns: "ptr" },
    fclose: { args: ["ptr"], returns: "i32" },
    fread: { args: ["buffer", "size_t", "size_t", "ptr"], returns: "size_t" },
    fwrite: { args: ["buffer", "size_t", "size_t", "ptr"], returns: "size_t" },
    stat: { args: ["string", "buffer"], returns: "i32" },
    mkdir: { args: ["string", "u32"], returns: "i32" },
    remove: { args: ["string"], returns: "i32" },
    rmdir: { args: ["string"], returns: "i32" },
    rename: { args: ["string", "string"], returns: "i32" },
  }).symbols;
  return {
    open: c.fopen, close: c.fclose, read: c.fread, write: c.fwrite,
    // x86-64 glibc struct stat: st_mode is a u32 at 24, st_size an i64 at 48, st_mtime an i64 at 88.
    stat(path: string) {
      const buffer = new Uint8Array(144);
      if (c.stat(path, buffer) !== 0) return undefined;
      const view = new DataView(buffer.buffer);
      return { mode: view.getUint32(24, true), size: Number(view.getBigInt64(48, true)), mtimeMs: Number(view.getBigInt64(88, true)) * 1000 };
    },
    mkdir: (path: string) => c.mkdir(path, 0o777),
    remove: c.remove, rmdir: c.rmdir, rename: c.rename,
    chmod: (path: string, mode: number) => dlopen("c", { chmod: { args: ["string", "u32"], returns: "i32" } }).symbols.chmod(path, mode),
    readdir(_path: string): { name: string; directory: boolean }[] | undefined {
      throw new Error("fs.readdirSync is not available in the Tarve txiki.js runtime on Linux; use fs/promises readdir.");
    },
  };
}

let native: ReturnType<typeof load> | undefined;
const crt = () => (native ??= load());

function failure(code: string, syscall: string, path: string): Error {
  return Object.assign(new Error(`${code}: ${syscall} '${path}'`), { code, syscall, path });
}

function isNull(pointer: unknown): boolean {
  return pointer == null || pointer === 0 || pointer === 0n || (typeof pointer === "object" && (pointer as { isNull?: boolean }).isNull === true);
}

type Encoding = BufferEncoding | { encoding?: BufferEncoding | null; flag?: string } | null | undefined;

function encodingOf(options: Encoding): BufferEncoding | undefined {
  return typeof options === "string" ? options : options?.encoding ?? undefined;
}

export interface Stats {
  size: number;
  mtimeMs: number;
  isFile(): boolean;
  isDirectory(): boolean;
}

export function statSync(path: string, options?: { throwIfNoEntry?: boolean }): Stats {
  const stat = crt().stat(path);
  if (!stat) {
    if (options?.throwIfNoEntry === false) return undefined as unknown as Stats;
    throw failure("ENOENT", "stat", path);
  }
  return { size: stat.size, mtimeMs: stat.mtimeMs, isFile: () => (stat.mode & S_IFMT) === S_IFREG, isDirectory: () => (stat.mode & S_IFMT) === S_IFDIR };
}

export function existsSync(path: string): boolean {
  return typeof path === "string" && crt().stat(path) !== undefined;
}

export function readFileSync(path: string, options?: Encoding): any {
  const stat = statSync(path);
  if (stat.isDirectory()) throw failure("EISDIR", "read", path);
  const file = crt().open(path, "rb");
  if (isNull(file)) throw failure("EACCES", "open", path);
  const bytes = new Buffer(stat.size);
  let read = 0;
  try {
    while (read < bytes.length) {
      const count = Number(crt().read(bytes.subarray(read), 1, bytes.length - read, file));
      if (count <= 0) break;
      read += count;
    }
  } finally {
    crt().close(file);
  }
  // subarray keeps the Buffer subclass (Symbol.species).
  const result = (read === bytes.length ? bytes : bytes.subarray(0, read)) as Buffer;
  const encoding = encodingOf(options);
  return encoding ? result.toString(encoding as "utf8") : result;
}

export function writeFileSync(path: string, data: string | Uint8Array, options?: Encoding): void {
  const flag = typeof options === "object" && options ? options.flag ?? "w" : "w";
  const exclusive = flag.includes("x");
  if (exclusive && existsSync(path)) throw failure("EEXIST", "open", path);
  const bytes = typeof data === "string" ? Buffer.from(data, (encodingOf(options) ?? "utf8") as "utf8") : data;
  const file = crt().open(path, flag.startsWith("a") ? "ab" : "wb");
  if (isNull(file)) throw failure("EACCES", "open", path);
  try {
    if (bytes.length && Number(crt().write(bytes, 1, bytes.length, file)) !== bytes.length) throw failure("EIO", "write", path);
  } finally {
    crt().close(file);
  }
}

export function mkdirSync(path: string, options?: { recursive?: boolean }): void {
  if (options?.recursive) {
    const stat = crt().stat(path);
    if (stat && (stat.mode & S_IFMT) === S_IFDIR) return;
    const parent = path.replace(/[\\/]+[^\\/]*[\\/]*$/, "");
    if (parent && parent !== path && !/^[A-Za-z]:$/.test(parent)) mkdirSync(parent, options);
  }
  if (crt().mkdir(path) !== 0 && !(options?.recursive && existsSync(path))) throw failure("EEXIST", "mkdir", path);
}

export function renameSync(from: string, to: string): void {
  if (crt().rename(from, to) !== 0) throw failure(existsSync(from) ? "EPERM" : "ENOENT", "rename", from);
}

export function rmSync(path: string, options?: { force?: boolean; recursive?: boolean }): void {
  const stat = crt().stat(path);
  if (!stat) {
    if (options?.force) return;
    throw failure("ENOENT", "rm", path);
  }
  const directory = (stat.mode & S_IFMT) === S_IFDIR;
  if (directory && !options?.recursive) throw failure("ERR_FS_EISDIR", "rm", path);
  // Recursive, like Node: empty the directory first.
  if (directory) for (const name of readdirSync(path) as string[]) rmSync(path + "/" + name, { recursive: true, force: true });
  if ((directory ? crt().rmdir(path) : crt().remove(path)) !== 0) throw failure(directory ? "ENOTEMPTY" : "EPERM", "rm", path);
}

export function readdirSync(path: string, options?: { withFileTypes?: boolean }): any[] {
  // Check first: an invalid FindFirstFileW handle is not reliably recognisable through tjs:ffi.
  const stat = crt().stat(path);
  if (!stat) throw failure("ENOENT", "scandir", path);
  if ((stat.mode & S_IFMT) !== S_IFDIR) throw failure("ENOTDIR", "scandir", path);
  const entries = crt().readdir(path);
  if (!entries) throw failure("ENOENT", "scandir", path);
  return options?.withFileTypes
    ? entries.map(entry => ({ name: entry.name, isFile: () => !entry.directory, isDirectory: () => entry.directory }))
    : entries.map(entry => entry.name);
}

export function mkdtempSync(prefix: string): string {
  for (let attempt = 0; attempt < 16; attempt++) {
    const path = prefix + crypto.randomUUID().replace(/-/g, "").slice(0, 6);
    if (crt().mkdir(path) === 0) return path;
  }
  throw failure("EEXIST", "mkdtemp", prefix);
}

export function chmodSync(path: string, mode: number): void {
  if (crt().chmod(path, mode) !== 0) throw failure("ENOENT", "chmod", path);
}

export function unlinkSync(path: string): void {
  if (crt().remove(path) !== 0) throw failure("ENOENT", "unlink", path);
}

export default { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, statSync, unlinkSync, writeFileSync };
