// Runs under Bun, as a Node.js executable and as a txiki.js executable (bench-ffi.ts): the cost of
// one FFI call through Tarve's loadLibrary (openPluginLibrary) and through the runtime's own FFI
// with the same declarations, to separate the runtime's cost from Tarve's wrapper.
import { writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { detectFfi, openPluginLibrary, type FfiSymbols, type FfiType } from "../packages/core/src/plugins/ffi";

const CALLS = Number(process.env.TARVE_BENCH_FFI_CALLS) || 100_000;
const ROUNDS = 5;
const QS_ALLINPUT = 0x04ff;
const PM_REMOVE = 1;
const windows = process.platform === "win32";

// Windows: what a message pump polls each tick. Linux: libc calls of the same shapes.
const library = windows ? "user32.dll" : "libc.so.6";
const kernel = windows ? "kernel32.dll" : "libc.so.6";
const pidName = windows ? "GetCurrentProcessId" : "getpid";
const symbols = (windows
  ? { GetQueueStatus: { args: ["u32"], returns: "u32" }, PeekMessageW: { args: ["buffer", "ptr", "u32", "u32", "u32"], returns: "i32" } }
  : { abs: { args: ["i32"], returns: "i32" }, memchr: { args: ["buffer", "i32", "u64"], returns: "ptr" } }) as FfiSymbols;
const pidSymbols = { [pidName]: { args: [], returns: windows ? "u32" : "i32" } } as FfiSymbols;
const [queue, peek] = Object.keys(symbols) as [string, string];
const message = new Uint8Array(48);

type Call = (...args: unknown[]) => unknown;
type Functions = Record<string, Call>;

/** Best ns/call of ROUNDS timed loops of CALLS calls (after a warm-up round). */
function measure(loop: (calls: number) => void, perCall = 1): number {
  loop(Math.min(CALLS, 10_000));
  let best = Infinity;
  for (let round = 0; round < ROUNDS; round++) {
    const start = performance.now();
    loop(CALLS);
    best = Math.min(best, (performance.now() - start) * 1e6 / CALLS / perCall);
  }
  return Math.round(best * 10) / 10;
}

function cases(pid: Functions, calls: Functions, hwnd: unknown): Record<string, number> {
  const getPid = pid[pidName]!;
  const status = calls[queue]!;
  const poll = calls[peek]!;
  const pollArgs = windows ? [message, hwnd, 0, 0, PM_REMOVE] : [message, 0x2a, message.length];
  const statusArg = windows ? QS_ALLINPUT : -7;
  const [a, b, c, d, e] = pollArgs;
  return {
    [`${pidName}()`]: measure(n => { for (let i = 0; i < n; i++) getPid(); }),
    [`${queue}(u32)`]: measure(n => { for (let i = 0; i < n; i++) status(statusArg); }),
    [`${peek}(${windows ? "buffer, ptr, u32, u32, u32" : "buffer, i32, u64"})`]: measure(n => { for (let i = 0; i < n; i++) poll(a, b, c, d, e); }),
    // A tick: one status query and five polls, reported per tick.
    "tick (1 + 5 calls)": measure(n => {
      for (let i = 0; i < n; i++) {
        status(statusArg);
        poll(a, b, c, d, e); poll(a, b, c, d, e); poll(a, b, c, d, e); poll(a, b, c, d, e); poll(a, b, c, d, e);
      }
    }),
  };
}

/** The runtime's own FFI, declared the way openPluginLibrary declares it there. */
function raw(path: string, declared: FfiSymbols): { functions: Functions; close(): void } {
  const backend = detectFfi().backend;
  const require = createRequire(import.meta.url);
  if (backend === "node") {
    const NODE: Record<FfiType, string> = { void: "void", bool: "bool", i8: "int8", u8: "uint8", i16: "int16", u16: "uint16", i32: "int32", u32: "uint32", i64: "int64", u64: "uint64", f32: "float", f64: "double", ptr: "pointer", buffer: "buffer" };
    const ffi = require("node:ffi") as { dlopen(path: string, definitions: unknown): { functions: Functions; lib: { close(): void } } };
    const library = ffi.dlopen(path, Object.fromEntries(Object.entries(declared).map(([name, symbol]) => [name, { arguments: symbol.args.map(type => NODE[type]), return: NODE[symbol.returns ?? "void"] }])));
    return { functions: library.functions, close: () => library.lib.close() };
  }
  const txiki = backend === "txiki";
  const ffi = (txiki ? (globalThis as unknown as { __tarveTxikiFfi: unknown }).__tarveTxikiFfi : require("bun:ffi")) as { dlopen(path: string, symbols: unknown): { symbols: Functions; close(): void } };
  const type = (value: FfiType) => txiki && value === "ptr" ? "u64" : value;
  const library = ffi.dlopen(path, Object.fromEntries(Object.entries(declared).map(([name, symbol]) => [name, { args: symbol.args.map(type), returns: type(symbol.returns ?? "void") }])));
  return { functions: library.symbols, close: () => library.close() };
}

const tarvePid = openPluginLibrary(kernel, pidSymbols);
const tarveCalls = openPluginLibrary(library, symbols);
const rawPid = raw(kernel, pidSymbols);
const rawCalls = raw(library, symbols);
const report = {
  runtime: tarveCalls.ffi,
  calls: CALLS,
  // Same answers both ways, so both paths call the same thing.
  pid: [(tarvePid.symbols as Functions)[pidName]!(), rawPid.functions[pidName]!(), process.pid],
  "ns/call": {
    // No window: `null` as an app passes it to loadLibrary; the raw tjs:ffi `u64` takes only a number.
    tarve: cases(tarvePid.symbols as Functions, tarveCalls.symbols as Functions, null),
    raw: cases(rawPid.functions, rawCalls.functions, tarveCalls.ffi === "txiki" ? 0 : null),
  },
};
tarvePid.close();
tarveCalls.close();
rawPid.close();
rawCalls.close();
const out = process.argv[2];
if (out) writeFileSync(out, JSON.stringify(report));
else console.log(JSON.stringify(report, null, 2));
