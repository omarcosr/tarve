import { createRequire } from "node:module";
import { remoteLibrary } from "./remote";

type NativeSymbols = Record<"tarve_start" | "tarve_send" | "tarve_event_pipe_name" | "tarve_poll_event" | "tarve_open_external" | "tarve_last_error", (buffer: Uint8Array, length: number) => number> & { tarve_abi_version(): number; tarve_join(): number; tarve_allow_foreground(pid: number): number };

type NativeLibrary = { symbols: NativeSymbols; close(): void };

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
