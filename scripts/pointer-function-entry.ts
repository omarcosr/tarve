// Runs under Bun, as a Node.js executable and as a txiki.js executable (smoke-pointer-function.ts):
// pointerFunction calls the C runtime by address, and every runtime must give the same answers.
import { writeFileSync } from "node:fs";
import { openPluginLibrary, PluginFfiUnsupportedError } from "../packages/core/src/plugins/ffi";
import { pointerFunction } from "../packages/core/src/plugins/pointer";

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
  const libc = openPluginLibrary("libc.so.6", {
    dlopen: { args: ["buffer", "i32"], returns: "ptr" },
    dlsym: { args: ["ptr", "buffer"], returns: "ptr" },
  });
  try {
    return BigInt(libc.symbols.dlsym(libc.symbols.dlopen(text(library === "m" ? "libm.so.6" : "libc.so.6"), 2), text(name)));
  } finally {
    libc.close();
  }
}

const results: Record<string, unknown> = {};
const check = (name: string, run: () => unknown) => {
  try {
    const value = run();
    results[name] = typeof value === "bigint" ? `${value}n` : value;
  } catch (error) {
    results[name] = `${(error as Error).name}`;
  }
};

const llabs = pointerFunction(address("c", "llabs"), { args: ["i64"], returns: "i64" });
check("i64", () => llabs(-(2n ** 62n)));
check("i64 from number", () => llabs(-5));
const ldexp = pointerFunction(address("m", "ldexp"), { args: ["f64", "i32"], returns: "f64" });
check("f64, i32", () => ldexp(1.5, 4));
const sqrtf = pointerFunction(address("m", "sqrtf"), { args: ["f32"], returns: "f32" });
check("f32", () => sqrtf(2.25));
const memset = pointerFunction(address("c", "memset"), { args: ["buffer", "i32", "u64"], returns: "ptr" });
check("buffer", () => {
  const bytes = new Uint8Array(6);
  const start = memset(bytes.subarray(1), 0x2a, 4n);
  return [typeof start, ...bytes];
});
const memcmp = pointerFunction(address("c", "memcmp"), { args: ["buffer", "buffer", "u64"], returns: "i32" });
check("two buffers", () => [memcmp(text("abc"), text("abd"), 2), Math.sign(memcmp(text("abc"), text("abd"), 3))]);
const strlen = address("c", "strlen");
check("u64 return", () => pointerFunction(strlen, { args: ["buffer"], returns: "u64" })(text("tarve")));
check("null address", () => pointerFunction(0, { args: [] }));
check("five buffers", () => pointerFunction(strlen, { args: ["buffer", "buffer", "buffer", "buffer", "buffer"] }));
check("17 arguments", () => pointerFunction(strlen, { args: Array(17).fill("ptr") }));
check("unsupported is typed", () => {
  try {
    pointerFunction(strlen, { args: Array(17).fill("ptr") });
    return false;
  } catch (error) {
    return error instanceof PluginFfiUnsupportedError;
  }
});

writeFileSync(process.argv.at(-1)!, JSON.stringify(results));
