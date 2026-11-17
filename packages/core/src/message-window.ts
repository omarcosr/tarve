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

export type MessageWindowEvent =
  | {
    readonly type: "message";
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
  /** CreateWindowExW dwStyle / dwExStyle. Default WS_POPUP / WS_EX_TOOLWINDOW | WS_EX_NOACTIVATE (never shown). */
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
  /** SetWinEventHook ranges (out of context, delivered on the window's thread). */
  readonly winEvents?: readonly MessageWindowWinEvent[];
  /** RegisterShellHookWindow: HSHELL_* notifications as `shell` events. */
  readonly shellHook?: boolean;
  /** Registry keys whose changes arrive as `registry` events (RegNotifyChangeKeyValue). */
  readonly registry?: readonly MessageWindowRegistryWatch[];
  /** Folders whose changes arrive as `folder` events (FindFirstChangeNotificationW). Up to 62 registry keys and folders together. */
  readonly folders?: readonly MessageWindowFolderWatch[];
  /** Runs on the JavaScript thread, in order. Its result answers a `waiting` message. */
  readonly onMessage: (event: MessageWindowEvent) => MessageWindowReply | void;
}

export interface MessageWindow {
  readonly hwnd: bigint;
  /** The native thread pumping the window (for AttachThreadInput, PostThreadMessage). */
  readonly threadId: number;
  /** Ids of the registered messages named in the options. */
  readonly messageIds: Readonly<Record<string, number>>;
  /** The shell hook's message id (0 without `shellHook`). */
  readonly shellHookMessage: number;
  readonly disposed: boolean;
  /** Sets the fixed answer to `message`; null clears it. */
  setReply(message: MessageWindowMessage, value: MessageWindowReply | null): void;
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

const KIND = { message: 1n, winEvent: 2n, shell: 3n, registry: 4n, folder: 5n } as const;
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
  const registry = options.registry ?? [];
  const folders = options.folders ?? [];
  const json = {
    className: options.className,
    windowName: options.windowName,
    messageOnly: options.messageOnly ?? false,
    style: options.style,
    exStyle: options.exStyle,
    messages: (options.messages ?? []).map(checkMessage),
    waitReplies: (options.waitReplies ?? []).map(checkMessage),
    replyTimeout: timeout,
    replies: Object.entries(options.replies ?? {}).map(([key, value]) => [checkMessage(messageName(key)), Number(i64(value))]),
    winEvents: (options.winEvents ?? []).map(hook => ({
      min: hook.min, max: hook.max, process: hook.process ?? 0, thread: hook.thread ?? 0,
      flags: (hook.skipOwnThread ? 1 : 0) | (hook.skipOwnProcess ? 2 : 0),
    })),
    shellHook: options.shellHook ?? false,
    registry,
    folders,
  };
  const symbols = threadsafeNative();
  const decoder = new TextDecoder();
  let id = 0;
  let disposed = false;
  const onMessage = options.onMessage;
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
        const result = onMessage({ type: "message", message, wParam: a2, lParam: signed(a3, 64n), ...extra, waiting: sequence !== 0n });
        if (sequence !== 0n && result !== undefined && !disposed) symbols.tarve_message_window_reply(id, sequence, i64(result));
        return;
      }
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
  let info: { hwnd: string; threadId: number; messages: Record<string, number>; shellHook: number };
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
  return {
    hwnd: BigInt(info.hwnd),
    threadId: info.threadId,
    messageIds,
    shellHookMessage: info.shellHook,
    get disposed() { return disposed; },
    setReply(message, value) {
      if (disposed) throw new Error("messageWindow: disposed");
      checkMessage(message);
      const number = typeof message === "number" ? message : messageIds[message];
      if (number === undefined) throw new RangeError(`messageWindow: "${message}" is not one of this window's registered messages`);
      symbols.tarve_message_window_set_reply(id, number, value === null ? 0 : 1, value === null ? 0 : i64(value));
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      symbols.tarve_message_window_close(id);
      callback.close();
    },
  };
}
