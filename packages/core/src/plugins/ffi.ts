// `ctx.loadLibrary`: opens a plugin's native library with the FFI of the JavaScript runtime
// the app runs on, from one typed symbol declaration. Bun: bun:ffi. Node.js 26.10+: node:ffi.
// txiki.js/QuickJS (and the Android host): the prelude's tjs:ffi, which mirrors bun:ffi.
// The Go runtime has no JavaScript and loads no plugins. Anything else fails with
// PluginFfiUnsupportedError rather than a cryptic module-not-found error.
import { createRequire } from "node:module";

/** C types a plugin symbol takes or returns. */
export type FfiType =
  | "void" | "bool"
  | "i8" | "u8" | "i16" | "u16" | "i32" | "u32" | "i64" | "u64"
  | "f32" | "f64"
  /** A raw address (number or bigint). */
  | "ptr"
  /** A TypedArray/Buffer passed by address: strings go in as NUL-terminated UTF-8 bytes. */
  | "buffer";

export interface FfiSymbol {
  readonly args: readonly FfiType[];
  /** Default: "void". */
  readonly returns?: FfiType;
}

export type FfiSymbols = Readonly<Record<string, FfiSymbol>>;

type ArgValue<T> =
  T extends "bool" ? boolean :
  T extends "i64" | "u64" ? number | bigint :
  T extends "ptr" ? number | bigint | null :
  T extends "buffer" ? ArrayBufferView | null :
  number;

type ReturnValue<T> =
  T extends "void" | undefined ? void :
  T extends "bool" ? boolean :
  T extends "i64" | "u64" | "ptr" ? number | bigint :
  T extends "buffer" ? never :
  number;

type ArgValues<A extends readonly FfiType[]> = { -readonly [K in keyof A]: ArgValue<A[K]> };

/** The JavaScript functions a symbol declaration gives. */
export type FfiFunctions<S extends FfiSymbols> = {
  readonly [K in keyof S]: (...args: ArgValues<S[K]["args"]>) => ReturnValue<S[K]["returns"]>;
};

export interface PluginLibrary<S extends FfiSymbols> {
  /** Absolute path of the opened library. */
  readonly path: string;
  /** Which FFI opened it. */
  readonly ffi: FfiBackend;
  readonly symbols: FfiFunctions<S>;
  /** Closes the library; the plugin host also closes it when the app closes. */
  close(): void;
}

export type FfiBackend = "bun" | "node" | "txiki";

/** This runtime has no FFI Tarve plugins can use. */
export class PluginFfiUnsupportedError extends Error {
  override readonly name = "PluginFfiUnsupportedError";
}

const RETURN_TYPES = new Set<FfiType>(["void", "bool", "i8", "u8", "i16", "u16", "i32", "u32", "i64", "u64", "f32", "f64", "ptr"]);
const ARG_TYPES = new Set<FfiType>([...RETURN_TYPES, "buffer" as const].filter(type => type !== "void"));

export function validateSymbols(symbols: FfiSymbols): void {
  const names = Object.keys(symbols);
  if (!names.length) throw new TypeError("loadLibrary needs at least one symbol declaration");
  for (const name of names) {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) throw new TypeError(`Invalid native symbol name: ${name}`);
    const symbol = symbols[name]!;
    if (!symbol || !Array.isArray(symbol.args)) throw new TypeError(`Native symbol ${name} needs an args array`);
    for (const type of symbol.args) if (!ARG_TYPES.has(type)) throw new TypeError(`Native symbol ${name}: unsupported argument type ${String(type)}`);
    if (symbol.returns !== undefined && !RETURN_TYPES.has(symbol.returns)) {
      throw new TypeError(`Native symbol ${name}: unsupported return type ${String(symbol.returns)}`);
    }
  }
}

const NODE_TYPES: Record<FfiType, string> = {
  void: "void", bool: "bool",
  i8: "int8", u8: "uint8", i16: "int16", u16: "uint16", i32: "int32", u32: "uint32", i64: "int64", u64: "uint64",
  f32: "float", f64: "double", ptr: "pointer", buffer: "buffer",
};

/** bun:ffi spells every type the way FfiType does, except `buffer`, `bool` and `ptr` which it also accepts. */
function bunDefinitions(symbols: FfiSymbols) {
  return Object.fromEntries(Object.entries(symbols).map(([name, symbol]) => [name, { args: [...symbol.args], returns: symbol.returns ?? "void" }]));
}

/** tjs:ffi declarations: `ptr` (a raw address) as u64. */
function txikiDefinitions(symbols: FfiSymbols) {
  const raw = (type: FfiType) => type === "ptr" ? "u64" : type;
  return Object.fromEntries(Object.entries(symbols).map(([name, symbol]) => [name, { args: symbol.args.map(raw), returns: raw(symbol.returns ?? "void") }]));
}

/** tjs:ffi functions taking BigInt and null where the declaration allows them: 64-bit values pass as numbers. */
function txikiFunctions(functions: Record<string, unknown>, symbols: FfiSymbols): Record<string, unknown> {
  return Object.fromEntries(Object.entries(symbols).map(([name, symbol]) => {
    const call = functions[name] as (...args: unknown[]) => unknown;
    const wide = symbol.args.map(type => type === "i64" || type === "u64" || type === "ptr");
    if (!wide.includes(true)) return [name, call];
    return [name, (...args: unknown[]) => call(...args.map((value, index) => {
      if (!wide[index]) return value;
      if (value === null || value === undefined) return 0;
      if (typeof value !== "bigint") return value;
      const number = Number(value);
      if (!Number.isSafeInteger(number)) throw new RangeError(`${name}: argument ${index} (${value}) does not fit txiki.js FFI's 53-bit integers`);
      return number;
    }))];
  }));
}

/** Which FFI this process offers plugins, or why it offers none. */
export function detectFfi(): { backend: FfiBackend } | { backend: undefined; reason: string } {
  if ((globalThis as { __tarveTxikiFfi?: unknown }).__tarveTxikiFfi) return { backend: "txiki" };
  if (process.versions?.bun) return { backend: "bun" };
  const node = process.versions?.node;
  if (!node) return { backend: undefined, reason: "this JavaScript runtime exposes no FFI" };
  const [major = 0, minor = 0] = node.split(".").map(Number);
  if (major < 26 || (major === 26 && minor < 10)) {
    return { backend: undefined, reason: `Node.js ${node} has no node:ffi; native plugins need Node.js 26.10+ or Bun` };
  }
  return { backend: "node" };
}

/** Opens `path` and binds `symbols`. Throws PluginFfiUnsupportedError when the runtime has no FFI. */
export function openPluginLibrary<const S extends FfiSymbols>(path: string, symbols: S, owner = "plugin"): PluginLibrary<S> {
  validateSymbols(symbols);
  const detected = detectFfi();
  if (!detected.backend) {
    throw new PluginFfiUnsupportedError(`${owner}: cannot load native library ${path}: ${detected.reason}.`);
  }
  const require = createRequire(import.meta.url);
  let functions: Record<string, unknown>;
  let close: () => void;
  try {
    if (detected.backend === "txiki" || detected.backend === "bun") {
      const ffi = detected.backend === "txiki"
        ? (globalThis as unknown as { __tarveTxikiFfi: { dlopen(path: string, symbols: unknown): { symbols: Record<string, unknown>; close(): void } } }).__tarveTxikiFfi
        : require("bun:ffi") as { dlopen(path: string, symbols: unknown): { symbols: Record<string, unknown>; close(): void } };
      // txiki.js's own tjs:ffi (not the Android host's) takes 64-bit integers as numbers and `ptr` only
      // as a TypedArray: raw addresses go as u64 numbers there.
      const txiki = detected.backend === "txiki" && typeof (globalThis as { tjs?: { version?: unknown } }).tjs?.version === "string";
      const library = ffi.dlopen(path, txiki ? txikiDefinitions(symbols) : bunDefinitions(symbols));
      functions = txiki ? txikiFunctions(library.symbols, symbols) : library.symbols;
      close = () => library.close();
    } else {
      let nodeFfi: { dlopen(path: string, definitions: unknown): { functions: Record<string, unknown>; lib: { close(): void } } };
      try {
        nodeFfi = require("node:ffi");
      } catch (error) {
        throw new PluginFfiUnsupportedError(`${owner}: node:ffi is not available in Node.js ${process.versions.node} (${(error as Error).message}).`);
      }
      const definitions = Object.fromEntries(Object.entries(symbols).map(([name, symbol]) => [name, {
        arguments: symbol.args.map(type => NODE_TYPES[type]),
        return: NODE_TYPES[symbol.returns ?? "void"],
      }]));
      const library = nodeFfi.dlopen(path, definitions);
      functions = library.functions;
      close = () => library.lib.close();
    }
  } catch (error) {
    if (error instanceof PluginFfiUnsupportedError) throw error;
    throw new Error(`${owner}: could not load native library ${path}: ${(error as Error).message}`, { cause: error });
  }
  let closed = false;
  return {
    path,
    ffi: detected.backend,
    symbols: functions as FfiFunctions<S>,
    close() {
      if (closed) return;
      closed = true;
      close();
    },
  };
}
