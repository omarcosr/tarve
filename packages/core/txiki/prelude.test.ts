import { afterAll, expect, mock, test } from "bun:test";

// prelude.ts runs first in a txiki.js executable and replaces Node globals: stand in for the tjs
// runtime, then put this process's globals back so the other tests keep Bun's.
const names = ["process", "fetch", "Buffer", "setTimeout", "setInterval", "setImmediate", "tjs", "TARVE_TXIKI_PLATFORM", "TARVE_TXIKI_NATIVE_NAME", "__tarveTxikiFfi", "__tarveDirname", "__tarveAssets", "__tarveNativePath"];
const saved = new Map(names.map(name => [name, Object.getOwnPropertyDescriptor(globalThis, name)]));
afterAll(() => {
  for (const [name, descriptor] of saved) {
    if (descriptor) Object.defineProperty(globalThis, name, descriptor);
    else delete (globalThis as Record<string, unknown>)[name];
  }
});

let closes = 0;
const library = { symbols: { f: () => 7 }, close: () => { closes++; } };
mock.module("tjs:ffi", () => ({ dlopen: (path: string) => { if (path === "lib") return library; throw new Error("no ffi in tests"); } }));
mock.module("tjs:hashing", () => ({ createHash: () => { throw new Error("no hashing in tests"); } }));
mock.module("tjs:path", () => ({ default: { dirname: (file: string) => file.replace(/[\\/][^\\/]*$/, ""), join: (...parts: string[]) => parts.join("/") } }));
// An executable without an embedded blob: the trailer is not txiki.js's.
const exe = { read: async (bytes: Uint8Array) => bytes.length, stat: async () => ({ size: 64 }), close: async () => {} };
Object.assign(globalThis, {
  TARVE_TXIKI_PLATFORM: "linux",
  TARVE_TXIKI_NATIVE_NAME: "libtarve.so",
  tjs: { pid: 4242, args: ["/app/App"], env: {}, exePath: "/app/App", version: "26.0.0", engine: { versions: { quickjs: "0.10.0" } }, cwd: "/app", open: async () => exe },
});
const real = saved.get("process")!.value as NodeJS.Process;
await import("./prelude");
const shimmed = (globalThis as unknown as { process: { pid: unknown } }).process;
const txikiFfi = (globalThis as unknown as { __tarveTxikiFfi: { dlopen(path: string, symbols: object): { symbols: { f(): number }; close(): void } } }).__tarveTxikiFfi;
(globalThis as Record<string, unknown>).process = real;

test("txiki.js process.pid is the process id tjs reports", () => {
  expect(shimmed.pid).toBe(4242);
  expect(typeof shimmed.pid).toBe("number");
});

test("txiki.js FFI keeps a library open until close(), once, as Bun and Node.js do", () => {
  const opened = txikiFfi.dlopen("lib", { f: { args: [], returns: "i32" } });
  expect(opened.symbols.f()).toBe(7);
  expect(closes).toBe(0);
  opened.close();
  opened.close();
  expect(closes).toBe(1);
});
