import { describe, expect, test } from "bun:test";
import { nativePath } from "./bridge/runtime";
import { openPluginLibrary } from "./plugins/ffi";
import { pointerFunction } from "./plugins/pointer";
import { guidBytes, releaseCom, threadsafeCallback, threadsafeComObject } from "./threadsafe";

// Calls through Tarve's native library (native/src/threadsafe.rs): skipped before a native build,
// as pointer.test.ts is.
const hasNative = (() => { try { nativePath(); return true; } catch { return false; } })();

/** Starts a system thread at `start` with `parameter` (CreateThread / pthread_create). */
function startThread(start: bigint, parameter: bigint): void {
  if (process.platform === "win32") {
    const kernel32 = openPluginLibrary("kernel32.dll", {
      CreateThread: { args: ["ptr", "u64", "ptr", "ptr", "u32", "ptr"], returns: "ptr" },
      CloseHandle: { args: ["ptr"], returns: "i32" },
    });
    const handle = kernel32.symbols.CreateThread(0, 0, start, parameter, 0, 0);
    expect(BigInt(handle)).not.toBe(0n);
    kernel32.symbols.CloseHandle(handle);
    return;
  }
  const libc = openPluginLibrary(process.platform === "darwin" ? "libSystem.B.dylib" : "libc.so.6", {
    pthread_create: { args: ["buffer", "ptr", "ptr", "ptr"], returns: "i32" },
    pthread_detach: { args: ["u64"], returns: "i32" },
  });
  const thread = new BigUint64Array(1);
  expect(libc.symbols.pthread_create(thread, 0, start, parameter)).toBe(0);
  libc.symbols.pthread_detach(thread[0]!);
}

const until = async (done: () => boolean) => {
  for (let tries = 0; tries < 200 && !done(); tries++) await new Promise(resolve => setTimeout(resolve, 10));
};

describe("guidBytes", () => {
  test("lays a GUID out as Windows' GUID struct", () => {
    expect([...guidBytes("{94EA2B94-E9CC-49E0-C0FF-EE64CA8F5B90}")]).toEqual([0x94, 0x2B, 0xEA, 0x94, 0xCC, 0xE9, 0xE0, 0x49, 0xC0, 0xFF, 0xEE, 0x64, 0xCA, 0x8F, 0x5B, 0x90]);
    expect(() => guidBytes("nope")).toThrow(TypeError);
  });
});

describe.skipIf(!hasNative)("threadsafeCallback", () => {
  test("a call from another thread runs on the JavaScript thread with its arguments", async () => {
    const calls: unknown[][] = [];
    const callback = threadsafeCallback((...args) => { calls.push(args); }, { args: ["u64"], returns: 0 });
    try {
      startThread(callback.pointer, 0x1234_5678_9an);
      await until(() => calls.length > 0);
      expect(calls).toEqual([[0x1234_5678_9an]]);
    } finally {
      callback.close();
    }
  });

  test("returns its fixed value at once, decodes types and copies pointed-to bytes", async () => {
    const calls: unknown[][] = [];
    const callback = threadsafeCallback((...args) => { calls.push(args); }, {
      args: ["i32", "bool", "ptr", "u8"],
      returns: -2147467259,
      copy: { arg: 2, bytes: 3 },
    });
    try {
      const data = new Uint8Array([7, 8, 9, 10]);
      const call = pointerFunction(callback.pointer, { args: ["i32", "bool", "buffer", "u32"], returns: "i32" });
      expect(call(-5, true, data, 0x1ff)).toBe(-2147467259);
      data.fill(0);
      expect(calls).toEqual([]);
      await until(() => calls.length > 0);
      expect(calls).toEqual([[-5, true, new Uint8Array([7, 8, 9]), 0xff]]);
    } finally {
      callback.close();
    }
    expect(callback.closed).toBe(true);
  });

  test("a closed callback's address stays callable and delivers nothing", async () => {
    let calls = 0;
    const callback = threadsafeCallback(() => { calls++; }, { returns: 3 });
    callback.close();
    expect(pointerFunction(callback.pointer, { args: [], returns: "i32" })()).toBe(3);
    await new Promise(resolve => setTimeout(resolve, 30));
    expect(calls).toBe(0);
  });

  test("refuses what it cannot record", () => {
    expect(() => threadsafeCallback(() => {}, { args: Array(7).fill("u32") })).toThrow(RangeError);
    expect(() => threadsafeCallback(() => {}, { args: ["f64" as never] })).toThrow(TypeError);
    expect(() => threadsafeCallback(() => {}, { args: ["u32"], copy: { arg: 0, bytes: 4 } })).toThrow(RangeError);
  });

  test("a COM object answers QueryInterface natively and forwards its methods", async () => {
    const calls: unknown[][] = [];
    const method = threadsafeCallback((...args) => { calls.push(args); }, { args: ["ptr", "u32"] });
    const iid = "{657804FA-D6AD-4496-8A60-352752AF4F89}";
    const sink = threadsafeComObject({ iids: [iid], methods: [method] });
    try {
      const vtable = new BigUint64Array(1);
      // vtable[0..3] = QueryInterface, AddRef, Release, the method: read the vtable address first.
      const memcpy = pointerFunction(memcpyAddress(), { args: ["buffer", "ptr", "u64"], returns: "ptr" });
      memcpy(vtable, sink.pointer, 8);
      const entries = new BigUint64Array(4);
      memcpy(entries, vtable[0]!, 32);
      const out = new BigUint64Array(1);
      const queryInterface = pointerFunction(entries[0]!, { args: ["ptr", "buffer", "buffer"], returns: "i32" });
      expect(queryInterface(sink.pointer, guidBytes(iid), out)).toBe(0);
      expect(out[0]).toBe(sink.pointer);
      expect(queryInterface(sink.pointer, guidBytes("{00000000-0000-0000-0000-000000000001}"), out) >>> 0).toBe(0x80004002);
      const release = pointerFunction(entries[2]!, { args: ["ptr"], returns: "u32" });
      expect(release(sink.pointer)).toBe(1);
      pointerFunction(entries[3]!, { args: ["ptr", "u32"], returns: "i32" })(sink.pointer, 9);
      await until(() => calls.length > 0);
      expect(calls).toEqual([[sink.pointer, 9]]);
    } finally {
      sink.release();
      method.close();
    }
  });

  test("keeps COM arguments and copies byte arguments per argument", async () => {
    const calls: unknown[][] = [];
    const callback = threadsafeCallback((...args) => { calls.push(args); }, {
      args: ["u32", { type: "ptr", keep: "com" }, { type: "ptr", copy: 2 }, { type: "ptr", keep: "com" }],
      returns: 7,
    });
    const sender = threadsafeComObject({ iids: [], methods: [1n] });
    try {
      const call = pointerFunction(callback.pointer, { args: ["u32", "ptr", "buffer", "ptr"], returns: "i32" });
      expect(call(4, sender.pointer, new Uint8Array([5, 6, 7]), 0n)).toBe(7);
      expect(refCount(sender.pointer)).toBe(2);
      await until(() => calls.length > 0);
      expect(calls).toEqual([[4, sender.pointer, new Uint8Array([5, 6]), null]]);
      expect(releaseCom(calls[0]![1] as bigint)).toBe(1);
      expect(releaseCom(null)).toBe(0);
    } finally {
      sender.release();
      callback.close();
    }
  });

  test.skipIf(process.platform !== "win32")("copies a BSTR and VARIANTs before the caller frees them", async () => {
    const oleaut32 = openPluginLibrary("oleaut32.dll", {
      SysAllocString: { args: ["buffer"], returns: "ptr" },
      SysFreeString: { args: ["ptr"], returns: "void" },
    });
    const text = "Olá, barra 😀";
    const utf16 = new Uint8Array((text.length + 1) * 2);
    for (let index = 0; index < text.length; index++) new DataView(utf16.buffer).setUint16(index * 2, text.charCodeAt(index), true);
    const bstr = BigInt(oleaut32.symbols.SysAllocString(utf16));
    const variant = (vt: number, value: bigint) => {
      const bytes = new Uint8Array(24);
      new DataView(bytes.buffer).setUint16(0, vt, true);
      new DataView(bytes.buffer).setBigUint64(8, value, true);
      return bytes;
    };
    const calls: unknown[][] = [];
    const callback = threadsafeCallback((...args) => { calls.push(args); }, {
      args: [{ type: "ptr", copy: "bstr" }, { type: "ptr", copy: "variant" }, { type: "ptr", copy: "variant" }, { type: "ptr", copy: "variant" }, { type: "ptr", copy: "variant" }],
    });
    const unknown = threadsafeComObject({ iids: [], methods: [1n] });
    try {
      const call = pointerFunction(callback.pointer, { args: ["ptr", "buffer", "buffer", "buffer", "buffer"], returns: "i32" });
      call(bstr, variant(8, bstr), variant(3, 0xfffffffbn), variant(11, 0xffffn), variant(13, unknown.pointer));
      oleaut32.symbols.SysFreeString(bstr);
      const date = variant(7, 0x4004000000000000n);
      call(0n, date, variant(0, 0n), variant(5, 0x4004000000000000n), variant(9, 0n));
      await until(() => calls.length > 1);
      expect(calls).toEqual([[text, text, -5, true, unknown.pointer], [null, date, null, 2.5, null]]);
      expect(releaseCom(calls[0]![4] as bigint)).toBe(1);
    } finally {
      unknown.release();
      callback.close();
      oleaut32.close();
    }
  });

  test("refuses bad argument specs", () => {
    expect(() => threadsafeCallback(() => {}, { args: [{ type: "ptr", keep: "nope" } as never] })).toThrow(TypeError);
    expect(() => threadsafeCallback(() => {}, { args: [{ type: "ptr", copy: 0 }] })).toThrow(RangeError);
    expect(() => threadsafeCallback(() => {}, { args: [{ type: "u32", keep: "com" } as never] })).toThrow(TypeError);
    expect(() => threadsafeCallback(() => {}, { args: [{ type: "ptr", keep: "com" }], copy: { arg: 0, bytes: 4 } })).toThrow(RangeError);
    if (process.platform !== "win32") {
      expect(() => threadsafeCallback(() => {}, { args: [{ type: "ptr", copy: "bstr" }] })).toThrow("only available on Windows");
    }
  });
});

/** An object's reference count: AddRef then Release through its vtable. */
function refCount(object: bigint): number {
  const memcpy = pointerFunction(memcpyAddress(), { args: ["buffer", "ptr", "u64"], returns: "ptr" });
  const vtable = new BigUint64Array(1);
  memcpy(vtable, object, 8);
  const entries = new BigUint64Array(3);
  memcpy(entries, vtable[0]!, 24);
  pointerFunction(entries[1]!, { args: ["ptr"], returns: "u32" })(object);
  return pointerFunction(entries[2]!, { args: ["ptr"], returns: "u32" })(object) as number;
}

function memcpyAddress(): bigint {
  const text = (value: string) => new TextEncoder().encode(`${value}\0`);
  if (process.platform === "win32") {
    const kernel32 = openPluginLibrary("kernel32.dll", {
      LoadLibraryA: { args: ["buffer"], returns: "ptr" },
      GetProcAddress: { args: ["ptr", "buffer"], returns: "ptr" },
    });
    try {
      return BigInt(kernel32.symbols.GetProcAddress(kernel32.symbols.LoadLibraryA(text("ucrtbase.dll")), text("memcpy")));
    } finally {
      kernel32.close();
    }
  }
  const libdl = openPluginLibrary(process.platform === "darwin" ? "libSystem.B.dylib" : "libc.so.6", {
    dlopen: { args: ["buffer", "i32"], returns: "ptr" },
    dlsym: { args: ["ptr", "buffer"], returns: "ptr" },
  });
  try {
    return BigInt(libdl.symbols.dlsym(libdl.symbols.dlopen(text(process.platform === "darwin" ? "libSystem.B.dylib" : "libc.so.6"), 2), text("memcpy")));
  } finally {
    libdl.close();
  }
}
