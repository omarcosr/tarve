import { openLibrary, ownLibraryPath } from "./bridge/binding";
import { openPluginLibrary, type PluginLibrary } from "./plugins/ffi";
import { threadsafeCallback, type ThreadsafeCallback } from "./threadsafe";

/** Another app's media session (Windows Global System Media Transport Controls). */
export interface ExternalMediaSession {
  /** The app's AppUserModelID (`Spotify.exe`, `Microsoft.ZuneMusic_8wekyb3d8bbwe!Microsoft.ZuneMusic`). */
  appId: string;
  title: string;
  artist?: string;
  album?: string;
  /** The thumbnail the app published (PNG or JPEG bytes), base64. */
  artwork?: string;
  playing: boolean;
  /** Seconds from the start of the track. */
  position?: number;
  /** Seconds. */
  duration?: number;
  /** The session Windows routes media keys to. */
  current: boolean;
}

export type SystemMediaSessionAction = "play" | "pause" | "toggle" | "next" | "previous";

/** The FFI's action codes (native/src/media_sessions.rs `MediaAction::from_code`). */
const ACTIONS: Record<SystemMediaSessionAction, number> = { play: 0, pause: 1, toggle: 2, next: 3, previous: 4 };

type Library = ReturnType<typeof openLibrary>;

let opened: Library | undefined;
/** Tarve's library, opened once and kept: every read goes through it, on Bun, Node.js and txiki.js alike. */
function withLibrary<T>(use: (library: Library) => T): T {
  opened ??= openLibrary(ownLibraryPath("systemMediaSessions"));
  return use(opened);
}

const WATCH_SYMBOLS = {
  tarve_media_sessions_watch: { args: ["u64"], returns: "i32" },
  tarve_media_sessions_unwatch: { args: [], returns: "i32" },
} as const;
let watchLibrary: PluginLibrary<typeof WATCH_SYMBOLS> | undefined;

type SessionsListener = (sessions: ExternalMediaSession[]) => void;
const listeners = new Set<SessionsListener>();
/** The native watch, while anyone listens: its change callback and the last version delivered. */
let watching: { callback: ThreadsafeCallback; version: bigint } | undefined;

function deliver(to: Iterable<SessionsListener>): void {
  let sessions: ExternalMediaSession[];
  try {
    sessions = withLibrary(readMediaSessions);
  } catch (error) {
    console.error("[tarve] onSystemMediaSessionsChange", error);
    return;
  }
  for (const listener of [...to]) {
    if (!listeners.has(listener)) continue;
    try { listener(sessions); } catch (error) { console.error("[tarve] onSystemMediaSessionsChange", error); }
  }
}

function startWatching(): void {
  const callback = threadsafeCallback((version: bigint) => {
    // Several changes queued while JavaScript was busy: the list read now already has the last one.
    if (!watching || version <= watching.version) return;
    watching.version = version;
    deliver(listeners);
  }, { args: ["u64"] });
  watchLibrary ??= openPluginLibrary(ownLibraryPath("onSystemMediaSessionsChange"), WATCH_SYMBOLS, "onSystemMediaSessionsChange");
  watching = { callback, version: 0n };
  if (watchLibrary.symbols.tarve_media_sessions_watch(callback.pointer) < 0) {
    watching = undefined;
    callback.close();
    throw withLibrary(library => failure(library, "onSystemMediaSessionsChange"));
  }
}

function stopWatching(): void {
  if (!watching) return;
  const { callback } = watching;
  watching = undefined;
  watchLibrary?.symbols.tarve_media_sessions_unwatch();
  callback.close();
}

function failure(library: Library, call: string): Error {
  const buffer = new Uint8Array(4096);
  const length = library.symbols.tarve_last_error(buffer, buffer.length);
  return new Error(`${call}: ${new TextDecoder().decode(buffer.subarray(0, Math.max(0, length))) || "native call failed"}`);
}

function symbol<K extends "tarve_media_sessions" | "tarve_media_session_control">(library: Library, name: K): NonNullable<Library["symbols"][K]> {
  const found = library.symbols[name];
  if (!found) throw new Error(`${name} is missing from the native library`);
  return found as NonNullable<Library["symbols"][K]>;
}

/** The session list, read through `library` (the native library, or a stand-in in tests). */
export function readMediaSessions(library: Library): ExternalMediaSession[] {
  const list = symbol(library, "tarve_media_sessions");
  let buffer = new Uint8Array(256 * 1024);
  let length = list(buffer, buffer.length);
  // Below -1: the capacity the list needs; the native side keeps it for this second call.
  if (length < -1) {
    buffer = new Uint8Array(-length);
    length = list(buffer, buffer.length);
  }
  if (length < 0) throw failure(library, "systemMediaSessions");
  return JSON.parse(new TextDecoder().decode(buffer.subarray(0, length))) as ExternalMediaSession[];
}

/** Sends `action` to `appId`'s session through `library`: whether the app accepted. */
export function sendMediaSessionAction(library: Library, appId: string, action: SystemMediaSessionAction): boolean {
  const id = new TextEncoder().encode(appId);
  const result = symbol(library, "tarve_media_session_control")(ACTIONS[action], id, id.length);
  if (result < 0) throw failure(library, "controlSystemMediaSession");
  return result === 1;
}

function checkAction(appId: string, action: SystemMediaSessionAction): void {
  if (!Object.hasOwn(ACTIONS, action)) throw new TypeError(`controlSystemMediaSession: unknown action ${String(action)}`);
  if (typeof appId !== "string" || appId.length === 0) throw new TypeError("controlSystemMediaSession: appId must be a non-empty string");
}

/**
 * The media sessions of every app on the system (what each one plays, whether it is playing),
 * the one media keys reach marked `current`. Windows only; resolves `[]` elsewhere.
 */
export async function systemMediaSessions(): Promise<ExternalMediaSession[]> {
  // While onSystemMediaSessionsChange listens, this reads the list it keeps: no call into Windows.
  if (process.platform !== "win32") return [];
  return withLibrary(readMediaSessions);
}

/**
 * Asks another app's media session (by `appId`, as `systemMediaSessions()` lists it) to play,
 * pause, toggle, or skip to the next or previous track. Resolves whether the app accepted:
 * false when it refused or no session has that id, and always false off Windows.
 */
export async function controlSystemMediaSession(appId: string, action: SystemMediaSessionAction): Promise<boolean> {
  checkAction(appId, action);
  if (process.platform !== "win32") return false;
  return withLibrary(library => sendMediaSessionAction(library, appId, action));
}

/**
 * Calls `listener` with every app's media sessions now and whenever they change: an app starts or
 * stops playing, the current session, the track, the play state or the timeline (a seek, a new
 * position the app published). Windows events, not polling: one native thread follows them, and
 * a burst of events gives one call. While anyone listens, `systemMediaSessions()` answers from the
 * same list without asking Windows. Returns the unsubscribe function; the watch stops with the
 * last listener. Windows only; elsewhere the listener gets `[]` once.
 *
 * `position` is where the track was when the app last published its timeline (apps do so on
 * seeks and every few seconds, not continuously): advance it while `playing`.
 */
export function onSystemMediaSessionsChange(listener: (sessions: ExternalMediaSession[]) => void): () => void {
  if (typeof listener !== "function") throw new TypeError("onSystemMediaSessionsChange: listener must be a function");
  if (process.platform !== "win32") {
    let active = true;
    queueMicrotask(() => { if (active) listener([]); });
    return () => { active = false; };
  }
  const subscriber: SessionsListener = sessions => listener(sessions);
  listeners.add(subscriber);
  if (!watching) {
    try {
      startWatching();
    } catch (error) {
      listeners.delete(subscriber);
      throw error;
    }
  }
  // Its first list, from the kept one (the watch already published it).
  queueMicrotask(() => deliver([subscriber]));
  return () => {
    if (!listeners.delete(subscriber)) return;
    if (!listeners.size) stopWatching();
  };
}

