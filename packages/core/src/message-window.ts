// messageWindow (Windows): a hidden window on its own native thread with its own message loop
// (native/src/message_window.rs). The window messages, WinEvents, shell hook notifications and
// registry/folder changes asked for reach `onMessage` on the JavaScript thread, in the order they
// happened, through the threadsafe callback queue (./threadsafe.ts): no polling, no Worker, the
// same on Bun, Node.js and txiki.js.
import { threadsafeNative, threadsafeRecordCallback } from "./threadsafe";

/** A window message: its number, or the name of a registered one (RegisterWindowMessageW, e.g. "TaskbarCreated"). */
export type MessageWindowMessage = number | string;

/** An LRESULT: booleans are 1 and 0. */
export type MessageWindowReply = number | bigint | boolean;

/** A fixed answer only to `message` with this wParam, or (WM_COPYDATA) this COPYDATASTRUCT dwData, e.g. `{ message: 0x4a, dwData: 1, value: 1 }` answers the tray's NIM_* at once. A keyed entry wins over the message's `replies` entry. */
export interface MessageWindowKeyedReply {
  readonly message: MessageWindowMessage;
  readonly wParam?: number | bigint;
  readonly dwData?: number | bigint;
  readonly value: MessageWindowReply;
}

/** A child window made on the window's thread (WS_CHILD is always added to `style`): found by FindWindowEx, its messages delivered like the top window's (`messages`, `waitReplies` apply to every window of the tree). */
export interface MessageWindowChild {
  /** Registered for this window (unless the tree already did), unregistered by dispose(). */
  readonly className: string;
  readonly windowName?: string;
  /** CreateWindowExW dwStyle / dwExStyle. Default 0 / 0. */
  readonly style?: number;
  readonly exStyle?: number;
  /** This child's own fixed answers (see MessageWindowOptions.replies). */
  readonly replies?: Readonly<Record<string, MessageWindowReply>>;
  readonly keyedReplies?: readonly MessageWindowKeyedReply[];
  readonly children?: readonly MessageWindowChild[];
}

/** A window of the tree: the top one or a child. */
export interface MessageWindowTarget {
  readonly hwnd: bigint;
  readonly className: string;
}

export interface MessageWindowChildInfo extends MessageWindowTarget {
  readonly windowName: string;
  readonly parent: bigint;
}

/** Where `setReply` puts its answer: a window of the tree (default: the top one), keyed by wParam or by WM_COPYDATA dwData. */
export interface MessageWindowReplyTarget {
  readonly hwnd?: bigint | number;
  readonly wParam?: number | bigint;
  readonly dwData?: number | bigint;
}

export interface MessageWindowWinEvent {
  /** EVENT_* range (SetWinEventHook eventMin/eventMax); `max` defaults to `min`. */
  readonly min: number;
  readonly max?: number;
  /** Only this process / thread (0, the default: all). */
  readonly process?: number;
  readonly thread?: number;
  /** WINEVENT_SKIPOWNPROCESS. */
  readonly skipOwnProcess?: boolean;
  /** WINEVENT_SKIPOWNTHREAD. */
  readonly skipOwnThread?: boolean;
}

export interface MessageWindowRegistryWatch {
  /** "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Themes\\Personalize" (HKCU, HKLM, HKCR, HKU, HKCC or their long names). */
  readonly key: string;
  readonly subtree?: boolean;
  /** REG_NOTIFY_CHANGE_* flags. Default: NAME | LAST_SET. */
  readonly filter?: number;
}

export interface MessageWindowFolderWatch {
  readonly path: string;
  readonly subtree?: boolean;
  /** FILE_NOTIFY_CHANGE_* flags. Default: FILE_NAME | DIR_NAME | LAST_WRITE. */
  readonly filter?: number;
}

/** Inclusive message range [min, max], e.g. [0x400, 0xbfff] for every private (WM_USER) message. */
export type MessageWindowRange = readonly [number, number];

/**
 * Messages sent on to the window's twin, natively, before the sender gets its answer: the twin's
 * answer becomes the window's (0 when there is no twin or it does not answer in time), unless a
 * fixed reply or `onMessage` gives one. The twin of the top window is the first other top-level
 * window of its class (in z-order); a child's twin is found under it along the same class path,
 * e.g. Explorer's Shell_TrayWnd > ReBarWindow32 > MSTaskSwWClass for a replacement tray. Both are
 * looked up at each message, so a restarted shell is found again.
 */
export interface MessageWindowForward {
  readonly messages?: readonly MessageWindowMessage[];
  readonly ranges?: readonly MessageWindowRange[];
  /** SendMessageTimeout bound in ms, 1-10000. Default 2000. */
  readonly timeout?: number;
}

/**
 * An icon a delivered message carries, read before its sender gets the answer (apps destroy theirs
 * once Shell_NotifyIcon or SetOverlayIcon returns): its pixels reach `onMessage` as `icon`.
 */
export interface MessageWindowIconSource {
  readonly message: MessageWindowMessage;
  /** WM_COPYDATA: only this dwData. */
  readonly dwData?: number | bigint;
  /** The HICON is lParam (default), or the 32-bit handle at this byte offset of WM_COPYDATA's data (NOTIFYICONDATA's hIcon: 28 in SHELLTRAYDATA). */
  readonly offset?: number;
  /** Only when the u32 at `offset` of WM_COPYDATA's data has any bit of `mask` (NOTIFYICONDATA's uFlags & NIF_ICON: { offset: 20, mask: 2 }). */
  readonly when?: { readonly offset: number; readonly mask: number };
}

/** An icon's pixels: straight-alpha RGBA, top row first, up to 128×128. */
export interface MessageWindowIcon {
  readonly width: number;
  readonly height: number;
  readonly rgba: Uint8Array;
}

export type MessageWindowEvent =
  | {
    readonly type: "message";
    /** The window of the tree that got it. */
    readonly window: MessageWindowTarget;
    readonly message: number;
    readonly wParam: bigint;
    readonly lParam: bigint;
    /**
     * The bytes lParam points to, copied while the message was handled: WM_SETTINGCHANGE's
     * string (see `text`), WM_POWERBROADCAST PBT_POWERSETTINGCHANGE's POWERBROADCAST_SETTING,
     * WM_DEVICECHANGE's DEV_BROADCAST_* structure, WM_COPYDATA's data (see `copyData`).
     */
    readonly data?: Uint8Array;
    /** WM_SETTINGCHANGE: the changed area ("ImmersiveColorSet", "Policy", "intl", …). */
    readonly text?: string;
    /** WM_COPYDATA: COPYDATASTRUCT's dwData and its lpData bytes (up to 64 KiB - 8). */
    readonly copyData?: { readonly dwData: bigint; readonly data: Uint8Array };
    /** Its sender waits for what `onMessage` returns (the message is in `waitReplies`). */
    readonly waiting: boolean;
    /** The pixels of the icon it carried (see `icons`); absent when the handle was no icon or larger than 128×128. */
    readonly icon?: MessageWindowIcon;
  }
  | {
    readonly type: "winEvent";
    readonly event: number;
    readonly hwnd: bigint;
    readonly idObject: number;
    readonly idChild: number;
    readonly thread: number;
    readonly time: number;
  }
  /** RegisterShellHookWindow: `code` is the HSHELL_* value, `lParam` usually the window it is about. */
  | { readonly type: "shell"; readonly code: number; readonly lParam: bigint }
  /** `ended`: the watch cannot go on (the key was deleted) and reports nothing more. */
  | { readonly type: "registry"; readonly index: number; readonly key: string; readonly ended: boolean }
  | { readonly type: "folder"; readonly index: number; readonly path: string; readonly ended: boolean };

export interface MessageWindowOptions {
  /** The window class (e.g. "Shell_TrayWnd" to host the tray). Default: a unique name. Registered for this window, unregistered by dispose(). */
  readonly className?: string;
  readonly windowName?: string;
  /**
   * A message-only window (parent HWND_MESSAGE): FindWindow and broadcasts (WM_SETTINGCHANGE,
   * WM_POWERBROADCAST, WM_DEVICECHANGE, TaskbarCreated) do not reach it. Default false: a hidden
   * top-level tool window, which gets them.
   */
  readonly messageOnly?: boolean;
  /** An HWND to make the window a WS_CHILD of (not with `messageOnly`). */
  readonly parent?: bigint | number;
  /** Child windows made on the window's thread under it (a replacement Shell_TrayWnd's TrayNotifyWnd, SysPager, ToolbarWindow32, …). Up to 256, 16 deep. */
  readonly children?: readonly MessageWindowChild[];
  /** CreateWindowExW dwStyle / dwExStyle. Default WS_POPUP (WS_CHILD with `parent`) / WS_EX_TOOLWINDOW | WS_EX_NOACTIVATE (never shown). */
  readonly style?: number;
  readonly exStyle?: number;
  /** Window messages delivered to `onMessage`. Every other message gets DefWindowProcW (WM_CLOSE gets 0: only dispose() closes the window). */
  readonly messages?: readonly MessageWindowMessage[];
  /**
   * Messages (delivered like `messages`) whose sender waits (SendMessage) for what `onMessage`
   * returns, at most `replyTimeout` ms; past that, or when `onMessage` returns undefined, the
   * `replies` value or DefWindowProcW answers. The window's thread blocks meanwhile, so keep these
   * few and `onMessage` quick for them; a SendMessage from the JavaScript thread itself always
   * gets the fallback after the timeout.
   */
  readonly waitReplies?: readonly MessageWindowMessage[];
  /** Milliseconds, 0-5000. Default 50. */
  readonly replyTimeout?: number;
  /** Fixed answers, given at once on the window's thread to any message, delivered or not (keys: message numbers or registered names). Change with `setReply`. */
  readonly replies?: Readonly<Record<string, MessageWindowReply>>;
  /** Fixed answers by (message, wParam) or by WM_COPYDATA dwData, given natively like `replies`; the message is still delivered when listed in `messages`. */
  readonly keyedReplies?: readonly MessageWindowKeyedReply[];
  /** SetWinEventHook ranges (out of context, delivered on the window's thread). */
  readonly winEvents?: readonly MessageWindowWinEvent[];
  /** RegisterShellHookWindow: HSHELL_* notifications as `shell` events. */
  readonly shellHook?: boolean;
  /** Registry keys whose changes arrive as `registry` events (RegNotifyChangeKeyValue). */
  readonly registry?: readonly MessageWindowRegistryWatch[];
  /** Folders whose changes arrive as `folder` events (FindFirstChangeNotificationW). Up to 62 registry keys and folders together. */
  readonly folders?: readonly MessageWindowFolderWatch[];
  /** Message ranges delivered like `messages` (up to 64). */
  readonly messageRanges?: readonly MessageWindowRange[];
  /** Messages answered by the window's twin (another process's window of the same classes), natively. */
  readonly forward?: MessageWindowForward;
  /** Icons whose pixels delivered messages carry to `onMessage` (up to 64). */
  readonly icons?: readonly MessageWindowIconSource[];
  /**
   * Keeps the top window the first of its class (what FindWindow returns, e.g. the Shell_TrayWnd
   * Shell_NotifyIcon finds), checked every this many ms (50-60000) by a timer on the window's
   * thread: Windows tells no one when a hidden window loses that place. Top-level windows only.
   */
  readonly keepFirst?: number;
  /** Runs on the JavaScript thread, in order. Its result answers a `waiting` message. */
  readonly onMessage: (event: MessageWindowEvent) => MessageWindowReply | void;
}

export interface MessageWindow {
  readonly hwnd: bigint;
  readonly className: string;
  /** The child windows, depth first. */
  readonly children: readonly MessageWindowChildInfo[];
  /** The native thread pumping the window (for AttachThreadInput, PostThreadMessage). */
  readonly threadId: number;
  /** Ids of the registered messages named in the options. */
  readonly messageIds: Readonly<Record<string, number>>;
  /** The shell hook's message id (0 without `shellHook`). */
  readonly shellHookMessage: number;
  readonly disposed: boolean;
  /** Sets the fixed answer to `message` (to the top window, or `target`: a window of the tree's hwnd, or its hwnd and a wParam or dwData key); null clears it. */
  setReply(message: MessageWindowMessage, value: MessageWindowReply | null, target?: bigint | number | MessageWindowReplyTarget): void;
  /** Unhooks everything, destroys the window and stops its thread (waits for it). Calls not yet delivered are dropped. While a window is open, the process stays alive. */
  dispose(): void;
}

/** messageWindow runs on Windows only. */
export class MessageWindowUnsupportedError extends Error {
  override readonly name = "MessageWindowUnsupportedError";
}

function lastError(): string {
  const message = new Uint8Array(1024);
  const written = threadsafeNative().tarve_last_error(message, message.length);
  return new TextDecoder().decode(message.subarray(0, Math.max(0, written)));
}

const KIND = { message: 1n, winEvent: 2n, shell: 3n, registry: 4n, folder: 5n, icon: 6n } as const;
const WM_SETTINGCHANGE = 0x1a;
const WM_COPYDATA = 0x4a;

/** `value`'s low `bits` as a signed integer (BigInt.asIntN, which QuickJS gets wrong for negative values). */
function signed(value: bigint, bits: bigint): bigint {
  const low = value & ((1n << bits) - 1n);
  return low >= 1n << (bits - 1n) ? low - (1n << bits) : low;
}

/** An i64 argument: a number while it is exact (txiki.js's FFI takes 64-bit integers as numbers). */
function i64(value: MessageWindowReply): number | bigint {
  const wide = typeof value === "boolean" ? (value ? 1n : 0n) : BigInt(value);
  const fitted = signed(wide, 64n);
  return fitted >= BigInt(Number.MIN_SAFE_INTEGER) && fitted <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(fitted) : fitted;
}

/** UTF-16LE bytes as a string (txiki.js's TextDecoder knows only UTF-8). */
function utf16(bytes: Uint8Array): string {
  let text = "";
  for (let at = 0; at + 1 < bytes.length; at += 2048) {
    const end = Math.min(bytes.length & ~1, at + 2048);
    const units: number[] = [];
    for (let index = at; index < end; index += 2) units.push(bytes[index]! | (bytes[index + 1]! << 8));
    text += String.fromCharCode(...units);
  }
  return text;
}

const U64 = (1n << 64n) - 1n;

/** A u64 argument: a number while it is exact. */
function u64(value: bigint): number | bigint {
  return value <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(value) : value;
}

/** A reply's key: [kind (0 none, 1 wParam, 2 dwData), key]. */
function replyKey(match: { readonly wParam?: number | bigint; readonly dwData?: number | bigint }): [number, bigint] {
  if (match.wParam !== undefined && match.dwData !== undefined) throw new TypeError("messageWindow: a reply is keyed by wParam or by dwData, not both");
  const key = match.wParam ?? match.dwData;
  if (key === undefined) return [0, 0n];
  if (typeof key === "number" ? !Number.isInteger(key) : typeof key !== "bigint") throw new TypeError(`messageWindow: invalid reply key ${String(key)}`);
  return [match.wParam !== undefined ? 1 : 2, BigInt(key) & U64];
}

function replyEntries(replies?: Readonly<Record<string, MessageWindowReply>>, keyed?: readonly MessageWindowKeyedReply[]): unknown[] {
  const entries: unknown[] = Object.entries(replies ?? {}).map(([key, value]) => [checkMessage(messageName(key)), Number(i64(value))]);
  for (const entry of keyed ?? []) {
    const [kind, key] = replyKey(entry);
    entries.push(kind ? [checkMessage(entry.message), Number(i64(entry.value)), kind, String(key)] : [checkMessage(entry.message), Number(i64(entry.value))]);
  }
  return entries;
}

function childJson(child: MessageWindowChild): unknown {
  if (typeof child?.className !== "string" || !child.className) throw new TypeError("messageWindow: every child needs a className");
  return {
    className: child.className, windowName: child.windowName, style: child.style, exStyle: child.exStyle,
    replies: replyEntries(child.replies, child.keyedReplies), children: (child.children ?? []).map(childJson),
  };
}

function handle(value: bigint | number): number {
  const wide = BigInt(value);
  if (wide <= 0n || wide > BigInt(Number.MAX_SAFE_INTEGER)) throw new RangeError(`messageWindow: invalid window handle ${String(value)}`);
  return Number(wide);
}

function ranges(list: readonly MessageWindowRange[] | undefined, what: string): [number, number][] {
  return (list ?? []).map(range => {
    const [min, max] = Array.isArray(range) ? range : [];
    const valid = (value: unknown) => typeof value === "number" && Number.isInteger(value) && value >= 0 && value <= 0xffffffff;
    if (!valid(min) || !valid(max) || min! > max!) throw new TypeError(`messageWindow: invalid ${what} range ${String(range)}`);
    return [min!, max!];
  });
}

function iconJson(source: MessageWindowIconSource): unknown {
  const offset = (value: unknown, what: string) => {
    if (value !== undefined && (typeof value !== "number" || !Number.isInteger(value) || value < 0 || value > 0xffff)) throw new TypeError(`messageWindow: invalid icon ${what} ${String(value)}`);
    return value as number | undefined;
  };
  const [, dwData] = replyKey({ dwData: source.dwData });
  const mask = source.when?.mask;
  if (source.when && (typeof mask !== "number" || !Number.isInteger(mask) || mask <= 0 || mask > 0xffffffff)) throw new TypeError(`messageWindow: invalid icon mask ${String(mask)}`);
  return {
    message: checkMessage(source.message),
    dwData: source.dwData === undefined ? undefined : String(dwData),
    offset: offset(source.offset, "offset"),
    when: source.when ? [offset(source.when.offset, "when.offset"), mask] : undefined,
  };
}

function messageName(key: string): MessageWindowMessage {
  return /^(0|[1-9][0-9]*)$/.test(key) ? Number(key) : key;
}

function checkMessage(message: MessageWindowMessage): MessageWindowMessage {
  if (typeof message === "number" ? !Number.isInteger(message) || message < 0 || message > 0xffffffff : typeof message !== "string" || !message) {
    throw new TypeError(`messageWindow: invalid message ${String(message)}`);
  }
  return message;
}

/**
 * A hidden window on a dedicated native thread with its own GetMessage loop, for what Windows
 * only tells a window or a hooking thread: broadcasts (WM_SETTINGCHANGE, WM_POWERBROADCAST,
 * WM_DEVICECHANGE, "TaskbarCreated"), WinEvents, the shell hook, registry and folder change
 * notifications, or a window class other processes look for (Shell_TrayWnd).
 *
 * ```ts
 * const watcher = messageWindow({
 *   messages: [0x1a],                              // WM_SETTINGCHANGE
 *   winEvents: [{ min: 0x0003 }],                  // EVENT_SYSTEM_FOREGROUND
 *   shellHook: true,
 *   onMessage(event) {
 *     if (event.type === "message" && event.text === "ImmersiveColorSet") refreshTheme();
 *     if (event.type === "winEvent") focusChanged(event.hwnd);
 *   },
 * });
 * // later: watcher.dispose();
 * ```
 *
 * Throws MessageWindowUnsupportedError elsewhere than Windows.
 */
export function messageWindow(options: MessageWindowOptions): MessageWindow {
  if (process.platform !== "win32") throw new MessageWindowUnsupportedError("messageWindow is only available on Windows");
  if (typeof options?.onMessage !== "function") throw new TypeError("messageWindow needs an onMessage function");
  const timeout = options.replyTimeout;
  if (timeout !== undefined && (!Number.isInteger(timeout) || timeout < 0 || timeout > 5000)) {
    throw new RangeError("messageWindow: replyTimeout must be an integer from 0 to 5000");
  }
  const keepFirst = options.keepFirst;
  if (keepFirst !== undefined && (!Number.isInteger(keepFirst) || keepFirst < 50 || keepFirst > 60000)) {
    throw new RangeError("messageWindow: keepFirst must be an integer from 50 to 60000 (ms)");
  }
  const forwardTimeout = options.forward?.timeout;
  if (forwardTimeout !== undefined && (!Number.isInteger(forwardTimeout) || forwardTimeout < 1 || forwardTimeout > 10000)) {
    throw new RangeError("messageWindow: forward.timeout must be an integer from 1 to 10000");
  }
  const registry = options.registry ?? [];
  const folders = options.folders ?? [];
  const json = {
    className: options.className,
    windowName: options.windowName,
    messageOnly: options.messageOnly ?? false,
    parent: options.parent === undefined ? undefined : handle(options.parent),
    children: (options.children ?? []).map(childJson),
    style: options.style,
    exStyle: options.exStyle,
    messages: (options.messages ?? []).map(checkMessage),
    waitReplies: (options.waitReplies ?? []).map(checkMessage),
    replyTimeout: timeout,
    replies: replyEntries(options.replies, options.keyedReplies),
    winEvents: (options.winEvents ?? []).map(hook => ({
      min: hook.min, max: hook.max, process: hook.process ?? 0, thread: hook.thread ?? 0,
      flags: (hook.skipOwnThread ? 1 : 0) | (hook.skipOwnProcess ? 2 : 0),
    })),
    shellHook: options.shellHook ?? false,
    registry,
    folders,
    messageRanges: ranges(options.messageRanges, "messageRanges"),
    forward: options.forward ? {
      messages: (options.forward.messages ?? []).map(checkMessage),
      ranges: ranges(options.forward.ranges, "forward"),
      timeout: forwardTimeout,
    } : undefined,
    icons: (options.icons ?? []).map(iconJson),
    keepFirst,
  };
  const symbols = threadsafeNative();
  const decoder = new TextDecoder();
  let id = 0;
  let disposed = false;
  const onMessage = options.onMessage;
  // hwnd -> its window of the tree, filled once the window exists (records arrive after that).
  const targets = new Map<bigint, MessageWindowTarget>();
  let top: MessageWindowTarget = { hwnd: 0n, className: "" };
  // An icon's pixels arrive just before the message that carried it (same thread, same queue).
  let icon: MessageWindowIcon | undefined;
  const callback = threadsafeRecordCallback((args, copied) => {
    if (disposed) return;
    const [kind, a1, a2, a3, a4, a5] = args as [bigint, bigint, bigint, bigint, bigint, bigint];
    switch (kind) {
      case KIND.message: {
        const message = Number(a1);
        const sequence = a4;
        let extra: Partial<Extract<MessageWindowEvent, { type: "message" }>> = {};
        if (copied) {
          if (message === WM_COPYDATA && copied.length >= 8) {
            extra = { copyData: { dwData: new DataView(copied.buffer, copied.byteOffset, 8).getBigUint64(0, true), data: copied.subarray(8) } };
          } else if (message === WM_SETTINGCHANGE) {
            extra = { data: copied, text: utf16(copied) };
          } else {
            extra = { data: copied };
          }
        } else if (message === WM_SETTINGCHANGE) {
          extra = { text: "" };
        }
        if (icon) {
          extra = { ...extra, icon };
          icon = undefined;
        }
        const result = onMessage({ type: "message", window: targets.get(a5) ?? top, message, wParam: a2, lParam: signed(a3, 64n), ...extra, waiting: sequence !== 0n });
        if (sequence !== 0n && result !== undefined && !disposed) symbols.tarve_message_window_reply(id, sequence, i64(result));
        return;
      }
      case KIND.icon:
        if (copied) icon = Object.freeze({ width: Number(a1), height: Number(a2), rgba: copied });
        return;
      case KIND.winEvent:
        onMessage({ type: "winEvent", event: Number(a1), hwnd: a2, idObject: Number(signed(a3, 32n)), idChild: Number(signed(a3 >> 32n, 32n)), thread: Number(a4), time: Number(a5) });
        return;
      case KIND.shell:
        onMessage({ type: "shell", code: Number(signed(a1, 32n)), lParam: signed(a2, 64n) });
        return;
      case KIND.registry: {
        const index = Number(a1);
        onMessage({ type: "registry", index, key: registry[index]?.key ?? "", ended: a2 !== 0n });
        return;
      }
      case KIND.folder: {
        const index = Number(a1) - registry.length;
        onMessage({ type: "folder", index, path: folders[index]?.path ?? "", ended: a2 !== 0n });
        return;
      }
    }
  });
  let info: {
    hwnd: string; className: string; threadId: number; messages: Record<string, number>; shellHook: number;
    children: { hwnd: string; parent: string; className: string; windowName: string }[];
  };
  try {
    const bytes = new TextEncoder().encode(JSON.stringify(json));
    id = Number(symbols.tarve_message_window_open(bytes, bytes.length, callback.pointer));
    if (!id) throw new Error(`messageWindow: ${lastError()}`);
    for (let size = 1024; ;) {
      const out = new Uint8Array(size);
      const length = symbols.tarve_message_window_info(id, out, size);
      if (length >= 0) {
        info = JSON.parse(decoder.decode(out.subarray(0, length)));
        break;
      }
      if (length === -1) throw new Error(`messageWindow: ${lastError()}`);
      size = -length;
    }
  } catch (error) {
    disposed = true;
    if (id) symbols.tarve_message_window_close(id);
    callback.close();
    throw error;
  }
  const messageIds = Object.freeze({ ...info.messages });
  top = Object.freeze({ hwnd: BigInt(info.hwnd), className: info.className });
  targets.set(top.hwnd, top);
  const children = Object.freeze(info.children.map(child => {
    const described = Object.freeze({ hwnd: BigInt(child.hwnd), className: child.className, windowName: child.windowName, parent: BigInt(child.parent) });
    targets.set(described.hwnd, Object.freeze({ hwnd: described.hwnd, className: described.className }));
    return described;
  }));
  return {
    hwnd: top.hwnd,
    className: top.className,
    children,
    threadId: info.threadId,
    messageIds,
    shellHookMessage: info.shellHook,
    get disposed() { return disposed; },
    setReply(message, value, target) {
      if (disposed) throw new Error("messageWindow: disposed");
      checkMessage(message);
      const where: MessageWindowReplyTarget = typeof target === "object" && target !== null ? target : { hwnd: target };
      const hwnd = where.hwnd === undefined ? top.hwnd : BigInt(where.hwnd);
      if (!targets.has(hwnd)) throw new RangeError(`messageWindow: ${hwnd} is not a window of this message window`);
      const [kind, key] = replyKey(where);
      const number = typeof message === "number" ? message : messageIds[message];
      if (number === undefined) throw new RangeError(`messageWindow: "${message}" is not one of this window's registered messages`);
      symbols.tarve_message_window_set_reply(id, u64(hwnd), number, kind, u64(key), value === null ? 0 : 1, value === null ? 0 : i64(value));
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      symbols.tarve_message_window_close(id);
      callback.close();
    },
  };
}
