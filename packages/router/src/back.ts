/**
 * Back navigation wiring: desktop shortcuts and the mouse back button through an app handle,
 * Android's hardware back through the window's close request. No Tarve runtime import.
 */

/** What a router needs from `createApp(...)`'s handle; `AppHandle` satisfies it. */
export interface RouterApp {
  update(): void;
  registerHotkey?(shortcut: string, handler: () => void): () => void;
  onEvent?(listener: (event: RouterAppEvent) => void): () => void;
}

/** The fields of a native event the router reads (`pointer` events need `createApp(view, { pointerEvents: true })`). */
export interface RouterAppEvent {
  type: string;
  phase?: string;
  button?: number;
}

export interface BackTarget {
  back(): boolean;
  canGoBack(): boolean;
}

export interface AttachOptions {
  /** Shortcuts that go back. Default `["Alt+Left"]`; `false` registers none. */
  hotkeys?: readonly string[] | false;
  /** The mouse's back button (button 3) goes back. Needs `pointerEvents: true` on the app. Default true. */
  mouseBack?: boolean;
}

/** `<Window onCloseRequest>`'s event. */
export interface CloseRequestEvent {
  preventDefault(): void;
}

/**
 * When the window's close request means "back": `"android"` (default) only on Android, where the
 * hardware back key asks to close the window; `"always"` also on desktops; `false` never.
 */
export type BackOnCloseRequest = "android" | "always" | false;

/** The mouse button number native reports for the back button (winit `MouseButton::Back`). */
export const MOUSE_BACK_BUTTON = 3;

export function isAndroid(): boolean {
  return typeof process !== "undefined" && (process.platform as string) === "android";
}

/** Registers the back shortcuts and mouse button of `target` on `app`; returns the undo. */
export function attachBack(app: RouterApp, target: BackTarget, options: AttachOptions = {}): () => void {
  const undo: (() => void)[] = [];
  const hotkeys = options.hotkeys === false ? [] : options.hotkeys ?? ["Alt+Left"];
  if (app.registerHotkey) {
    for (const shortcut of hotkeys) undo.push(app.registerHotkey(shortcut, () => { target.back(); }));
  }
  if (options.mouseBack !== false && app.onEvent) {
    undo.push(app.onEvent(event => {
      if (event.type === "pointer" && event.phase === "up" && event.button === MOUSE_BACK_BUTTON && target.back()) app.update();
    }));
  }
  return () => {
    for (const fn of undo.splice(0)) fn();
  };
}

/** A `<Window onCloseRequest>` handler that goes back instead of closing while the router can. */
export function closeRequestBack(target: BackTarget, mode: BackOnCloseRequest): (event: CloseRequestEvent) => void {
  return event => {
    const handles = mode === "always" || (mode === "android" && isAndroid());
    if (handles && target.canGoBack() && target.back()) event.preventDefault();
  };
}

const ACTIVE_APP_KEY = Symbol.for("tarve.activeApp");

/**
 * Asks for a render after a navigation. Inside an event handler Tarve renders anyway; outside one
 * (a timer, a fetch) the attached apps, else the app that last handled an event, render.
 */
export function requestRender(apps: ReadonlySet<RouterApp>): void {
  if (apps.size > 0) {
    for (const app of apps) app.update();
    return;
  }
  const active = (globalThis as Record<symbol, { update?(): void } | undefined>)[ACTIVE_APP_KEY];
  active?.update?.();
}
