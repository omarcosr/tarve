// The slice of the txiki.js (tjs) runtime API the Tarve txiki runtime uses.
// https://txikijs.org/docs/api

interface TjsFileHandle {
  read(buffer: Uint8Array, position?: number): Promise<number | null>;
  stat(): Promise<{ size: number }>;
  close(): Promise<void>;
}

/** A WinterTC-style socket: streams arrive with `opened`. */
interface TjsConnection {
  readonly opened: Promise<{ readable: ReadableStream<Uint8Array>; writable: WritableStream<Uint8Array> }>;
  close(): void;
}

interface TjsGlobal {
  readonly args: string[];
  readonly env: Record<string, string | undefined>;
  readonly exePath: string;
  readonly tmpDir: string;
  readonly homeDir: string;
  readonly version: string;
  readonly engine: { versions: Record<string, string | number> };
  readonly cwd: string;
  chdir(directory: string): void;
  exit(code?: number): never;
  open(path: string, mode: string): Promise<TjsFileHandle>;
  stat(path: string): Promise<{ size: number }>;
  makeDir(path: string, options?: { recursive?: boolean }): Promise<void>;
  writeFile(path: string, data: Uint8Array): Promise<void>;
  rename(from: string, to: string): Promise<void>;
  remove(path: string): Promise<void>;
  connect(transport: "pipe" | "tcp", host: string, port?: number): Promise<TjsConnection>;
}

declare var tjs: TjsGlobal;

declare module "tjs:ffi" {
  type FfiType = "void" | "u8" | "i8" | "u16" | "i16" | "u32" | "i32" | "u64" | "i64" | "f32" | "f64" | "ptr" | "buffer" | "string" | "size_t";
  export interface SymbolDefinition { args: readonly FfiType[]; returns: FfiType }
  export function dlopen<T extends Record<string, SymbolDefinition>>(path: string, symbols: T): {
    symbols: { [K in keyof T]: (...args: any[]) => any };
    close(): void;
  };
}

declare module "tjs:hashing" {
  export function createHash(algorithm: string): {
    update(data: Uint8Array): unknown;
    digest(encoding: "hex"): string;
  };
}

declare module "tjs:path" {
  import type * as path from "node:path";
  const value: typeof path;
  export default value;
}
