import { describe, expect, test } from "bun:test";
import { openPluginLibrary, PluginFfiUnsupportedError } from "./ffi";
import { MAX_POINTER_BUFFERS, pointerFunction } from "./pointer";

const text = (value: string) => new TextEncoder().encode(`${value}\0`);

/** C runtime functions by address, the way GetProcAddress, dlsym and COM vtables hand them out. */
function address(library: "c" | "m", name: string): bigint {
  if (process.platform === "win32") {
    const kernel32 = openPluginLibrary("kernel32.dll", {
      LoadLibraryA: { args: ["buffer"], returns: "ptr" },
      GetProcAddress: { args: ["ptr", "buffer"], returns: "ptr" },
    });
    try {
      return BigInt(kernel32.symbols.GetProcAddress(kernel32.symbols.LoadLibraryA(text("ucrtbase.dll")), text(name)));
    } finally {
      kernel32.close();
    }
  }
  const file = process.platform === "darwin" ? "libSystem.B.dylib" : library === "m" ? "libm.so.6" : "libc.so.6";
  const libdl = openPluginLibrary(process.platform === "darwin" ? "libSystem.B.dylib" : "libc.so.6", {
    dlopen: { args: ["buffer", "i32"], returns: "ptr" },
    dlsym: { args: ["ptr", "buffer"], returns: "ptr" },
  });
  try {
    return BigInt(libdl.symbols.dlsym(libdl.symbols.dlopen(text(file), 2), text(name)));
  } finally {
    libdl.close();
  }
}

describe("pointerFunction", () => {
  test("calls integer, 64-bit and floating-point signatures by address", () => {
    const llabs = pointerFunction(address("c", "llabs"), { args: ["i64"], returns: "i64" });
    expect(llabs(-5)).toBe(5n);
    expect(llabs(-(2n ** 62n))).toBe(2n ** 62n);
    const ldexp = pointerFunction(address("m", "ldexp"), { args: ["f64", "i32"], returns: "f64" });
    expect(ldexp(1.5, 4)).toBe(24);
    const sqrtf = pointerFunction(address("m", "sqrtf"), { args: ["f32"], returns: "f32" });
    expect(sqrtf(2.25)).toBe(1.5);
  });

  test("passes buffers by address and returns pointers as BigInt", () => {
    const bytes = new Uint8Array(6);
    const memset = pointerFunction(address("c", "memset"), { args: ["buffer", "i32", "u64"], returns: "ptr" });
    const start = memset(bytes.subarray(1), 0x2a, 4n);
    expect(typeof start).toBe("bigint");
    expect([...bytes]).toEqual([0, 0x2a, 0x2a, 0x2a, 0x2a, 0]);
    const strlen = pointerFunction(address("c", "strlen"), { args: ["buffer"], returns: "u64" });
    expect(strlen(text("tarve"))).toBe(5n);
    const memcmp = pointerFunction(address("c", "memcmp"), { args: ["buffer", "buffer", "u64"], returns: "i32" });
    expect(memcmp(text("abc"), text("abd"), 2)).toBe(0);
    expect(Math.sign(memcmp(text("abc"), text("abd"), 3))).toBe(-1);
  });

  test("refuses what it cannot call before the first call", () => {
    const strlen = address("c", "strlen");
    expect(() => pointerFunction(0, { args: [] })).toThrow(TypeError);
    expect(() => pointerFunction(-1, { args: [] })).toThrow(TypeError);
    expect(() => pointerFunction(strlen, { args: ["string" as never] })).toThrow(TypeError);
    expect(() => pointerFunction(strlen, { args: Array(MAX_POINTER_BUFFERS + 1).fill("buffer") })).toThrow(PluginFfiUnsupportedError);
    expect(() => pointerFunction(strlen, { args: Array(17).fill("ptr") })).toThrow(PluginFfiUnsupportedError);
    const call = pointerFunction(strlen, { args: ["buffer"], returns: "u64" });
    expect(() => call(1 as never)).toThrow(TypeError);
  });
});
