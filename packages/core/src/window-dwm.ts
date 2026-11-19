// What the taskbar shows of other windows (Windows, DWM): live thumbnails, Aero Peek, and the
// window attributes that keep a window out of the peek or skip its open/close animation. DWM
// draws all of it itself, from the windows' own surfaces: nothing is copied into the app.
import { ownLibraryPath } from "./bridge/binding";
import { openPluginLibrary, type PluginLibrary } from "./plugins/ffi";

/** A window handle (HWND): a number, a bigint or the string `app.nativeHandle()` gives. */
export type WindowHandle = bigint | number | string;

/** A rectangle in physical pixels. */
export interface WindowRect {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

export interface WindowThumbnailProperties {
  /** Where the picture goes, in the destination window's client area (physical px). */
  readonly rect?: WindowRect;
  /** The part of the source window shown (physical px, from its top left). Default: all of it. */
  readonly source?: WindowRect | null;
  /** 0-1. Default 1. */
  readonly opacity?: number;
  /** Default true. */
  readonly visible?: boolean;
  /** Only the source's client area, without its frame. Default false (the whole window, as the taskbar shows it). */
  readonly clientAreaOnly?: boolean;
}

export interface WindowThumbnail {
  /** The source window's size now (physical px); it follows the window. */
  readonly sourceSize: { readonly width: number; readonly height: number };
  readonly disposed: boolean;
  /** Changes what is given; the rest stays. */
  update(properties: WindowThumbnailProperties): void;
  dispose(): void;
}

/** These DWM calls run on Windows only. */
export class WindowDwmUnsupportedError extends Error {
  override readonly name = "WindowDwmUnsupportedError";
}

const DWM = {
  DwmRegisterThumbnail: { args: ["u64", "u64", "buffer"], returns: "i32" },
  DwmUnregisterThumbnail: { args: ["u64"], returns: "i32" },
  DwmUpdateThumbnailProperties: { args: ["u64", "buffer"], returns: "i32" },
  DwmQueryThumbnailSourceSize: { args: ["u64", "buffer"], returns: "i32" },
  DwmSetWindowAttribute: { args: ["u64", "u32", "buffer", "u32"], returns: "i32" },
} as const;
const OWN = {
  tarve_dwm_peek: { args: ["u64", "u64"], returns: "i32" },
  tarve_last_error: { args: ["buffer", "u32"], returns: "i32" },
} as const;

let dwmapi: PluginLibrary<typeof DWM> | undefined;
let own: PluginLibrary<typeof OWN> | undefined;

function dwm(what: string): PluginLibrary<typeof DWM>["symbols"] {
  if (process.platform !== "win32") throw new WindowDwmUnsupportedError(`${what} is only available on Windows`);
  return (dwmapi ??= openPluginLibrary("dwmapi.dll", DWM, what)).symbols;
}

/** An HWND as the FFI takes it: a number while exact. */
function hwnd(value: WindowHandle, what: string): number | bigint {
  let wide: bigint;
  try {
    wide = BigInt(value);
  } catch {
    throw new TypeError(`${what}: invalid window handle ${String(value)}`);
  }
  if (wide <= 0n || wide > 0xffffffffffffffffn) throw new TypeError(`${what}: invalid window handle ${String(value)}`);
  return wide <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(wide) : wide;
}

function failed(what: string, result: number): Error {
  return new Error(`${what} failed (HRESULT 0x${(result >>> 0).toString(16).padStart(8, "0")})`);
}

function checkRect(rect: WindowRect, what: string): void {
  if (![rect?.x, rect?.y, rect?.width, rect?.height].every(Number.isFinite) || rect.width < 0 || rect.height < 0) {
    throw new TypeError(`${what}: invalid rectangle ${JSON.stringify(rect)}`);
  }
}

/**
 * A live picture of `source` drawn by DWM into `destination` (a window of this app, e.g.
 * `app.nativeHandle()`), as the taskbar's previews: it moves and repaints with the source, minimized
 * windows included. Nothing shows until `rect` is given.
 *
 * ```ts
 * const preview = windowThumbnail(app.nativeHandle()!, target, { rect: { x: 8, y: 32, width: 224, height: 126 } });
 * // later: preview.dispose();
 * ```
 */
export function windowThumbnail(destination: WindowHandle, source: WindowHandle, properties: WindowThumbnailProperties = {}): WindowThumbnail {
  const symbols = dwm("windowThumbnail");
  const out = new Uint8Array(8);
  const result = symbols.DwmRegisterThumbnail(hwnd(destination, "windowThumbnail"), hwnd(source, "windowThumbnail"), out);
  if (result !== 0) throw failed("windowThumbnail: DwmRegisterThumbnail", result);
  const raw = new DataView(out.buffer).getBigUint64(0, true);
  const id = raw <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(raw) : raw;
  let disposed = false;
  const live = () => {
    if (disposed) throw new Error("windowThumbnail: disposed");
  };
  const update = (next: WindowThumbnailProperties) => {
    live();
    // DWM_THUMBNAIL_PROPERTIES: dwFlags, rcDestination at 4, rcSource at 20, BYTE opacity at 36,
    // BOOL fVisible at 40 and fSourceClientAreaOnly at 44 (aligned), 48 bytes.
    const bytes = new Uint8Array(48);
    const view = new DataView(bytes.buffer);
    let flags = 0;
    const rect = (offset: number, value: WindowRect, what: string) => {
      checkRect(value, what);
      view.setInt32(offset, Math.round(value.x), true);
      view.setInt32(offset + 4, Math.round(value.y), true);
      view.setInt32(offset + 8, Math.round(value.x + value.width), true);
      view.setInt32(offset + 12, Math.round(value.y + value.height), true);
    };
    if (next.rect !== undefined) {
      rect(4, next.rect, "windowThumbnail rect");
      flags |= 0x1;
    }
    if (next.source !== undefined) {
      // No source rectangle: DWM shows the whole window again.
      if (next.source) {
        rect(20, next.source, "windowThumbnail source");
        flags |= 0x2;
      }
    }
    if (next.opacity !== undefined) {
      if (!Number.isFinite(next.opacity) || next.opacity < 0 || next.opacity > 1) throw new RangeError("windowThumbnail: opacity must be from 0 to 1");
      view.setUint8(36, Math.round(next.opacity * 255));
      flags |= 0x4;
    }
    if (next.visible !== undefined) {
      view.setInt32(40, next.visible ? 1 : 0, true);
      flags |= 0x8;
    }
    if (next.clientAreaOnly !== undefined) {
      view.setInt32(44, next.clientAreaOnly ? 1 : 0, true);
      flags |= 0x10;
    }
    if (!flags) return;
    view.setUint32(0, flags, true);
    const updated = symbols.DwmUpdateThumbnailProperties(id, bytes);
    if (updated !== 0) throw failed("windowThumbnail: DwmUpdateThumbnailProperties", updated);
  };
  try {
    update({ visible: true, opacity: 1, clientAreaOnly: false, ...properties });
  } catch (error) {
    disposed = true;
    symbols.DwmUnregisterThumbnail(id);
    throw error;
  }
  return {
    get sourceSize() {
      live();
      const size = new Uint8Array(8);
      const queried = symbols.DwmQueryThumbnailSourceSize(id, size);
      if (queried !== 0) throw failed("windowThumbnail: DwmQueryThumbnailSourceSize", queried);
      const view = new DataView(size.buffer);
      return { width: view.getInt32(0, true), height: view.getInt32(4, true) };
    },
    get disposed() { return disposed; },
    update,
    dispose() {
      if (disposed) return;
      disposed = true;
      symbols.DwmUnregisterThumbnail(id);
    },
  };
}

/**
 * Aero Peek at `target`, as the taskbar does while the pointer rests on a thumbnail: it shows in
 * place, every other window fades to a glass outline, and `keepVisible` (the preview itself) stays
 * above. `null` ends the peek. Windows has no documented API for it; this is the call the taskbar
 * makes (dwmapi's DwmpActivateLivePreview), and it throws where Windows lacks it.
 */
export function peekWindow(target: WindowHandle | null, options: { readonly keepVisible?: WindowHandle } = {}): void {
  if (process.platform !== "win32") throw new WindowDwmUnsupportedError("peekWindow is only available on Windows");
  const symbols = (own ??= openPluginLibrary(ownLibraryPath("peekWindow"), OWN, "peekWindow")).symbols;
  const keep = options.keepVisible === undefined ? 0 : hwnd(options.keepVisible, "peekWindow");
  if (symbols.tarve_dwm_peek(target === null ? 0 : hwnd(target, "peekWindow"), keep) < 0) {
    const message = new Uint8Array(1024);
    const written = symbols.tarve_last_error(message, message.length);
    throw new Error(`peekWindow: ${new TextDecoder().decode(message.subarray(0, Math.max(0, written)))}`);
  }
}

export interface WindowPeekOptions {
  /** Stays visible while another window is peeked at, as the taskbar and the preview do (DWMWA_EXCLUDED_FROM_PEEK). */
  readonly excluded?: boolean;
  /** Is never peeked at itself (DWMWA_DISALLOW_PEEK). */
  readonly disallowed?: boolean;
  /** Shows and hides at once, without DWM's open/close animation (DWMWA_TRANSITIONS_FORCEDISABLED): a preview popup that must appear on time. */
  readonly transitions?: boolean;
}

/** Sets how DWM's peek and transitions treat `window` (one of this app's, e.g. `app.nativeHandle()`). Only what is given changes. */
export function setWindowPeek(window: WindowHandle, options: WindowPeekOptions): void {
  const symbols = dwm("setWindowPeek");
  const handle = hwnd(window, "setWindowPeek");
  const set = (attribute: number, on: boolean, name: string) => {
    const value = new Uint8Array(4);
    value[0] = on ? 1 : 0;
    const result = symbols.DwmSetWindowAttribute(handle, attribute, value, 4);
    if (result !== 0) throw failed(`setWindowPeek: DwmSetWindowAttribute(${name})`, result);
  };
  if (options.transitions !== undefined) set(3, !options.transitions, "DWMWA_TRANSITIONS_FORCEDISABLED");
  if (options.disallowed !== undefined) set(11, options.disallowed, "DWMWA_DISALLOW_PEEK");
  if (options.excluded !== undefined) set(12, options.excluded, "DWMWA_EXCLUDED_FROM_PEEK");
}
