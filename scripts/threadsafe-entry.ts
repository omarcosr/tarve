// Runs under Bun, as a Node.js executable and as a txiki.js executable (smoke-threadsafe.ts):
// threadsafeCallback and threadsafeComObject called from system threads, the same answers everywhere.
import { writeFileSync } from "node:fs";
import { openPluginLibrary } from "../packages/core/src/plugins/ffi";
import { pointerFunction } from "../packages/core/src/plugins/pointer";
import { onSystemMediaSessionsChange, systemMediaSessions } from "../packages/core/src/media-sessions";
import { guidBytes, threadsafeCallback, threadsafeComObject } from "../packages/core/src/threadsafe";

/** Starts a system thread at `start` with `parameter` (CreateThread / pthread_create). */
function startThread(start: bigint, parameter: bigint): void {
  if (process.platform === "win32") {
    const kernel32 = openPluginLibrary("kernel32.dll", {
      CreateThread: { args: ["ptr", "u64", "ptr", "ptr", "u32", "ptr"], returns: "ptr" },
      CloseHandle: { args: ["ptr"], returns: "i32" },
    });
    kernel32.symbols.CloseHandle(kernel32.symbols.CreateThread(0n, 0n, start, parameter, 0, 0n));
    return;
  }
  const libc = openPluginLibrary("libc.so.6", {
    pthread_create: { args: ["buffer", "ptr", "ptr", "ptr"], returns: "i32" },
    pthread_detach: { args: ["u64"], returns: "i32" },
  });
  const thread = new Uint8Array(8);
  if (libc.symbols.pthread_create(thread, 0n, start, parameter) !== 0) throw new Error("pthread_create failed");
  libc.symbols.pthread_detach(new DataView(thread.buffer).getBigUint64(0, true));
}

const until = async (done: () => boolean) => {
  for (let tries = 0; tries < 300 && !done(); tries++) await new Promise(resolve => setTimeout(resolve, 10));
};
const show = (values: unknown[]) => values.map(value => typeof value === "bigint" ? `${value}n` : value instanceof Uint8Array ? [...value] : value);

const results: Record<string, unknown> = {};
const threaded: unknown[][] = [];
const fromThreads = threadsafeCallback((...args) => { threaded.push(args); }, { args: ["u64"] });
for (const value of [1n, 2n, 3n]) startThread(fromThreads.pointer, value);
await until(() => threaded.length === 3);
fromThreads.close();
results["from threads"] = threaded.map(args => show(args)).sort();

const direct: unknown[][] = [];
const typed = threadsafeCallback((...args) => { direct.push(args); }, { args: ["i32", "bool", "ptr", "u8"], returns: -2147467259, copy: { arg: 2, bytes: 3 } });
const data = new Uint8Array([7, 8, 9, 10]);
results["returns at once"] = pointerFunction(typed.pointer, { args: ["i32", "bool", "buffer", "u32"], returns: "i32" })(-5, true, data, 0x1ff);
data.fill(0);
results["nothing ran yet"] = direct.length;
await until(() => direct.length > 0);
typed.close();
results["decoded and copied"] = direct.map(args => show(args));
results["closed returns"] = pointerFunction(typed.pointer, { args: [], returns: "i32" })();

const iid = "{657804FA-D6AD-4496-8A60-352752AF4F89}";
const method = threadsafeCallback((...args) => { direct.push(args); }, { args: ["ptr", "u32"] });
const sink = threadsafeComObject({ iids: [iid], methods: [method] });
const memcpyAddress = (() => {
  const text = (value: string) => new TextEncoder().encode(`${value}\0`);
  if (process.platform === "win32") {
    const kernel32 = openPluginLibrary("kernel32.dll", { LoadLibraryA: { args: ["buffer"], returns: "ptr" }, GetProcAddress: { args: ["ptr", "buffer"], returns: "ptr" } });
    return BigInt(kernel32.symbols.GetProcAddress(kernel32.symbols.LoadLibraryA(text("ucrtbase.dll")), text("memcpy")));
  }
  const libc = openPluginLibrary("libc.so.6", { dlopen: { args: ["buffer", "i32"], returns: "ptr" }, dlsym: { args: ["ptr", "buffer"], returns: "ptr" } });
  return BigInt(libc.symbols.dlsym(libc.symbols.dlopen(text("libc.so.6"), 2), text("memcpy")));
})();
const memcpy = pointerFunction(memcpyAddress, { args: ["buffer", "ptr", "u64"], returns: "ptr" });
// Uint8Arrays: txiki.js's FFI passes no other typed array by address.
const word = (bytes: Uint8Array, index: number) => new DataView(bytes.buffer).getBigUint64(index * 8, true);
const vtable = new Uint8Array(8);
memcpy(vtable, sink.pointer, 8);
const table = new Uint8Array(32);
memcpy(table, word(vtable, 0), 32);
const entries = [0, 1, 2, 3].map(index => word(table, index));
const out = new Uint8Array(8);
const queryInterface = pointerFunction(entries[0]!, { args: ["ptr", "buffer", "buffer"], returns: "i32" });
results["QueryInterface"] = [queryInterface(sink.pointer, guidBytes(iid), out), word(out, 0) === sink.pointer, queryInterface(sink.pointer, guidBytes("{00000000-0000-0000-0000-000000000001}"), out) >>> 0];
results["Release"] = pointerFunction(entries[2]!, { args: ["ptr"], returns: "u32" })(sink.pointer);
direct.length = 0;
startThread(entries[3]!, sink.pointer);
await until(() => direct.length > 0);
results["COM method from a thread"] = direct.length === 1 && direct[0]![0] === sink.pointer;
sink.release();
method.close();

// Media session events (Windows): the first list arrives, systemMediaSessions reads the same one,
// and the last unsubscribe lets the process exit.
if (process.platform === "win32") {
  const lists: unknown[] = [];
  const stop = onSystemMediaSessionsChange(sessions => lists.push(sessions));
  await until(() => lists.length > 0);
  const read = await systemMediaSessions();
  stop();
  results["media sessions watch"] = [Array.isArray(lists[0]), JSON.stringify(read) === JSON.stringify(lists.at(-1))];
}

writeFileSync(process.argv.at(-1)!, JSON.stringify(results));
