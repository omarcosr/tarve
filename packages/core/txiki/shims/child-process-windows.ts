/**
 * spawn(..., { windowsHide: true }) for txiki.js on Windows. tjs.spawn cannot hide a console
 * child (libuv's UV_PROCESS_WINDOWS_HIDE is never set), so a GUI app running `reg` or `netsh`
 * flashes a console window. This starts the child with CreateProcessW and CREATE_NO_WINDOW, as
 * Node.js does, and hands back the same process object tjs.spawn gives:
 * - piped stdio are named pipes: the child gets the server end, this process connects to it
 *   with tjs.connect, so reads and writes stay asynchronous on libuv;
 * - the child starts suspended and runs once its pipes are connected, so no output is lost and
 *   `pid` is known at once;
 * - its exit comes from the native library (tarve_watch_process), which waits on the process
 *   handle on a thread of its own and reports the code through a pipe.
 */
import { dlopen } from "tjs:ffi";
import { nativePath } from "../runtime";

type Stdio = "pipe" | "ignore" | "inherit";

export interface HiddenSpawnOptions {
  cwd?: string;
  env?: Record<string, string | undefined>;
}

/** What tjs.spawn returns, the slice ChildProcess uses. */
export interface SpawnedProcess {
  pid: number;
  stdin?: WritableStream<Uint8Array>;
  stdout?: ReadableStream<Uint8Array>;
  stderr?: ReadableStream<Uint8Array>;
  kill(signal?: string): void;
  wait(): Promise<{ exit_status: number; term_signal: string | null }>;
}

const GENERIC_READ = 0x80000000;
const GENERIC_WRITE = 0x40000000;
const OPEN_EXISTING = 3;
const PIPE_ACCESS_DUPLEX = 0x3;
const PIPE_TYPE_BYTE = 0x0;
const PIPE_WAIT = 0x0;
const PIPE_REJECT_REMOTE_CLIENTS = 0x8;
const STARTF_USESHOWWINDOW = 0x1;
const STARTF_USESTDHANDLES = 0x100;
const SW_HIDE = 0;
const CREATE_SUSPENDED = 0x4;
const CREATE_UNICODE_ENVIRONMENT = 0x400;
const CREATE_NO_WINDOW = 0x08000000;
const DUPLICATE_SAME_ACCESS = 0x2;
const STD_HANDLES = [-10, -11, -12];
const INVALID_HANDLE = -1;
const PIPE_BUFFER = 64 * 1024;

let kernel: ReturnType<typeof loadKernel> | undefined;
function loadKernel() {
  return dlopen("kernel32.dll", {
    CreateNamedPipeW: { args: ["buffer", "u32", "u32", "u32", "u32", "u32", "u32", "buffer"], returns: "u64" },
    CreateFileW: { args: ["buffer", "u32", "u32", "buffer", "u32", "u32", "u64"], returns: "u64" },
    CreateProcessW: { args: ["u64", "buffer", "u64", "u64", "i32", "u32", "buffer", "buffer", "buffer", "buffer"], returns: "i32" },
    DuplicateHandle: { args: ["u64", "u64", "u64", "buffer", "u32", "i32", "u32"], returns: "i32" },
    GetCurrentProcess: { args: [], returns: "u64" },
    GetStdHandle: { args: ["i32"], returns: "u64" },
    ResumeThread: { args: ["u64"], returns: "u32" },
    TerminateProcess: { args: ["u64", "u32"], returns: "i32" },
    CloseHandle: { args: ["u64"], returns: "i32" },
    GetLastError: { args: [], returns: "u32" },
  }).symbols;
}

const WATCH_SYMBOLS = {
  tarve_watch_process: { args: ["u64", "buffer", "u32"], returns: "i32" },
  tarve_last_error: { args: ["buffer", "u32"], returns: "i32" },
} as const;
let watcher: ReturnType<typeof dlopen<typeof WATCH_SYMBOLS>>["symbols"] | undefined;

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

/** SECURITY_ATTRIBUTES with bInheritHandle: the handle goes to the child. */
function inheritAttributes(): Uint8Array {
  const attributes = new Uint8Array(24);
  const view = new DataView(attributes.buffer);
  view.setUint32(0, 24, true);
  view.setInt32(16, 1, true);
  return attributes;
}

function failure(command: string, args: readonly string[], code: number): Error {
  const missing = code === 2 || code === 3;
  const name = missing ? "ENOENT" : "EIO";
  return Object.assign(new Error(`spawn ${command} ${missing ? "ENOENT" : `failed (Windows error ${code})`}`), { code: name, errno: -code, syscall: `spawn ${command}`, path: command, spawnargs: [...args] });
}

let nextPipe = 0;

/** The pipe the exit code of `process` arrives on (native/src/bridge/entry_points.rs). */
function watchName(process: number): string {
  watcher ??= dlopen(nativePath(), WATCH_SYMBOLS).symbols;
  for (let size = 128; ;) {
    const out = new Uint8Array(size);
    const length = watcher.tarve_watch_process(process, out, size) as number;
    if (length >= 0) return new TextDecoder().decode(out.subarray(0, length));
    if (length === -1) {
      const message = new Uint8Array(1024);
      const written = watcher.tarve_last_error(message, message.length) as number;
      throw new Error(`spawn: ${new TextDecoder().decode(message.subarray(0, Math.max(0, written)))}`);
    }
    size = -length;
  }
}

/** A stream whose source arrives later: reads wait for it. */
function laterReadable(source: Promise<ReadableStream<Uint8Array>>): ReadableStream<Uint8Array> {
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      reader ??= (await source).getReader();
      const { done, value } = await reader.read();
      if (done) controller.close();
      else controller.enqueue(value);
    },
    async cancel(reason) {
      await (reader ?? (await source).getReader()).cancel(reason);
    },
  });
}

/** A stream whose sink arrives later: writes wait for it. */
function laterWritable(sink: Promise<WritableStream<Uint8Array>>): WritableStream<Uint8Array> {
  let writer: WritableStreamDefaultWriter<Uint8Array> | undefined;
  const ready = async () => (writer ??= (await sink).getWriter());
  return new WritableStream<Uint8Array>({
    async write(chunk) { await (await ready()).write(chunk); },
    async close() { await (await ready()).close(); },
    async abort(reason) { await (await ready()).abort(reason); },
  });
}

/** Reads the 4-byte exit code the watch pipe carries once the process ended. */
async function exitCode(name: string): Promise<number> {
  const connection = await tjs.connect("pipe", name);
  try {
    const { readable } = await connection.opened;
    const reader = readable.getReader();
    const bytes: number[] = [];
    while (bytes.length < 4) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes.push(...value);
    }
    if (bytes.length < 4) throw new Error("spawn: the process watch ended without an exit code");
    return new DataView(new Uint8Array(bytes.slice(0, 4)).buffer).getUint32(0, true);
  } finally {
    connection.close();
  }
}

/**
 * Starts `command` without a console window. Throws (an ENOENT-style error) when it cannot start,
 * as tjs.spawn does.
 */
export function spawnHiddenWindows(command: string, args: readonly string[], stdio: readonly Stdio[], options: HiddenSpawnOptions): SpawnedProcess {
  const k = (kernel ??= loadKernel());
  const self = Number(k.GetCurrentProcess());
  // The child's ends: inheritable, closed here once it has its own copies.
  const childEnds: number[] = [];
  const pipes: (string | undefined)[] = [];
  try {
    for (let index = 0; index < 3; index++) {
      const mode = stdio[index] ?? "pipe";
      if (mode === "pipe") {
        const name = `\\\\.\\pipe\\tarve-stdio-${tjs.pid}-${++nextPipe}`;
        // Duplex, though each is used one way: libuv opens a one-way pipe's client end read- or
        // write-only, and txiki.js then fails the stream it cannot start (ENOTCONN).
        const handle = Number(k.CreateNamedPipeW(wide(name), PIPE_ACCESS_DUPLEX, PIPE_TYPE_BYTE | PIPE_WAIT | PIPE_REJECT_REMOTE_CLIENTS, 1, PIPE_BUFFER, PIPE_BUFFER, 0, inheritAttributes()));
        if (handle === INVALID_HANDLE || handle === 0) throw new Error(`spawn ${command}: cannot create a pipe (Windows error ${k.GetLastError()})`);
        childEnds.push(handle);
        pipes.push(name);
        continue;
      }
      pipes.push(undefined);
      let handle = 0;
      if (mode === "inherit") {
        const own = Number(k.GetStdHandle(STD_HANDLES[index]!));
        const copy = new Uint8Array(8);
        if (own && own !== INVALID_HANDLE && k.DuplicateHandle(self, own, self, copy, 0, 1, DUPLICATE_SAME_ACCESS)) {
          handle = Number(new DataView(copy.buffer).getBigUint64(0, true));
        }
      }
      // "ignore", or no handle of our own to share (a GUI app has none): the null device.
      if (!handle) {
        handle = Number(k.CreateFileW(wide("NUL"), index === 0 ? GENERIC_READ : GENERIC_WRITE, 3, inheritAttributes(), OPEN_EXISTING, 0, 0));
        if (handle === INVALID_HANDLE || handle === 0) throw new Error(`spawn ${command}: cannot open NUL (Windows error ${k.GetLastError()})`);
      }
      childEnds.push(handle);
    }
    // STARTUPINFOW (104 bytes on x64): cb, dwFlags at 60, wShowWindow at 64, the std handles at 80/88/96.
    const startup = new Uint8Array(104);
    const info = new DataView(startup.buffer);
    info.setUint32(0, 104, true);
    info.setUint32(60, STARTF_USESTDHANDLES | STARTF_USESHOWWINDOW, true);
    info.setUint16(64, SW_HIDE, true);
    childEnds.forEach((handle, index) => info.setBigInt64(80 + index * 8, BigInt(handle), true));
    const processInfo = new Uint8Array(24);
    const env = options.env ?? (globalThis as { process?: { env: Record<string, string | undefined> } }).process?.env ?? tjs.env;
    const block = Object.entries(env).filter(([, value]) => value !== undefined).map(([key, value]) => `${key}=${value}\0`).join("") + "\0";
    const commandLine = [command, ...args].map(quote).join(" ");
    const flags = CREATE_UNICODE_ENVIRONMENT | CREATE_NO_WINDOW | CREATE_SUSPENDED;
    if (!k.CreateProcessW(0, wide(commandLine), 0, 0, 1, flags, wide(block), wide(options.cwd ?? tjs.cwd), startup, processInfo)) {
      throw failure(command, args, k.GetLastError());
    }
    const result = new DataView(processInfo.buffer);
    const process = Number(result.getBigInt64(0, true));
    const thread = Number(result.getBigInt64(8, true));
    const pid = result.getUint32(16, true);
    let watch: string;
    try {
      watch = watchName(process);
    } catch (error) {
      k.TerminateProcess(process, 1);
      k.CloseHandle(thread);
      k.CloseHandle(process);
      throw error;
    }
    // Connect to the child's pipes, then let it run: nothing it writes is lost.
    const connections = pipes.map(name => (name ? tjs.connect("pipe", name) : undefined));
    const opened = Promise.all(connections.map(connection => connection?.then(value => value.opened)));
    let killedWith: string | null = null;
    const started = opened.then(
      () => { k.ResumeThread(thread); k.CloseHandle(thread); },
      error => { k.TerminateProcess(process, 1); k.CloseHandle(thread); throw error; },
    );
    let finished = false;
    const ended = started.then(() => exitCode(watch)).finally(() => {
      finished = true;
      k.CloseHandle(process);
      for (const connection of connections) void connection?.then(value => value.close(), () => {});
    });
    const stream = <T>(index: number, pick: (streams: { readable: ReadableStream<Uint8Array>; writable: WritableStream<Uint8Array> }) => T) => {
      const picked = opened.then(streams => pick(streams[index]!));
      // A stream nobody reads must not report the failed start again: wait() does.
      picked.catch(() => {});
      return picked;
    };
    return {
      pid,
      stdin: pipes[0] ? laterWritable(stream(0, streams => streams.writable)) : undefined,
      stdout: pipes[1] ? laterReadable(stream(1, streams => streams.readable)) : undefined,
      stderr: pipes[2] ? laterReadable(stream(2, streams => streams.readable)) : undefined,
      kill(signal = "SIGTERM") {
        if (finished) throw new Error("kill: the process has exited");
        killedWith = signal;
        if (!k.TerminateProcess(process, 1)) throw new Error(`kill: Windows error ${k.GetLastError()}`);
      },
      wait: () => ended.then(code => ({ exit_status: killedWith ? 0 : code, term_signal: killedWith })),
    };
  } finally {
    for (const handle of childEnds) k.CloseHandle(handle);
  }
}
