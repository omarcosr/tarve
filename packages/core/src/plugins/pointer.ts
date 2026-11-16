// `pointerFunction`: calls a C function by its address (COM and vtable methods, functions exported by
// ordinal, callbacks a library hands out) the same way on Bun, Node.js, txiki.js and Android's QuickJS.
// bun:ffi, node:ffi and tjs:ffi bind functions by name only (Bun's CFunction aside), so every runtime
// calls through Tarve's own library: `tarve_ffi_call` (native/src/bridge/entry_points.rs) picks a
// prototype fixed at compile time (native/src/foreign_call.rs). No libffi, no executable memory, no
// generated code. One frame per bound function carries the address, the signature and the arguments.
import { ownLibraryPath } from "../bridge/binding";
import { openPluginLibrary, PluginFfiUnsupportedError, validateSymbols, type ArgValues, type FfiSymbol, type FfiSymbols, type FfiType, type PluginLibrary } from "./ffi";

/** crate::foreign_call::Kind::from_code. */
const KIND_CODES: Record<FfiType, number> = {
  void: 0, bool: 1, i8: 2, u8: 3, i16: 4, u16: 5, i32: 6, u32: 7, i64: 8, u64: 9, f32: 10, f64: 11, ptr: 12, buffer: 13,
};
/** Address, result, return kind, argument count. */
const HEADER = 24;
const NULL_BUFFER = 0xffff_ffff_ffff_ffffn;
const UNSUPPORTED = -2;
const NULL_FUNCTION = -3;

/** Buffer arguments one pointer function may declare (`tarve_ffi_call` takes four); pass more memory as `ptr`. */
export const MAX_POINTER_BUFFERS = 4;

/** What a pointer function returns: 64-bit integers and addresses always as BigInt. */
export type PointerReturnValue<T> =
  T extends "void" | undefined ? void :
  T extends "bool" ? boolean :
  T extends "i64" | "u64" | "ptr" ? bigint :
  number;

/** A C function bound to its address by `pointerFunction`. */
export type PointerFunction<S extends FfiSymbol> = (...args: ArgValues<S["args"]>) => PointerReturnValue<S["returns"]>;

const OWN_SYMBOLS = {
  tarve_ffi_check: { args: ["buffer"], returns: "i32" },
  tarve_ffi_call: { args: ["buffer", "buffer", "buffer", "buffer", "buffer"], returns: "i32" },
} as const satisfies FfiSymbols;

/**
 * Tarve's library as opened for `tarve_ffi_*`, kept for the process: the library object itself, not
 * only its symbols, since txiki.js unloads a library whose handle is collected.
 */
let own: PluginLibrary<typeof OWN_SYMBOLS> | undefined;

/** Tarve's `tarve_ffi_*` entry points, bound once with the runtime's FFI. */
function ownFfi(): PluginLibrary<typeof OWN_SYMBOLS>["symbols"] {
  own ??= openPluginLibrary(ownLibraryPath("pointerFunction"), OWN_SYMBOLS, "pointerFunction");
  return own.symbols;
}

/** The calling convention's limits, for the error a refused signature gets. */
function platformLimits(): string {
  if (process.arch === "x64" && process.platform === "win32") return "Windows x64 calls up to 16 arguments";
  if (process.arch === "x64") return "x86-64 calls up to 6 integer/pointer and 8 floating-point arguments (registers only)";
  if (process.arch === "arm64") return "arm64 calls up to 8 integer/pointer and 8 floating-point arguments (registers only)";
  return `${process.arch} is not supported`;
}

function toAddress(value: unknown): bigint {
  const address = typeof value === "bigint" ? value : typeof value === "number" && Number.isSafeInteger(value) ? BigInt(value) : undefined;
  if (address === undefined || address <= 0n || address > 0xffff_ffff_ffff_ffffn) {
    throw new TypeError(`pointerFunction: ${String(value)} is not a function address (a positive integer or bigint)`);
  }
  return address;
}

function integer(value: unknown, name: string, index: number): bigint {
  if (typeof value === "bigint") return BigInt.asUintN(64, value);
  if (typeof value === "number" && Number.isInteger(value)) return BigInt.asUintN(64, BigInt(value));
  throw new TypeError(`${name}: argument ${index} (${String(value)}) is not an integer`);
}

/**
 * Binds the C function at `address` (a number or bigint, as `ptr` returns give it) to
 * `signature`, with the types `loadLibrary` declares. The returned function calls it on the
 * JavaScript thread; 64-bit and pointer returns come back as BigInt.
 *
 * Every runtime calls through Tarve's native library, without libffi or generated code. Up to
 * MAX_POINTER_BUFFERS buffer arguments; Windows x64 takes up to 16 arguments, arm64 and x86-64
 * elsewhere what fits in registers (8 or 6 integer/pointer and 8 floating-point). A signature
 * outside that throws PluginFfiUnsupportedError here, not at the call. Variadic functions and structs
 * by value are not supported. As with any FFI, a wrong signature or a dead address crashes the process.
 */
export function pointerFunction<const S extends FfiSymbol>(address: number | bigint, signature: S): PointerFunction<S> {
  validateSymbols({ pointerFunction: signature });
  const target = toAddress(address);
  const args = [...signature.args];
  const returns = signature.returns ?? "void";
  const name = `pointerFunction(0x${target.toString(16)})`;
  const buffers = args.filter(type => type === "buffer").length;
  if (buffers > MAX_POINTER_BUFFERS) {
    throw new PluginFfiUnsupportedError(`${name}: ${buffers} buffer arguments; at most ${MAX_POINTER_BUFFERS} (pass further memory as ptr)`);
  }
  if (args.length > 255) throw new PluginFfiUnsupportedError(`${name}: ${args.length} arguments; ${platformLimits()}`);
  const frame = new Uint8Array(HEADER + 9 * args.length);
  const view = new DataView(frame.buffer);
  view.setBigUint64(0, target, true);
  frame[16] = KIND_CODES[returns];
  frame[17] = args.length;
  args.forEach((type, index) => { frame[HEADER + 8 * args.length + index] = KIND_CODES[type]; });
  const ffi = ownFfi();
  const checked = ffi.tarve_ffi_check(frame);
  if (checked === UNSUPPORTED) {
    throw new PluginFfiUnsupportedError(`${name}: (${args.join(", ")}) => ${returns} cannot be called by address here; ${platformLimits()}`);
  }
  if (checked !== 0) throw new Error(`${name}: tarve_ffi_check refused the signature (status ${checked})`);
  const call = (...values: unknown[]): unknown => {
    const passed: ArrayBufferView[] = [frame, frame, frame, frame];
    let next = 0;
    for (let index = 0; index < args.length; index++) {
      const type = args[index]!;
      const value = values[index];
      const at = HEADER + 8 * index;
      if (type === "f32" || type === "f64") {
        if (typeof value !== "number") throw new TypeError(`${name}: argument ${index} (${String(value)}) is not a number`);
        view.setFloat64(at, value, true);
      } else if (type === "bool") {
        view.setBigUint64(at, value ? 1n : 0n, true);
      } else if (type === "buffer") {
        if (value === null || value === undefined) view.setBigUint64(at, NULL_BUFFER, true);
        else if (!ArrayBuffer.isView(value)) throw new TypeError(`${name}: argument ${index} is not a TypedArray, DataView or Buffer`);
        else {
          passed[next] = value;
          view.setBigUint64(at, BigInt(next++), true);
        }
      } else if (type === "ptr" && (value === null || value === undefined)) {
        view.setBigUint64(at, 0n, true);
      } else {
        view.setBigUint64(at, integer(value, name, index), true);
      }
    }
    const status = ffi.tarve_ffi_call(frame, passed[0]!, passed[1]!, passed[2]!, passed[3]!);
    if (status === NULL_FUNCTION) throw new Error(`${name}: null function address`);
    if (status !== 0) throw new Error(`${name}: tarve_ffi_call refused the call (status ${status})`);
    switch (returns) {
      case "void": return undefined;
      case "bool": return view.getFloat64(8, true) !== 0;
      case "i64": return view.getBigInt64(8, true);
      case "u64": case "ptr": return view.getBigUint64(8, true);
      default: return view.getFloat64(8, true);
    }
  };
  return call as PointerFunction<S>;
}
