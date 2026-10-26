/**
 * node:child_process spawnSync for txiki.js, whose own process API (tjs.spawn) is only
 * asynchronous: the core runs short commands synchronously (reg.exe, xdg-mime and
 * update-mime-database for deep links and file associations, the updater). Through tjs:ffi,
 * like the fs shim over the C runtime: CreateProcessW on Windows, posix_spawnp + waitpid
 * (glibc) on Linux. stdin is the null device; stdout and stderr go to temporary files, read
 * once the process exited, so a chatty child can never fill a pipe and stall.
 */
import { bufferToPointer, dlopen, errno } from "tjs:ffi";
import { Buffer } from "./buffer";
import { readFileSync, rmSync } from "./fs";

declare const TARVE_TXIKI_PLATFORM: "win32" | "linux";

export interface SpawnSyncOptions {
  cwd?: string;
  env?: Record<string, string | undefined>;
  encoding?: BufferEncoding | "buffer" | null;
  windowsHide?: boolean;
  /** Milliseconds; the child is ended and `error.code` is ETIMEDOUT when it runs longer. */
  timeout?: number;
}

export interface SpawnSyncReturns<T = Buffer | string> {
  pid: number;
  output: [null, T, T];
  stdout: T;
  stderr: T;
  status: number | null;
  signal: string | null;
  error?: Error;
}

const GENERIC_READ = 0x80000000;
const GENERIC_WRITE = 0x40000000;
const OPEN_EXISTING = 3;
const CREATE_ALWAYS = 2;
const FILE_ATTRIBUTE_TEMPORARY = 0x100;
const STARTF_USESHOWWINDOW = 0x1;
const STARTF_USESTDHANDLES = 0x100;
const CREATE_UNICODE_ENVIRONMENT = 0x400;
const CREATE_NO_WINDOW = 0x08000000;
const WAIT_TIMEOUT = 0x102;
const INVALID_HANDLE = -1;

let kernel: ReturnType<typeof loadKernel> | undefined;
function loadKernel() {
  return dlopen("kernel32.dll", {
    CreateFileW: { args: ["buffer", "u32", "u32", "buffer", "u32", "u32", "u64"], returns: "u64" },
    CreateProcessW: { args: ["u64", "buffer", "u64", "u64", "i32", "u32", "buffer", "buffer", "buffer", "buffer"], returns: "i32" },
    WaitForSingleObject: { args: ["u64", "u32"], returns: "u32" },
    TerminateProcess: { args: ["u64", "u32"], returns: "i32" },
    GetExitCodeProcess: { args: ["u64", "buffer"], returns: "i32" },
    CloseHandle: { args: ["u64"], returns: "i32" },
    GetLastError: { args: [], returns: "u32" },
  }).symbols;
}

/** NUL-terminated UTF-16 (what the W functions take). */
function wide(value: string): Uint8Array {
  const units = new Uint16Array(value.length + 1);
  for (let index = 0; index < value.length; index++) units[index] = value.charCodeAt(index);
  return new Uint8Array(units.buffer);
}

/** One argument for CommandLineToArgvW, as Node.js and libuv quote it. */
function quote(argument: string): string {
  if (argument && !/[\s"]/.test(argument)) return argument;
  return `"${argument.replace(/(\\*)"/g, "$1$1\\\"").replace(/(\\+)$/, "$1$1")}"`;
}

/** An inheritable handle (SECURITY_ATTRIBUTES with bInheritHandle) on `path`. */
function inheritable(path: string, write: boolean): number {
  const attributes = new Uint8Array(24);
  const view = new DataView(attributes.buffer);
  view.setUint32(0, 24, true);
  view.setInt32(16, 1, true);
  const handle = Number(kernel!.CreateFileW(wide(path), write ? GENERIC_WRITE : GENERIC_READ, 3, attributes, write ? CREATE_ALWAYS : OPEN_EXISTING, write ? FILE_ATTRIBUTE_TEMPORARY : 0, 0));
  if (handle === INVALID_HANDLE || handle === 0) throw Object.assign(new Error(`spawnSync: cannot open ${path} (Windows error ${kernel!.GetLastError()})`), { code: "EIO" });
  return handle;
}

function decode(bytes: Buffer, encoding: SpawnSyncOptions["encoding"]): Buffer | string {
  return encoding && encoding !== "buffer" ? bytes.toString(encoding as "utf8") : bytes;
}

function environment(options: SpawnSyncOptions): [string, string][] {
  const env = options.env ?? (globalThis as { process?: { env: Record<string, string | undefined> } }).process?.env ?? tjs.env;
  return Object.entries(env).filter((entry): entry is [string, string] => entry[1] !== undefined);
}

function spawnFailure(command: string, args: readonly string[], code: string, errno: number, detail = code): Error {
  return Object.assign(new Error(`spawnSync ${command} ${detail}`), { code, errno, syscall: `spawnSync ${command}`, path: command, spawnargs: [...args] });
}

function spawnWindows(command: string, args: readonly string[], options: SpawnSyncOptions, base: string, result: SpawnSyncReturns): void {
  kernel ??= loadKernel();
  const handles: number[] = [];
  try {
    const stdin = inheritable("NUL", false);
    handles.push(stdin);
    const stdout = inheritable(`${base}.out`, true);
    handles.push(stdout);
    const stderr = inheritable(`${base}.err`, true);
    handles.push(stderr);
    // STARTUPINFOW (104 bytes on x64): cb, dwFlags at 60, wShowWindow at 64, the std handles at 80/88/96.
    const startup = new Uint8Array(104);
    const info = new DataView(startup.buffer);
    info.setUint32(0, 104, true);
    info.setUint32(60, STARTF_USESTDHANDLES | (options.windowsHide ? STARTF_USESHOWWINDOW : 0), true);
    info.setUint16(64, 0, true);
    info.setBigInt64(80, BigInt(stdin), true);
    info.setBigInt64(88, BigInt(stdout), true);
    info.setBigInt64(96, BigInt(stderr), true);
    // PROCESS_INFORMATION: hProcess at 0, hThread at 8, dwProcessId at 16.
    const processInfo = new Uint8Array(24);
    const block = environment(options).map(([key, value]) => `${key}=${value}\0`).join("") + "\0";
    const commandLine = [command, ...args].map(quote).join(" ");
    const started = kernel.CreateProcessW(0, wide(commandLine), 0, 0, 1, CREATE_UNICODE_ENVIRONMENT | (options.windowsHide ? CREATE_NO_WINDOW : 0), wide(block), wide(options.cwd ?? tjs.cwd), startup, processInfo);
    if (!started) {
      const code = kernel.GetLastError();
      const missing = code === 2 || code === 3;
      result.error = spawnFailure(command, args, missing ? "ENOENT" : "EIO", -code, missing ? "ENOENT" : `failed (Windows error ${code})`);
    } else {
      wait(processInfo, result, command, args, options, handles);
    }
  } finally {
    for (const handle of handles.reverse()) kernel.CloseHandle(handle);
  }
}

/** Waits for the started process (PROCESS_INFORMATION) and records its exit code or the timeout. */
function wait(processInfo: Uint8Array, result: SpawnSyncReturns, command: string, args: readonly string[], options: SpawnSyncOptions, handles: number[]): void {
  const k = kernel!;
  const pinfo = new DataView(processInfo.buffer);
  const process = Number(pinfo.getBigInt64(0, true));
  handles.push(process, Number(pinfo.getBigInt64(8, true)));
  result.pid = pinfo.getUint32(16, true);
  const waited = k.WaitForSingleObject(process, options.timeout && options.timeout > 0 ? Math.min(options.timeout, 0xfffffffe) : 0xffffffff);
  if (waited === WAIT_TIMEOUT) {
    k.TerminateProcess(process, 1);
    k.WaitForSingleObject(process, 0xffffffff);
    result.signal = "SIGTERM";
    // libuv's UV_ETIMEDOUT on Windows, as Node.js reports it.
    result.error = spawnFailure(command, args, "ETIMEDOUT", -4039);
  } else {
    const exit = new Uint8Array(4);
    k.GetExitCodeProcess(process, exit);
    result.status = new DataView(exit.buffer).getUint32(0, true);
  }
}

// ---- Linux (glibc, x86-64 and arm64 alike) -------------------------------------------

const O_RDONLY = 0;
const O_WRONLY = 1;
const O_CREAT = 0o100;
const O_TRUNC = 0o1000;
const WNOHANG = 1;
const EINTR = 4;
const SIGTERM = 15;
const SIGNALS = ["", "SIGHUP", "SIGINT", "SIGQUIT", "SIGILL", "SIGTRAP", "SIGABRT", "SIGBUS", "SIGFPE", "SIGKILL", "SIGUSR1", "SIGSEGV", "SIGUSR2", "SIGPIPE", "SIGALRM", "SIGTERM", "SIGSTKFLT", "SIGCHLD", "SIGCONT", "SIGSTOP", "SIGTSTP", "SIGTTIN", "SIGTTOU", "SIGURG", "SIGXCPU", "SIGXFSZ", "SIGVTALRM", "SIGPROF", "SIGWINCH", "SIGIO", "SIGPWR", "SIGSYS"];
/** sizeof(posix_spawn_file_actions_t) is 80 in glibc; room to spare. */
const FILE_ACTIONS_SIZE = 256;

let libc: ReturnType<typeof loadLibc> | undefined;
function loadLibc() {
  return dlopen("libc.so.6", {
    posix_spawnp: { args: ["buffer", "string", "buffer", "u64", "buffer", "buffer"], returns: "i32" },
    posix_spawn_file_actions_init: { args: ["buffer"], returns: "i32" },
    posix_spawn_file_actions_destroy: { args: ["buffer"], returns: "i32" },
    posix_spawn_file_actions_addopen: { args: ["buffer", "i32", "string", "i32", "u32"], returns: "i32" },
    posix_spawn_file_actions_addchdir_np: { args: ["buffer", "string"], returns: "i32" },
    waitpid: { args: ["i32", "buffer", "i32"], returns: "i32" },
    kill: { args: ["i32", "i32"], returns: "i32" },
    usleep: { args: ["u32"], returns: "i32" },
  }).symbols;
}

const utf8 = new TextEncoder();

/**
 * A NULL-terminated `char *[]` of NUL-terminated UTF-8 strings. The strings stay referenced
 * by the returned `keep` until the call that reads them returned.
 */
function cStrings(values: readonly string[]): { array: Uint8Array; keep: Uint8Array[] } {
  const keep = values.map(value => utf8.encode(`${value}\0`));
  const pointers = new BigUint64Array(values.length + 1);
  keep.forEach((bytes, index) => { pointers[index] = BigInt(bufferToPointer(bytes).toString()); });
  return { array: new Uint8Array(pointers.buffer), keep };
}

function spawnLinux(command: string, args: readonly string[], options: SpawnSyncOptions, base: string, result: SpawnSyncReturns): void {
  const c = (libc ??= loadLibc());
  const actions = new Uint8Array(FILE_ACTIONS_SIZE);
  if (c.posix_spawn_file_actions_init(actions) !== 0) throw spawnFailure(command, args, "ENOMEM", -12);
  try {
    const opened = [
      c.posix_spawn_file_actions_addopen(actions, 0, "/dev/null", O_RDONLY, 0),
      c.posix_spawn_file_actions_addopen(actions, 1, `${base}.out`, O_WRONLY | O_CREAT | O_TRUNC, 0o600),
      c.posix_spawn_file_actions_addopen(actions, 2, `${base}.err`, O_WRONLY | O_CREAT | O_TRUNC, 0o600),
      options.cwd ? c.posix_spawn_file_actions_addchdir_np(actions, options.cwd) : 0,
    ].find(code => code !== 0);
    if (opened) throw spawnFailure(command, args, "EIO", -opened, `failed (errno ${opened})`);
    const argv = cStrings([command, ...args]);
    const envp = cStrings(environment(options).map(([key, value]) => `${key}=${value}`));
    const pid = new Int32Array(1);
    const code = c.posix_spawnp(new Uint8Array(pid.buffer), command, actions, 0, argv.array, envp.array);
    void [argv.keep, envp.keep];
    if (code !== 0) {
      result.error = spawnFailure(command, args, code === 2 ? "ENOENT" : code === 13 ? "EACCES" : "EIO", -code, code === 2 ? "ENOENT" : code === 13 ? "EACCES" : `failed (errno ${code})`);
      return;
    }
    result.pid = pid[0]!;
    waitLinux(c, result, command, args, options);
  } finally {
    c.posix_spawn_file_actions_destroy(actions);
  }
}

/** waitpid until the child exits; past `timeout` it gets SIGTERM, like Node's default killSignal. */
function waitLinux(c: NonNullable<typeof libc>, result: SpawnSyncReturns, command: string, args: readonly string[], options: SpawnSyncOptions): void {
  const status = new Int32Array(1);
  const statusBytes = new Uint8Array(status.buffer);
  const timed = !!options.timeout && options.timeout > 0;
  const deadline = timed ? Date.now() + options.timeout! : Infinity;
  let timedOut = false;
  for (let pause = 1000;;) {
    const waited = c.waitpid(result.pid, statusBytes, timed && !timedOut ? WNOHANG : 0);
    if (waited === result.pid) break;
    if (waited < 0) {
      if (errno() === EINTR) continue;
      throw spawnFailure(command, args, "ECHILD", -10, `waitpid failed (errno ${errno()})`);
    }
    if (Date.now() >= deadline) {
      c.kill(result.pid, SIGTERM);
      timedOut = true;
      continue;
    }
    c.usleep(pause);
    pause = Math.min(pause * 2, 20_000);
  }
  const value = status[0]!;
  const signal = value & 0x7f;
  if (signal === 0) result.status = (value >> 8) & 0xff;
  else result.signal = SIGNALS[signal] ?? `SIG${signal}`;
  if (timedOut) result.error = spawnFailure(command, args, "ETIMEDOUT", -110);
}

export function spawnSync(command: string, args: readonly string[] | SpawnSyncOptions = [], options?: SpawnSyncOptions): SpawnSyncReturns {
  const [list, settings] = Array.isArray(args) ? [args as readonly string[], options ?? {}] : [[] as readonly string[], (args as SpawnSyncOptions) ?? {}];
  const windows = TARVE_TXIKI_PLATFORM === "win32";
  const base = `${tjs.tmpDir}${windows ? "\\" : "/"}tarve-spawn-${crypto.randomUUID()}`;
  const empty = Buffer.alloc(0);
  const result: SpawnSyncReturns = { pid: 0, output: [null, empty, empty], stdout: empty, stderr: empty, status: null, signal: null };
  const read = (path: string) => {
    try { return readFileSync(path) as Buffer; } catch { return empty; } finally {
      // A grandchild that outlived a timed-out child may still hold it open on Windows (as with
      // Node.js, only the child is ended): it then stays in the temporary directory.
      try { rmSync(path, { force: true }); } catch {}
    }
  };
  try {
    if (windows) spawnWindows(command, list, settings, base, result);
    else spawnLinux(command, list, settings, base, result);
  } finally {
    result.stdout = decode(read(`${base}.out`), settings.encoding);
    result.stderr = decode(read(`${base}.err`), settings.encoding);
  }
  return { ...result, output: [null, result.stdout, result.stderr] };
}
