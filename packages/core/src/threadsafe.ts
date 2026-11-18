// threadsafeCallback / threadsafeComObject: C function pointers (and COM objects) that native
// code may call from any thread, for Bun, Node.js 26.10+ and txiki.js alike. A call never runs
// JavaScript on the calling thread: Tarve's native library (native/src/threadsafe.rs) records its
// arguments, returns a fixed value at once and wakes this thread through a pipe, where the
// callback then runs, in call order. bun:ffi's `JSCallback({ threadsafe: true })` works the same.
import { connect, type Socket } from "node:net";
import { ownLibraryPath } from "./bridge/binding";
import { openPluginLibrary, type PluginLibrary } from "./plugins/ffi";
import { heldObjects, marshalSpecs, segmentValues, TAGGED, type ThreadsafeArg } from "./threadsafe-args";

export type { ThreadsafeArg, ThreadsafeArgSpec, ThreadsafeVariant } from "./threadsafe-args";

/** How a threadsafe callback reads each argument (integers and pointers; no floating point). */
export type ThreadsafeArgType = "bool" | "i8" | "u8" | "i16" | "u16" | "i32" | "u32" | "i64" | "u64" | "ptr";

export interface ThreadsafeCallbackOptions<A extends readonly ThreadsafeArg[] = readonly ThreadsafeArg[]> {
  /**
   * The arguments the native caller passes, at most 6. Default: none. A pointer argument may be
   * kept or copied during the call (`{ type: "ptr", keep: "com" }`, `{ type: "ptr", copy: "variant" }`):
   * see `ThreadsafeArgSpec`.
   */
  readonly args?: A;
  /**
   * What every call returns to the native caller, at once (the callback's own result is not
   * awaited): an HRESULT, a BOOL, 0 for void. Default 0.
   */
  readonly returns?: number | bigint;
  /**
   * Copies `bytes` from the address argument `arg` holds, during the call: the memory a pointer
   * argument names (a notification struct) is usually gone once the caller returns. The callback
   * gets that argument as a Uint8Array (null when the pointer was null) instead of the address.
   */
  readonly copy?: { readonly arg: number; readonly bytes: number };
}

export interface ThreadsafeCallback {
  /** The C function's address: hand it to native code (a vtable, a registration call). */
  readonly pointer: bigint;
  readonly closed: boolean;
  /**
   * Stops delivering calls; the address stays safe to call (it returns `returns` and does nothing).
   * While any callback is open the process stays alive, as with an open socket.
   */
  close(): void;
}

/** At most this many arguments; more are not recorded. */
export const THREADSAFE_MAX_ARGS = 6;
/** Callbacks open at once, process-wide. */
export const THREADSAFE_MAX_CALLBACKS = 128;
const MAX_COPY = 64 * 1024;
const RECORD_HEADER = 8 + THREADSAFE_MAX_ARGS * 8;
const NO_COPY = 0xffffffff;

const SYMBOLS = {
  tarve_threadsafe_pipe_name: { args: ["buffer", "u32"], returns: "i32" },
  tarve_threadsafe_callback: { args: ["u32", "u64", "u32", "u32"], returns: "u64" },
  tarve_threadsafe_callback_args: { args: ["u32", "u64", "buffer", "u32"], returns: "u64" },
  tarve_unknown_release: { args: ["u64"], returns: "i32" },
  tarve_threadsafe_close: { args: ["u64"], returns: "i32" },
  tarve_threadsafe_poll: { args: ["buffer", "u32"], returns: "i32" },
  tarve_threadsafe_dropped: { args: [], returns: "u64" },
  tarve_com_object: { args: ["buffer", "u32", "buffer", "u32"], returns: "u64" },
  tarve_com_release: { args: ["u64"], returns: "i32" },
  tarve_last_error: { args: ["buffer", "u32"], returns: "i32" },
  // messageWindow (./message-window.ts) queues into this library's callbacks: it must bind the same
  // instance (a Node.js single executable app loads each dlopen of its embedded library anew).
  tarve_message_window_open: { args: ["buffer", "u32", "u64"], returns: "u64" },
  tarve_message_window_info: { args: ["u64", "buffer", "u32"], returns: "i32" },
  tarve_message_window_reply: { args: ["u64", "u64", "i64"], returns: "i32" },
  tarve_message_window_set_reply: { args: ["u64", "u64", "u32", "u32", "u64", "u32", "i64"], returns: "i32" },
  tarve_message_window_close: { args: ["u64"], returns: "i32" },
} as const;

interface Open {
  readonly run: (...args: unknown[]) => void;
  readonly decode: (record: DataView, at: number, copied: Uint8Array | null, marshalled: Map<number, unknown> | null) => unknown[];
}

let library: PluginLibrary<typeof SYMBOLS> | undefined;
const open = new Map<number, Open>();
let nextId = 1;
let socket: Socket | undefined;
let pollBuffer = new Uint8Array(64 * 1024);

function native(): PluginLibrary<typeof SYMBOLS>["symbols"] {
  library ??= openPluginLibrary(ownLibraryPath("threadsafeCallback"), SYMBOLS, "threadsafeCallback");
  return library.symbols;
}

/** The library instance threadsafe callbacks live in, for Tarve's own native producers. */
export function threadsafeNative(): PluginLibrary<typeof SYMBOLS>["symbols"] {
  return native();
}

function lastError(): string {
  const message = new Uint8Array(1024);
  const written = native().tarve_last_error(message, message.length);
  return new TextDecoder().decode(message.subarray(0, Math.max(0, written)));
}

function pipeName(): string {
  for (let size = 256; ;) {
    const out = new Uint8Array(size);
    const length = native().tarve_threadsafe_pipe_name(out, size);
    if (length >= 0) return new TextDecoder().decode(out.subarray(0, length));
    if (length === -1) throw new Error(`threadsafeCallback: ${lastError()}`);
    size = -length;
  }
}

/** Connects to a fresh wake pipe: calls queued before it connected are taken right away. */
function listen(): void {
  if (socket) return;
  const current = connect(pipeName());
  socket = current;
  current.on("connect", drain);
  current.on("data", drain);
  current.on("error", (error: Error) => {
    if (socket !== current) return;
    socket = undefined;
    console.error("[tarve] threadsafeCallback wake pipe failed", error);
    // Calls keep arriving: reconnect to a new pipe while callbacks are open.
    if (open.size) setTimeout(() => { if (open.size) listen(); }, 100);
  });
}

function stopListening(): void {
  if (open.size || !socket) return;
  const current = socket;
  socket = undefined;
  // Calls that arrived before the last close still run.
  drain();
  current.destroy();
}

/** Runs the queued calls of open callbacks, in order. */
function drain(): void {
  if (!library) return;
  for (;;) {
    const length = native().tarve_threadsafe_poll(pollBuffer, pollBuffer.length);
    if (length === 0) break;
    if (length < -1) {
      pollBuffer = new Uint8Array(-length);
      continue;
    }
    if (length < 0) throw new Error(`threadsafeCallback: ${lastError()}`);
    const view = new DataView(pollBuffer.buffer, 0, length);
    // Copied bytes are sliced out before the buffer is reused by the next poll.
    const calls: [Open, unknown[]][] = [];
    for (let at = 0; at < length;) {
      const id = view.getUint32(at, true);
      const lengthField = view.getUint32(at + 4, true);
      const tagged = lengthField >= TAGGED;
      const copiedLength = tagged ? lengthField - TAGGED : lengthField;
      const start = at + RECORD_HEADER, end = start + copiedLength;
      const target = open.get(id);
      if (target) {
        const copied = copiedLength && !tagged ? pollBuffer.slice(start, end) : null;
        calls.push([target, target.decode(view, at + 8, copied, tagged ? segmentValues(pollBuffer, start, end) : null)]);
      } else if (tagged) {
        // Nobody takes this call: release the interfaces it kept.
        for (const object of heldObjects(pollBuffer, start, end)) releaseCom(object);
      }
      at += RECORD_HEADER + copiedLength;
    }
    for (const [target, args] of calls) {
      try {
        target.run(...args);
      } catch (error) {
        console.error("[tarve] threadsafeCallback", error);
      }
    }
  }
  const dropped = Number(native().tarve_threadsafe_dropped());
  if (dropped) console.warn(`[tarve] threadsafeCallback: ${dropped} call(s) dropped while the JavaScript thread was busy`);
}

/** The low `bits` of `value`, unsigned (BigInt.asUintN, which QuickJS gets wrong for negative values). */
function unsignedBits(value: bigint, bits: bigint): bigint {
  return value & ((1n << bits) - 1n);
}

/** The low `bits` of `value`, as a signed integer (BigInt.asIntN). */
function signedBits(value: bigint, bits: bigint): bigint {
  const low = unsignedBits(value, bits);
  return low >= 1n << (bits - 1n) ? low - (1n << bits) : low;
}

function decoder(types: readonly ThreadsafeArgType[], copyArg: number | undefined): Open["decode"] {
  return (view, at, copied, marshalled) => types.map((type, index) => {
    if (marshalled?.has(index)) return marshalled.get(index);
    if (index === copyArg) return copied;
    const raw = view.getBigUint64(at + index * 8, true);
    switch (type) {
      case "bool": return (raw & 0xffn) !== 0n;
      case "i8": return Number(signedBits(raw, 8n));
      case "u8": return Number(unsignedBits(raw, 8n));
      case "i16": return Number(signedBits(raw, 16n));
      case "u16": return Number(unsignedBits(raw, 16n));
      case "i32": return Number(signedBits(raw, 32n));
      case "u32": return Number(unsignedBits(raw, 32n));
      case "i64": return signedBits(raw, 64n);
      default: return raw;
    }
  });
}

const ARG_TYPES = new Set<ThreadsafeArgType>(["bool", "i8", "u8", "i16", "u16", "i32", "u32", "i64", "u64", "ptr"]);

/**
 * A C function pointer that native code may call from any thread. Each call returns
 * `options.returns` to its caller at once; `run` then runs on the JavaScript thread with the
 * arguments, in call order. For COM interfaces, see `threadsafeComObject`.
 *
 * ```ts
 * const changed = threadsafeCallback((context: bigint) => refresh(), { args: ["ptr"] });
 * NotifyNetworkConnectivityHintChange(changed.pointer, 0n, 1, handle);
 * // later: CancelMibChangeNotify2(handle); changed.close();
 * ```
 *
 * 64-bit Windows, Linux and macOS (x64 and arm64). Up to 6 integer or pointer arguments;
 * floating-point arguments are not captured.
 */
export function threadsafeCallback<const A extends readonly ThreadsafeArg[] = readonly []>(
  run: (...args: any[]) => void,
  options: ThreadsafeCallbackOptions<A> = {},
): ThreadsafeCallback {
  const args = options.args ?? [];
  if (args.length > THREADSAFE_MAX_ARGS) throw new RangeError(`threadsafeCallback takes at most ${THREADSAFE_MAX_ARGS} arguments`);
  for (const arg of args) if (typeof arg !== "object" && !ARG_TYPES.has(arg)) throw new TypeError(`threadsafeCallback: unsupported argument type ${String(arg)}`);
  const copy = options.copy;
  const { types, specs } = marshalSpecs(args, undefined, MAX_COPY);
  if (copy) {
    if (!Number.isInteger(copy.arg) || copy.arg < 0 || copy.arg >= types.length || types[copy.arg] !== "ptr") {
      throw new RangeError("threadsafeCallback: copy.arg must name a \"ptr\" argument");
    }
    if (!Number.isInteger(copy.bytes) || copy.bytes <= 0 || copy.bytes > MAX_COPY) {
      throw new RangeError(`threadsafeCallback: copy.bytes must be from 1 to ${MAX_COPY}`);
    }
  }
  // A negative 32-bit value (a failing HRESULT) goes as its 32 bits: the caller reads eax, and
  // txiki.js's FFI takes 64-bit values as numbers, which cannot hold a sign-extended one.
  const wanted = BigInt(options.returns ?? 0);
  const returns = unsignedBits(wanted, wanted < 0n && wanted >= -(1n << 31n) ? 32n : 64n);
  if (specs) {
    if (copy) specs.set(marshalSpecs(args, copy, MAX_COPY).specs!);
    const create = (id: number) => native().tarve_threadsafe_callback_args(id, returns, specs, args.length);
    return openCallback(run as Open["run"], decoder(types, undefined), returns, NO_COPY, 0, create);
  }
  return openCallback(run as Open["run"], decoder(types, copy?.arg), returns, copy ? copy.arg : NO_COPY, copy ? copy.bytes : 0);
}

/**
 * Releases a COM interface pointer a threadsafe callback kept for you (a `keep: "com"` argument, a
 * "variant" holding VT_UNKNOWN or VT_DISPATCH): IUnknown::Release, on this thread. Each kept
 * pointer must be released once. Returns the count Release reported (diagnostics only); null and
 * 0n do nothing. A call no callback takes any more (closed meanwhile) is released for you.
 */
export function releaseCom(pointer: bigint | null | undefined): number {
  if (!pointer) return 0;
  const left = native().tarve_unknown_release(pointer);
  if (left < 0) throw new Error(`releaseCom: ${lastError()}`);
  return left;
}

/**
 * A threadsafe callback for Tarve's own native producers (native/src/message_window.rs), which
 * queue records with copied data of any length: `run` gets the 6 raw arguments and those bytes.
 */
export function threadsafeRecordCallback(run: (args: bigint[], copied: Uint8Array | null) => void): ThreadsafeCallback {
  const raw: Open["decode"] = (view, at, copied) => {
    const args: bigint[] = [];
    for (let index = 0; index < THREADSAFE_MAX_ARGS; index++) args.push(view.getBigUint64(at + index * 8, true));
    return [args, copied];
  };
  return openCallback(run as Open["run"], raw, 0n, NO_COPY, 0);
}

function openCallback(
  run: Open["run"],
  decode: Open["decode"],
  returns: bigint,
  copyArg: number,
  copyBytes: number,
  create: (id: number) => number | bigint = id => native().tarve_threadsafe_callback(id, returns, copyArg, copyBytes),
): ThreadsafeCallback {
  const id = nextId++;
  if (nextId > 0xffffffff) nextId = 1;
  const symbols = native();
  const pointer = BigInt(create(id));
  if (pointer === 0n) throw new Error(`threadsafeCallback: ${lastError()}`);
  open.set(id, { run, decode });
  try {
    listen();
  } catch (error) {
    open.delete(id);
    symbols.tarve_threadsafe_close(pointer);
    throw error;
  }
  let closed = false;
  return {
    pointer,
    get closed() { return closed; },
    close() {
      if (closed) return;
      closed = true;
      symbols.tarve_threadsafe_close(pointer);
      // Calls already queued for it still run, as they happened before the close.
      drain();
      open.delete(id);
      stopListening();
    },
  };
}

export interface ThreadsafeComObjectOptions {
  /** The interfaces it implements ("{xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx}"), besides IUnknown and IAgileObject. */
  readonly iids: readonly string[];
  /** Its vtable after IUnknown's QueryInterface, AddRef and Release: callbacks or raw addresses, in order. */
  readonly methods: readonly (ThreadsafeCallback | bigint)[];
}

export interface ThreadsafeComObject {
  /** The object's address (an `IFoo*`): pass it where the API takes the interface. */
  readonly pointer: bigint;
  /** Drops this side's reference; the object is freed once native code released its own. */
  release(): void;
}

/** A GUID string as the 16 bytes of a Windows GUID struct. */
export function guidBytes(guid: string): Uint8Array {
  const match = /^\{?([0-9a-f]{8})-([0-9a-f]{4})-([0-9a-f]{4})-([0-9a-f]{4})-([0-9a-f]{12})\}?$/i.exec(guid.trim());
  if (!match) throw new TypeError(`Not a GUID: ${guid}`);
  const bytes = new Uint8Array(16);
  const view = new DataView(bytes.buffer);
  view.setUint32(0, Number.parseInt(match[1]!, 16), true);
  view.setUint16(4, Number.parseInt(match[2]!, 16), true);
  view.setUint16(6, Number.parseInt(match[3]!, 16), true);
  const tail = match[4]! + match[5]!;
  for (let index = 0; index < 8; index++) bytes[8 + index] = Number.parseInt(tail.slice(index * 2, index * 2 + 2), 16);
  return bytes;
}

/**
 * A COM object native code may call from any thread: QueryInterface, AddRef and Release answer
 * natively and at once (IUnknown, IAgileObject and `iids`), its other methods are threadsafe
 * callbacks, each method's first argument being the object itself. For COM and WinRT event sinks
 * (`IAudioEndpointVolumeCallback`, `IUIAutomationEventHandler`, a `TypedEventHandler` delegate).
 *
 * ```ts
 * const onNotify = threadsafeCallback((self: bigint, data: Uint8Array | null) => updateVolume(data),
 *   { args: ["ptr", "ptr"], copy: { arg: 1, bytes: 32 } });
 * const sink = threadsafeComObject({ iids: ["{657804FA-D6AD-4496-8A60-352752AF4F89}"], methods: [onNotify] });
 * endpointVolume.RegisterControlChangeNotify(sink.pointer);
 * ```
 *
 * A method whose arguments outlive the call only while it runs keeps or copies them per argument,
 * as IUIAutomationPropertyChangedEventHandler::HandlePropertyChangedEvent(sender, propertyId, newValue):
 *
 * ```ts
 * const changed = threadsafeCallback((self: bigint, sender: bigint | null, propertyId: number, value: ThreadsafeVariant) => {
 *   try { update(sender, propertyId, value); } finally { releaseCom(sender); }
 * }, { args: ["ptr", { type: "ptr", keep: "com" }, "i32", { type: "ptr", copy: "variant" }] });
 * ```
 */
export function threadsafeComObject(options: ThreadsafeComObjectOptions): ThreadsafeComObject {
  if (!options.methods.length) throw new TypeError("threadsafeComObject needs at least one method");
  const iids = new Uint8Array(Math.max(1, options.iids.length) * 16);
  options.iids.forEach((iid, index) => iids.set(guidBytes(iid), index * 16));
  const methods = new Uint8Array(options.methods.length * 8);
  const view = new DataView(methods.buffer);
  options.methods.forEach((method, index) => view.setBigUint64(index * 8, typeof method === "bigint" ? method : method.pointer, true));
  const symbols = native();
  const pointer = BigInt(symbols.tarve_com_object(iids, options.iids.length, methods, options.methods.length));
  if (pointer === 0n) throw new Error(`threadsafeComObject: ${lastError()}`);
  let released = false;
  return {
    pointer,
    release() {
      if (released) return;
      released = true;
      symbols.tarve_com_release(pointer);
    },
  };
}
