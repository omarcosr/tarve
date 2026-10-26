/**
 * The C ABI over a socket: a Bun app on Android runs as a child of the activity, which keeps the
 * window and calls the native library for it (native/src/android/bun_host.rs). Each call is a
 * synchronous request on the inherited fd TARVE_ANDROID_BRIDGE_FD, with the same results as the
 * symbol it stands for, so BunFfiBridge works unchanged.
 */

const OP = { abi: 0, start: 1, send: 2, poll: 3, pipeName: 4, lastError: 5, openExternal: 6, join: 7 } as const;

type Symbols = Record<"tarve_start" | "tarve_send" | "tarve_event_pipe_name" | "tarve_poll_event" | "tarve_open_external" | "tarve_last_error", (buffer: Uint8Array, length: number) => number> & { tarve_abi_version(): number; tarve_join(): number; tarve_allow_foreground(pid: number): number };

/** Blocking reads and writes on the bridge fd; replaced in tests. */
export interface RemoteIo {
  read(target: Uint8Array, offset: number, length: number): number;
  write(source: Uint8Array, offset: number, length: number): number;
}

/**
 * node:fs at run time, not as an import: QuickJS builds (txiki.js, Android) bundle this file
 * too, and their fs shims have no readSync/writeSync. Only Bun on Android reaches it.
 */
function fdIo(fd: number): RemoteIo {
  const fs = process.getBuiltinModule("node:fs") as typeof import("node:fs");
  return {
    read: (target, offset, length) => fs.readSync(fd, target, offset, length, null),
    write: (source, offset, length) => fs.writeSync(fd, source, offset, length),
  };
}

export function remoteLibrary(fd: number, io: RemoteIo = fdIo(fd)): { symbols: Symbols; close(): void } {
  const header = new Uint8Array(8);
  const headerView = new DataView(header.buffer);
  function readExactly(target: Uint8Array): void {
    for (let offset = 0; offset < target.length;) {
      const read = io.read(target, offset, target.length - offset);
      if (read <= 0) throw new Error("The Tarve Android host closed the bridge");
      offset += read;
    }
  }
  function writeAll(bytes: Uint8Array): void {
    for (let offset = 0; offset < bytes.length;) offset += io.write(bytes, offset, bytes.length - offset);
  }
  function call(op: number, payload: Uint8Array = new Uint8Array(0)): { result: number; bytes: Uint8Array } {
    const request = new Uint8Array(5 + payload.length);
    request[0] = op;
    new DataView(request.buffer).setUint32(1, payload.length, true);
    request.set(payload, 5);
    writeAll(request);
    readExactly(header);
    const result = headerView.getInt32(0, true);
    const bytes = new Uint8Array(headerView.getUint32(4, true));
    readExactly(bytes);
    return { result, bytes };
  }
  const fill = (op: number) => (buffer: Uint8Array, capacity: number): number => {
    const size = new Uint8Array(4);
    new DataView(size.buffer).setUint32(0, capacity, true);
    const { result, bytes } = call(op, size);
    buffer.set(bytes.subarray(0, Math.min(bytes.length, capacity)));
    return result;
  };
  const symbols: Symbols = {
    tarve_abi_version: () => call(OP.abi).result >>> 0,
    tarve_start: (buffer, length) => call(OP.start, buffer.subarray(0, length)).result,
    tarve_send: (buffer, length) => call(OP.send, buffer.subarray(0, length)).result,
    tarve_poll_event: fill(OP.poll),
    tarve_event_pipe_name: fill(OP.pipeName),
    tarve_last_error: fill(OP.lastError),
    tarve_open_external: (buffer, length) => call(OP.openExternal, buffer.subarray(0, length)).result,
    tarve_join: () => call(OP.join).result,
    // Android has no foreground lock to hand over.
    tarve_allow_foreground: () => 0,
  };
  // One connection serves every openLibrary call; it closes when the app exits.
  return { symbols, close() {} };
}
