/**
 * Synchronous node:fs over the C runtime, through tjs:ffi: txiki.js only has an
 * asynchronous file API, and the core reads icons, fonts and assets synchronously.
 */
import { dlopen, read as readMemory } from "tjs:ffi";
import { Buffer } from "./buffer";
import { EventEmitter } from "./events";

declare const TARVE_TXIKI_PLATFORM: "win32" | "linux";
const windows = TARVE_TXIKI_PLATFORM === "win32";

const S_IFMT = 0xf000;
const S_IFDIR = 0x4000;
const S_IFREG = 0x8000;
// Linux open(2) flags (x86-64 and arm64).
const O_WRONLY = 0o1;
const O_RDWR = 0o2;
const O_CREAT = 0o100;
const O_TRUNC = 0o1000;
const O_APPEND = 0o2000;
const O_CLOEXEC = 0o2000000;

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
      _waccess: { args: ["buffer", "i32"], returns: "i32" },
      _fseeki64: { args: ["ptr", "i64", "i32"], returns: "i32" },
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
      /** Windows has no permission bits to create a file with (like Node.js, `mode` is ignored). */
      create: (path: string, mode: string, _permissions: number) => c._wfopen(wide(path), wide(mode)),
      close: c.fclose, read: c.fread, write: c.fwrite,
      seek: (file: unknown, position: number) => c._fseeki64(file, position, 0),
      // _waccess knows F_OK, W_OK and R_OK; X_OK is F_OK on Windows, as in libuv.
      access: (path: string, mode: number) => c._waccess(wide(path), mode & 6),
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
  // The glibc soname: dlopen does not search for a bare "c" (and libc.so is a linker script).
  const c = dlopen("libc.so.6", {
    fopen: { args: ["string", "string"], returns: "ptr" },
    fclose: { args: ["ptr"], returns: "i32" },
    fread: { args: ["buffer", "size_t", "size_t", "ptr"], returns: "size_t" },
    fwrite: { args: ["buffer", "size_t", "size_t", "ptr"], returns: "size_t" },
    stat: { args: ["string", "buffer"], returns: "i32" },
    mkdir: { args: ["string", "u32"], returns: "i32" },
    remove: { args: ["string"], returns: "i32" },
    rmdir: { args: ["string"], returns: "i32" },
    rename: { args: ["string", "string"], returns: "i32" },
    chmod: { args: ["string", "u32"], returns: "i32" },
    opendir: { args: ["string"], returns: "ptr" },
    readdir: { args: ["ptr"], returns: "ptr" },
    closedir: { args: ["ptr"], returns: "i32" },
    access: { args: ["string", "i32"], returns: "i32" },
    fseeko: { args: ["ptr", "i64", "i32"], returns: "i32" },
    open: { args: ["string", "i32", "u32"], returns: "i32" },
    fdopen: { args: ["i32", "string"], returns: "ptr" },
    close: { args: ["i32"], returns: "i32" },
  }).symbols;
  const utf8 = new TextDecoder();
  return {
    open: c.fopen, close: c.fclose, read: c.fread, write: c.fwrite,
    /** A file for writing ("w"/"a" modes) created with `permissions` (less the umask), as node:fs does. */
    create(path: string, mode: string, permissions: number) {
      const flags = (mode.includes("+") ? O_RDWR : O_WRONLY) | O_CREAT | O_CLOEXEC | (mode.startsWith("a") ? O_APPEND : O_TRUNC);
      const fd = c.open(path, flags, permissions);
      if (fd < 0) return null;
      const file = c.fdopen(fd, mode);
      if (isNull(file)) c.close(fd);
      return file;
    },
    seek: (file: unknown, position: number) => c.fseeko(file, position, 0),
    access: c.access,
    // x86-64 glibc struct stat: st_mode is a u32 at 24, st_size an i64 at 48, st_mtime an i64 at 88.
    stat(path: string) {
      const buffer = new Uint8Array(144);
      if (c.stat(path, buffer) !== 0) return undefined;
      const view = new DataView(buffer.buffer);
      return { mode: view.getUint32(24, true), size: Number(view.getBigInt64(48, true)), mtimeMs: Number(view.getBigInt64(88, true)) * 1000 };
    },
    mkdir: (path: string) => c.mkdir(path, 0o777),
    remove: c.remove, rmdir: c.rmdir, rename: c.rename,
    chmod: c.chmod,
    // x86-64 and arm64 glibc struct dirent: d_type a u8 at 18, d_name (NUL-terminated) at 19.
    readdir(path: string): { name: string; directory: boolean }[] | undefined {
      const directory = c.opendir(path);
      if (isNull(directory)) return undefined;
      const entries: { name: string; directory: boolean }[] = [];
      try {
        for (let entry = c.readdir(directory); !isNull(entry); entry = c.readdir(directory)) {
          const bytes: number[] = [];
          for (let offset = 19, byte = readMemory.u8(entry, offset); byte !== 0; byte = readMemory.u8(entry, ++offset)) bytes.push(byte);
          const name = utf8.decode(new Uint8Array(bytes));
          if (name === "." || name === "..") continue;
          const type = readMemory.u8(entry, 18);
          // DT_DIR, or DT_UNKNOWN (some file systems): ask stat.
          entries.push({ name, directory: type === 4 || (type === 0 && ((this.stat(`${path}/${name}`)?.mode ?? 0) & S_IFMT) === S_IFDIR) });
        }
      } finally {
        c.closedir(directory);
      }
      return entries;
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
  // Read to the end of the file, not to its stat size: /proc files report 0 bytes, and a file can grow.
  let bytes = new Buffer(stat.size + 1);
  let read = 0;
  try {
    for (;;) {
      if (read === bytes.length) {
        const grown = new Buffer(Math.max(64 * 1024, bytes.length * 2));
        grown.set(bytes);
        bytes = grown;
      }
      const count = Number(crt().read(bytes.subarray(read), 1, bytes.length - read, file));
      if (count <= 0) break;
      read += count;
    }
  } finally {
    crt().close(file);
  }
  // subarray keeps the Buffer subclass (Symbol.species).
  const result = bytes.subarray(0, read) as Buffer;
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

/** node:fs.constants: the access modes (the same numbers on every platform) and COPYFILE_EXCL. */
export const constants = { F_OK: 0, R_OK: 4, W_OK: 2, X_OK: 1, COPYFILE_EXCL: 1 } as const;

export function accessSync(path: string, mode: number = constants.F_OK): void {
  if (crt().access(path, mode) === 0) return;
  throw failure(existsSync(path) ? (windows ? "EPERM" : "EACCES") : "ENOENT", "access", path);
}

/** C stdio modes of node:fs's string flags ("x" is checked first; "s" needs nothing more from stdio). */
const STDIO_MODES: Record<string, string> = { r: "rb", "r+": "r+b", w: "wb", "w+": "w+b", a: "ab", "a+": "a+b" };

/** Descriptors openSync hands out, each a C FILE. */
const descriptors = new Map<number, unknown>();
let nextDescriptor = 3;

function fileOf(fd: number): unknown {
  const file = descriptors.get(fd);
  if (file === undefined) throw Object.assign(new Error(`EBADF: bad file descriptor ${fd}`), { code: "EBADF", errno: -9 });
  return file;
}

export function openSync(path: string, flags: string = "r", mode = 0o666): number {
  const stdio = typeof flags === "string" ? STDIO_MODES[flags.replace(/[xs]/g, "")] : undefined;
  if (!stdio) throw Object.assign(new TypeError(`fs.openSync: flags ${String(flags)} are not supported in the Tarve txiki.js runtime; use "r", "r+", "w", "w+", "a" or "a+" (with x/s)`), { code: "ERR_INVALID_ARG_VALUE" });
  if (flags.includes("x") && existsSync(path)) throw failure("EEXIST", "open", path);
  const reading = stdio.startsWith("r");
  if (reading && !existsSync(path)) throw failure("ENOENT", "open", path);
  const file = reading ? crt().open(path, stdio) : crt().create(path, stdio, mode);
  if (isNull(file)) throw failure(existsSync(path) ? "EACCES" : "ENOENT", "open", path);
  const fd = nextDescriptor++;
  descriptors.set(fd, file);
  return fd;
}

export function closeSync(fd: number): void {
  crt().close(fileOf(fd));
  descriptors.delete(fd);
}

/** Reads into `buffer` at `offset`; from `position` when given, else where the last read or write ended. */
export function readSync(fd: number, buffer: Uint8Array, offset = 0, length = buffer.byteLength - offset, position: number | bigint | null = null): number {
  const file = fileOf(fd);
  if (position !== null && position !== undefined && Number(position) >= 0) crt().seek(file, Number(position));
  return Number(crt().read(buffer.subarray(offset, offset + length), 1, length, file));
}

export function writeSync(fd: number, data: string | Uint8Array, offset = 0, length?: number, position: number | null = null): number {
  const file = fileOf(fd);
  const bytes = typeof data === "string" ? Buffer.from(data) : data.subarray(offset, length === undefined ? undefined : offset + length);
  if (position !== null && position !== undefined && position >= 0) crt().seek(file, position);
  const written = bytes.length ? Number(crt().write(bytes, 1, bytes.length, file)) : 0;
  if (written !== bytes.length) throw Object.assign(new Error(`EIO: write ${fd}`), { code: "EIO" });
  return written;
}

/** Copies in 1 MiB chunks; the copy gets the source's permission bits, as with libuv. */
export function copyFileSync(from: string, to: string, mode = 0): void {
  const source = statSync(from);
  if (source.isDirectory()) throw failure("EISDIR", "copyfile", from);
  const input = openSync(from, "r");
  try {
    const output = openSync(to, mode & constants.COPYFILE_EXCL ? "wx" : "w", crt().stat(from)!.mode & 0o7777);
    try {
      const chunk = new Uint8Array(1 << 20);
      for (let count = readSync(input, chunk); count > 0; count = readSync(input, chunk)) writeSync(output, chunk, 0, count);
    } finally {
      closeSync(output);
    }
  } finally {
    closeSync(input);
  }
  if (!windows) chmodSync(to, crt().stat(from)!.mode & 0o7777);
}

type Done = (error?: Error | null) => void;

/** node:fs's WriteStream for a local file: each write goes to the file at once, so it never asks to drain. */
export class WriteStream extends EventEmitter {
  bytesWritten = 0;
  private fd?: number;
  private ended = false;

  constructor(readonly path: string, options?: { flags?: string; mode?: number }) {
    super();
    try {
      this.fd = openSync(path, options?.flags ?? "w", options?.mode);
      queueMicrotask(() => { this.emit("open", this.fd); this.emit("ready"); });
    } catch (error) {
      this.ended = true;
      queueMicrotask(() => this.emit("error", error));
    }
  }

  write(chunk: string | Uint8Array, encoding?: string | Done, callback?: Done): boolean {
    const done = typeof encoding === "function" ? encoding : callback;
    try {
      if (this.fd === undefined || this.ended) throw Object.assign(new Error("write after end"), { code: "ERR_STREAM_WRITE_AFTER_END" });
      const bytes = typeof chunk === "string" ? Buffer.from(chunk, (typeof encoding === "string" ? encoding : "utf8") as "utf8") : chunk;
      this.bytesWritten += writeSync(this.fd, bytes);
      if (done) queueMicrotask(() => done(null));
    } catch (error) {
      queueMicrotask(() => { done?.(error as Error); this.emit("error", error); });
    }
    return true;
  }

  /** Writes `chunk`, closes the file, then "finish" (and `callback`) and "close". */
  end(chunk?: string | Uint8Array | Done, callback?: Done): this {
    const done = typeof chunk === "function" ? chunk : callback;
    if (chunk !== undefined && typeof chunk !== "function") this.write(chunk);
    if (this.ended) {
      if (done) queueMicrotask(() => done(null));
      return this;
    }
    this.ended = true;
    let error: Error | undefined;
    try { if (this.fd !== undefined) closeSync(this.fd); } catch (failure) { error = failure as Error; }
    this.fd = undefined;
    queueMicrotask(() => {
      if (error) {
        done?.(error);
        this.emit("error", error);
        return;
      }
      this.emit("finish");
      done?.(null);
      this.emit("close");
    });
    return this;
  }

  destroy(error?: Error): this {
    if (this.fd !== undefined) try { closeSync(this.fd); } catch {}
    this.fd = undefined;
    this.ended = true;
    queueMicrotask(() => {
      if (error) this.emit("error", error);
      this.emit("close");
    });
    return this;
  }
}

export function createWriteStream(path: string, options?: { flags?: string; mode?: number }): WriteStream {
  return new WriteStream(path, options);
}

export default {
  accessSync, chmodSync, closeSync, constants, copyFileSync, createWriteStream, existsSync, mkdirSync, mkdtempSync, openSync,
  readFileSync, readSync, readdirSync, renameSync, rmSync, statSync, unlinkSync, writeFileSync, writeSync, WriteStream,
};
