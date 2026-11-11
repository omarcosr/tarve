import { createRequire } from "node:module";
import { nativePath } from "#tarve/runtime";
import { remoteLibrary } from "./remote";

type NativeSymbols = Record<"tarve_start" | "tarve_send" | "tarve_event_pipe_name" | "tarve_poll_event" | "tarve_open_external" | "tarve_last_error", (buffer: Uint8Array, length: number) => number> & { tarve_abi_version(): number; tarve_join(): number; tarve_allow_foreground(pid: number): number; tarve_prewarm?(renderer: number): number };

type NativeLibrary = { symbols: NativeSymbols; close(): void };

/** The library the running app was started from: `<surface>` frames go to the same one. */
let startedPath: string | undefined;
export function setStartedLibrary(path: string): void { startedPath = path; }

type SurfacePresent = (handle: bigint, pixels: Uint8Array, width: number, height: number, stride: number, format: number) => number;
let surfacePresent: SurfacePresent | undefined;

/** `tarve_surface_present` of the running app's library (Bun and txiki.js FFI). */
export function surfacePresentSymbol(): SurfacePresent {
  if (surfacePresent) return surfacePresent;
  if (!startedPath) throw new Error("surface present: the app has not started");
  const definitions = { tarve_surface_present: { args: ["u64", "ptr", "u32", "u32", "u32", "u32"], returns: "i32" } } as const;
  type Opened = { symbols: { tarve_surface_present: SurfacePresent } };
  const txikiFfi = (globalThis as { __tarveTxikiFfi?: { dlopen(path: string, symbols: typeof definitions): Opened } }).__tarveTxikiFfi;
  let opened: Opened;
  if (txikiFfi) opened = txikiFfi.dlopen(startedPath, definitions);
  else if (process.versions.bun) opened = (createRequire(import.meta.url)("bun:ffi") as typeof import("bun:ffi")).dlopen(startedPath, definitions) as unknown as Opened;
  else throw new Error("surface present needs Bun or txiki.js FFI; native producers call tarve_surface_present directly");
  surfacePresent = opened.symbols.tarve_surface_present;
  return surfacePresent;
}

let emitAddress: bigint | undefined;

/**
 * The address of the running app's `tarve_plugin_emit` (native/src/bridge/entry_points.rs), which a
 * plugin's library calls to report events (`ctx.events`). Bun, Node.js 26.10+, txiki.js and the
 * Android QuickJS runtime; not Bun on Android, whose library lives in another process. Valid from a
 * plugin's setup on: before the app starts it is the library the app will start from.
 */
export function pluginEmitAddress(): bigint {
  if (emitAddress !== undefined) return emitAddress;
  // A plugin's setup runs before the window starts: the library the app will start from.
  const path = startedPath ?? nativePath();
  if (process.platform === "android" && Number.isInteger(Number(process.env.TARVE_ANDROID_BRIDGE_FD))) {
    throw new Error("plugin events need the QuickJS runtime on Android: with --runtime bun the native library runs in another process");
  }
  const definitions = { tarve_plugin_emit_address: { args: [], returns: "u64" } } as const;
  type Opened = { symbols: { tarve_plugin_emit_address(): bigint | number } };
  const require = createRequire(import.meta.url);
  const txikiFfi = (globalThis as { __tarveTxikiFfi?: { dlopen(path: string, symbols: typeof definitions): Opened } }).__tarveTxikiFfi;
  let address: bigint | number;
  if (txikiFfi) address = txikiFfi.dlopen(path, definitions).symbols.tarve_plugin_emit_address();
  else if (process.versions.bun) address = ((require("bun:ffi") as typeof import("bun:ffi")).dlopen(path, definitions) as unknown as Opened).symbols.tarve_plugin_emit_address();
  else {
    const { dlopen } = require("node:ffi") as { dlopen(path: string, definitions: Record<string, { arguments: string[]; return: string }>): { functions: { tarve_plugin_emit_address(): bigint | number } } };
    address = dlopen(path, { tarve_plugin_emit_address: { arguments: [], return: "uint64" } }).functions.tarve_plugin_emit_address();
  }
  emitAddress = BigInt(address);
  return emitAddress;
}

export interface SurfaceGlSymbols {
  tarve_surface_gl_make_current(): number;
  tarve_surface_gl_begin(handle: bigint, fbo: Uint32Array, width: Uint32Array, height: Uint32Array): number;
  tarve_surface_gl_end(handle: bigint): number;
  tarve_surface_gl_proc_address_fn(): bigint;
}
let surfaceGl: SurfaceGlSymbols | undefined;

/** The `TarveGL` entry points of the running app's library (Bun and txiki.js FFI). */
export function surfaceGlSymbols(): SurfaceGlSymbols {
  if (surfaceGl) return surfaceGl;
  if (!startedPath) throw new Error("surface GL: the app has not started");
  const definitions = {
    tarve_surface_gl_make_current: { args: [], returns: "i32" },
    tarve_surface_gl_begin: { args: ["u64", "ptr", "ptr", "ptr"], returns: "i32" },
    tarve_surface_gl_end: { args: ["u64"], returns: "i32" },
    tarve_surface_gl_proc_address_fn: { args: [], returns: "u64" },
  } as const;
  type Opened = { symbols: SurfaceGlSymbols };
  const txikiFfi = (globalThis as { __tarveTxikiFfi?: { dlopen(path: string, symbols: typeof definitions): Opened } }).__tarveTxikiFfi;
  if (txikiFfi) surfaceGl = txikiFfi.dlopen(startedPath, definitions).symbols;
  else if (process.versions.bun) surfaceGl = ((createRequire(import.meta.url)("bun:ffi") as typeof import("bun:ffi")).dlopen(startedPath, definitions) as unknown as Opened).symbols;
  else throw new Error("surface GL needs Bun or txiki.js FFI; native producers call tarve_surface_gl_* directly");
  return surfaceGl;
}

export function openLibrary(path: string): NativeLibrary {
  const require = createRequire(import.meta.url);
  const definitions = {
    tarve_abi_version: { args: [], returns: "u32" },
    tarve_start: { args: ["buffer", "u32"], returns: "i32" },
    tarve_send: { args: ["buffer", "u32"], returns: "i32" },
    tarve_event_pipe_name: { args: ["buffer", "u32"], returns: "i32" },
    tarve_poll_event: { args: ["buffer", "u32"], returns: "i32" },
    tarve_open_external: { args: ["buffer", "u32"], returns: "i32" },
    tarve_last_error: { args: ["buffer", "u32"], returns: "i32" },
    tarve_join: { args: [], returns: "i32" },
    tarve_allow_foreground: { args: ["u32"], returns: "i32" },
    tarve_prewarm: { args: ["u32"], returns: "i32" },
  } as const;
  // Bun on Android: the activity process holds the library and answers over a socket.
  const remoteFd = process.platform === "android" ? Number(process.env.TARVE_ANDROID_BRIDGE_FD) : NaN;
  if (Number.isInteger(remoteFd) && remoteFd >= 0) {
    return remoteLibrary(remoteFd);
  }
  // txiki.js: the executable's prelude exposes tjs:ffi, whose dlopen matches bun:ffi.
  const txikiFfi = (globalThis as { __tarveTxikiFfi?: { dlopen(path: string, symbols: typeof definitions): NativeLibrary } }).__tarveTxikiFfi;
  if (txikiFfi) return txikiFfi.dlopen(path, definitions);
  if (process.versions.bun) {
    const { dlopen } = require("bun:ffi") as typeof import("bun:ffi");
    return dlopen(path, definitions) as NativeLibrary;
  }
  const [major = 0, minor = 0] = (process.versions.node ?? "").split(".").map(Number);
  if (major < 26 || (major === 26 && minor < 10)) {
    throw new Error(`Tarve requires Bun or Node.js 26.10+ with node:ffi (found Node.js ${process.versions.node ?? "unknown"})`);
  }
  const { dlopen } = require("node:ffi") as {
    dlopen: (path: string, definitions: Record<string, { arguments: string[]; return: string }>) => {
      functions: NativeSymbols;
      lib: { close(): void };
    };
  };
  const signatures = Object.fromEntries(Object.entries(definitions).map(([name, signature]) => [name, {
    arguments: signature.args.map(type => type === "buffer" ? "buffer" : type === "u32" ? "uint32" : "int32"),
    return: signature.returns === "u32" ? "uint32" : "int32",
  }]));
  const library = dlopen(path, signatures);
  return { symbols: library.functions, close: () => library.lib.close() };
}
