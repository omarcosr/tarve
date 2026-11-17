import { afterAll, describe, expect, test } from "bun:test";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { openPluginLibrary, type FfiSymbols } from "./ffi";

describe("txiki.js FFI arguments", () => {
  // tjs:ffi as the txiki.js prelude exposes it: a fake that records what each call receives.
  const calls: Record<string, unknown[][]> = {};
  const opened: Record<string, { args: string[]; returns: string }>[] = [];
  const created = new Map<string, unknown>();
  const globals = globalThis as Record<string, unknown>;
  const saved = { ffi: globals.__tarveTxikiFfi, tjs: globals.tjs };
  globals.__tarveTxikiFfi = {
    dlopen(_path: string, definitions: Record<string, { args: string[]; returns: string }>) {
      opened.push(definitions);
      const symbols = Object.fromEntries(Object.keys(definitions).map(name => {
        const record = function (...args: unknown[]) { (calls[name] ??= []).push(args); return 0; };
        created.set(name, record);
        return [name, record];
      }));
      return { symbols, close() {} };
    },
  };
  globals.tjs = { version: "26.0.0" };
  afterAll(() => {
    globals.__tarveTxikiFfi = saved.ffi;
    if (saved.tjs === undefined) delete globals.tjs;
    else globals.tjs = saved.tjs;
  });
  const open = <const S extends FfiSymbols>(symbols: S) => openPluginLibrary("fake", symbols).symbols;

  test("i64, u64 and ptr pass as numbers, null as 0; other arguments pass untouched", () => {
    const message = new Uint8Array(8);
    const { Peek } = open({ Peek: { args: ["buffer", "ptr", "u32", "u32", "u32"], returns: "i32" } });
    Peek(message, null, 0, 0, 1);
    Peek(message, 5n, 1, 2, 3);
    Peek(message, 7, 1, 2, 3);
    expect(calls.Peek).toEqual([[message, 0, 0, 0, 1], [message, 5, 1, 2, 3], [message, 7, 1, 2, 3]]);
    expect(opened.at(-1)).toEqual({ Peek: { args: ["buffer", "u64", "u32", "u32", "u32"], returns: "i32" } });
  });

  test("every arity converts the same positions", () => {
    for (let arity = 1; arity <= 8; arity++) {
      const name = `f${arity}`;
      const args = Array.from({ length: arity }, (_, index) => index % 2 ? "i32" : "u64") as ("u64" | "i32")[];
      const functions = open({ [name]: { args } }) as Record<string, (...values: unknown[]) => unknown>;
      functions[name]!(...args.map((type, index) => type === "u64" ? BigInt(index) : index));
      expect(calls[name]).toEqual([args.map((_, index) => index)]);
    }
  });

  test("functions without 64-bit or address arguments are tjs:ffi's own", () => {
    const { Status } = open({ Status: { args: ["u32"], returns: "u32" } });
    Status(0x4ff);
    expect(Status).toBe(created.get("Status") as typeof Status);
  });

  test("BigInt beyond 53 bits is a RangeError", () => {
    const { Wide } = open({ Wide: { args: ["i32", "i64"] } });
    expect(() => Wide(1, 2n ** 60n)).toThrow(RangeError);
  });

  test("a missing 64-bit or address argument is a TypeError, not 0", () => {
    const { Wide } = open({ Wide: { args: ["i32", "ptr"] } });
    expect(() => (Wide as (...values: unknown[]) => unknown)(1)).toThrow(TypeError);
  });
});

// Node.js's node:ffi takes 64-bit integers only as BigInt: loadLibrary declares that numbers work too.
const node = Bun.which("node");
const nodeVersion = node ? Bun.spawnSync([node, "--version"]).stdout.toString().trim().slice(1).split(".").map(Number) : [];
const hasNodeFfi = (nodeVersion[0] ?? 0) > 26 || (nodeVersion[0] === 26 && (nodeVersion[1] ?? 0) >= 10);
test.skipIf(!hasNodeFfi)("Node.js FFI takes numbers and BigInt for i64 and ptr arguments", () => {
  const source = `
    const { openPluginLibrary } = await import(${JSON.stringify(pathToFileURL(join(import.meta.dir, "ffi.ts")).href)});
    const c = openPluginLibrary(process.platform === "win32" ? "ucrtbase.dll" : "libc.so.6", {
      llabs: { args: ["i64"], returns: "i64" },
      memchr: { args: ["ptr", "i32", "u64"], returns: "ptr" },
    });
    console.log(JSON.stringify([c.symbols.llabs(-5), c.symbols.llabs(-6n), c.symbols.memchr(null, 0, 0), c.symbols.memchr(0, 0, 0n)].map(String)));
    c.close();`;
  const result = Bun.spawnSync([node!, "--no-warnings", "--input-type=module", "-e", source]);
  expect(result.stderr.toString()).toBe("");
  expect(JSON.parse(result.stdout.toString())).toEqual(["5", "6", "0", "0"]);
});
