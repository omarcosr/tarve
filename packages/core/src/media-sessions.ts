import { nativePath } from "#tarve/runtime";
import { openLibrary } from "./bridge/binding";

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

function withLibrary<T>(use: (library: Library) => T): T {
  // Through the native library, so Bun, Node.js and txiki.js behave the same.
  const library = openLibrary(nativePath());
  try { return use(library); } finally { library.close(); }
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

/**
 * The media sessions of every app on the system (what each one plays, whether it is playing),
 * the one media keys reach marked `current`. Windows only; resolves `[]` elsewhere.
 */
export async function systemMediaSessions(): Promise<ExternalMediaSession[]> {
  if (process.platform !== "win32") return [];
  const json = withLibrary(library => {
    const list = symbol(library, "tarve_media_sessions");
    let buffer = new Uint8Array(256 * 1024);
    let length = list(buffer, buffer.length);
    // Below -1: the capacity the list needs; the native side keeps it for this second call.
    if (length < -1) {
      buffer = new Uint8Array(-length);
      length = list(buffer, buffer.length);
    }
    if (length < 0) throw failure(library, "systemMediaSessions");
    return new TextDecoder().decode(buffer.subarray(0, length));
  });
  return JSON.parse(json) as ExternalMediaSession[];
}

/**
 * Asks another app's media session (by `appId`, as `systemMediaSessions()` lists it) to play,
 * pause, toggle, or skip to the next or previous track. Resolves whether the app accepted:
 * false when it refused or no session has that id, and always false off Windows.
 */
export async function controlSystemMediaSession(appId: string, action: SystemMediaSessionAction): Promise<boolean> {
  const code = ACTIONS[action];
  if (code === undefined || !Object.hasOwn(ACTIONS, action)) throw new TypeError(`controlSystemMediaSession: unknown action ${String(action)}`);
  if (typeof appId !== "string" || appId.length === 0) throw new TypeError("controlSystemMediaSession: appId must be a non-empty string");
  if (process.platform !== "win32") return false;
  return withLibrary(library => {
    const id = new TextEncoder().encode(appId);
    const result = symbol(library, "tarve_media_session_control")(code, id, id.length);
    if (result < 0) throw failure(library, "controlSystemMediaSession");
    return result === 1;
  });
}
