/**
 * First module of a Tarve Android app (assets/tarve/app.js, run by native/src/android/qjs.rs
 * on QuickJS-ng). QuickJS has the language; globals.ts adds what Bun, Node.js and txiki.js
 * add around it, then this adds Buffer, Intl and the FFI library the bridge opens
 * (bridge/binding.ts), backed by direct calls into the runtime the activity already loaded.
 */
import "./globals";
import "./fetch";
import { installIntl } from "../txiki/intl";
import { Buffer } from "../txiki/shims/buffer";
import { host } from "./host";
import { WAKE_PIPE, wakeSockets } from "./shims/net";

const globals = globalThis as Record<string, any>;

globals.Buffer = Buffer;
// txiki.js modules shared with this runtime (intl.ts) read the environment through tjs.
globals.tjs = { env: globals.process.env };
globals.__tarveDirname = host.filesDir;
globals.__tarveNativePath = "libtarve_native.so";
installIntl();

// The FFI library the bridge opens (bridge/binding.ts), over the runtime's C ABI.
const encoder = new globals.TextEncoder() as TextEncoder;
let pendingEvent: Uint8Array | undefined;
function copyOut(bytes: Uint8Array, buffer: Uint8Array, capacity: number): number {
  if (bytes.length > capacity) return -bytes.length;
  buffer.set(bytes);
  return bytes.length;
}
const symbols = {
  tarve_abi_version: () => host.abi(),
  tarve_start: (buffer: Uint8Array, length: number) => host.start(buffer.subarray(0, length)),
  tarve_send: (buffer: Uint8Array, length: number) => host.send(buffer.subarray(0, length)),
  tarve_event_pipe_name: (buffer: Uint8Array, capacity: number) => copyOut(encoder.encode(WAKE_PIPE), buffer, capacity),
  tarve_poll_event(buffer: Uint8Array, capacity: number): number {
    const event = pendingEvent ?? host.poll();
    if (!event) return 0;
    if (event.length > capacity) {
      pendingEvent = event;
      return -event.length;
    }
    pendingEvent = undefined;
    buffer.set(event);
    return event.length;
  },
  tarve_open_external: (buffer: Uint8Array, length: number) => host.openExternal(host.decode(buffer.subarray(0, length))),
  tarve_last_error(buffer: Uint8Array, capacity: number): number {
    const error = encoder.encode(host.lastError()).subarray(0, capacity);
    buffer.set(error);
    return error.length;
  },
  tarve_join: () => 0,
  tarve_allow_foreground: () => 0,
};
globals.__tarveTxikiFfi = { dlopen: () => ({ symbols, close() {} }) };
// The loop calls this when the runtime queues events: the bridge's wake socket fires.
globals.__tarveWake = () => {
  for (const socket of [...wakeSockets]) socket.wake();
};
