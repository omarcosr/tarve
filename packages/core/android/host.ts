/**
 * `__tarveHost`: what native/src/android/qjs.rs gives the bundle on Android. Every
 * Node, Bun or web API the core uses there is built from these.
 */
export interface AndroidHost {
  /** Rust's std::env::consts::ARCH: "aarch64" or "x86_64". */
  arch: string;
  filesDir: string;
  cacheDir: string;
  now(): number;
  log(level: 0 | 1 | 2, message: string): void;
  env(): Record<string, string>;
  exit(code: number): never;

  abi(): number;
  start(payload: Uint8Array): number;
  send(payload: Uint8Array): number;
  poll(): Uint8Array | undefined;
  lastError(): string;
  openExternal(target: string): number;

  encode(text: string): Uint8Array;
  decode(bytes: Uint8Array): string;

  /** Each throws an Error whose message starts with the errno name ("ENOENT: …"). */
  readFile(path: string): Uint8Array;
  writeFile(path: string, data: Uint8Array, append?: boolean): void;
  /** [kind (1 file, 2 directory, 0 other), size, mtimeMs], or undefined when missing. */
  stat(path: string): [number, number, number] | undefined;
  mkdir(path: string, recursive?: boolean): void;
  rename(from: string, to: string): void;
  copyFile(from: string, to: string): void;
  remove(path: string, recursive?: boolean): void;
  /** Entry names; a directory's ends with "/". */
  readDir(path: string): string[];

  hash(algorithm: string, data: Uint8Array): Uint8Array;
  /** zlib-wrapped deflate ("deflate", with a level 0–9) or inflate ("inflate"); gzip members ("gzip", "gunzip"). */
  zlib(op: "deflate" | "inflate" | "gzip" | "gunzip", data: Uint8Array, level?: number): Uint8Array;
  random(size: number): Uint8Array;
  /** Resolved through `__tarveFetchDone(id, …)`; headers are flattened name/value pairs. */
  fetch(id: number, method: string, url: string, headers: string[], body?: Uint8Array): void;
}

declare const __tarveHost: AndroidHost;

export const host: AndroidHost = __tarveHost;

/** Node's error shape (`code`, `syscall`, `path`) from the host's "ECODE: message". */
export function nodeError(error: unknown): Error {
  const message = error instanceof Error ? error.message : String(error);
  const code = /^([A-Z]+):/.exec(message)?.[1];
  return Object.assign(error instanceof Error ? error : new Error(message), code ? { code } : {});
}

export function hostCall<T>(call: () => T): T {
  try {
    return call();
  } catch (error) {
    throw nodeError(error);
  }
}
