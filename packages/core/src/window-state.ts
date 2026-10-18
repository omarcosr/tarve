import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";
import { runtimeAppMetadata } from "./app-metadata";
import type { WindowOptions } from "./protocol";

/** A window's restored bounds (logical px: outer position, client size) and whether it was maximized. */
export interface SavedWindowState {
  x: number; y: number; width: number; height: number; maximized: boolean;
  /** `x`/`y` are physical screen px (states saved before this were logical). */
  physical?: boolean;
}

/** Where the app keeps per-user settings: %APPDATA%, ~/Library/Application Support or $XDG_CONFIG_HOME. */
export function appConfigDirectory(app = appName()): string {
  const home = homedir();
  const base = process.platform === "win32"
    ? process.env.APPDATA ?? join(home, "AppData", "Roaming")
    : process.platform === "darwin"
      ? join(home, "Library", "Application Support")
      : process.env.XDG_CONFIG_HOME ?? join(home, ".config");
  return join(base, app.replace(/[<>:"/\\|?*\x00-\x1f]/g, "_"));
}

function appName(): string {
  const metadata = runtimeAppMetadata();
  const script = basename(process.argv[1] ?? process.execPath).replace(/\.[^.]+$/, "");
  return metadata.appId ?? metadata.name ?? script;
}

function valid(state: unknown): state is SavedWindowState {
  const s = state as SavedWindowState;
  return !!s && [s.x, s.y, s.width, s.height].every(n => typeof n === "number" && Number.isFinite(n) && Math.abs(n) < 32_768)
    && s.width > 0 && s.height > 0 && typeof s.maximized === "boolean" && (s.physical === undefined || typeof s.physical === "boolean");
}

/** Saved states by window key, in `<config>/window-state.json`. */
export class WindowStateStore {
  private states: Record<string, SavedWindowState> | undefined;
  private timer: ReturnType<typeof setTimeout> | undefined;
  constructor(readonly path = join(appConfigDirectory(), "window-state.json")) {}

  private load(): Record<string, SavedWindowState> {
    if (this.states) return this.states;
    this.states = {};
    try {
      if (existsSync(this.path)) {
        const raw = JSON.parse(readFileSync(this.path, "utf8")) as Record<string, unknown>;
        for (const [key, value] of Object.entries(raw)) if (valid(value)) this.states[key] = value;
      }
    } catch {}
    return this.states;
  }
  get(key: string): SavedWindowState | undefined {
    return this.load()[key];
  }
  /** Records a state; written after a short pause (or on `flush`), as moves come in bursts. */
  set(key: string, state: SavedWindowState): void {
    if (!valid(state)) return;
    this.load()[key] = state;
    clearTimeout(this.timer);
    this.timer = setTimeout(() => this.flush(), 400);
    (this.timer as { unref?: () => void }).unref?.();
  }
  flush(): void {
    if (this.timer === undefined) return;
    clearTimeout(this.timer);
    this.timer = undefined;
    try {
      mkdirSync(dirname(this.path), { recursive: true });
      const temporary = `${this.path}.${process.pid}.tmp`;
      writeFileSync(temporary, JSON.stringify(this.states ?? {}, null, 2));
      renameSync(temporary, this.path);
    } catch (error) {
      console.error("[tarve] could not save the window state", error);
    }
  }
}

let shared: WindowStateStore | undefined;
export function windowStateStore(): WindowStateStore {
  return shared ??= new WindowStateStore();
}

/** The window options with a saved state applied: size (kept within the minimum), position and maximized. */
export function applySavedState(window: WindowOptions, saved: SavedWindowState | undefined): WindowOptions {
  const next: WindowOptions = { ...window, reportWindowState: true };
  if (!saved || window.desktopWidget) return next;
  return {
    ...next,
    width: Math.max(saved.width, window.minWidth),
    height: Math.max(saved.height, window.minHeight),
    position: { x: saved.x, y: saved.y, ...(saved.physical ? { physical: true } : {}) },
    ...(saved.maximized ? { maximized: true } : {}),
  };
}
