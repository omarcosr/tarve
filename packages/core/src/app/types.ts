import type { FileDialogOptions, LayoutBox, NativeEvent, NativeCommand, NativeStats, NativeSystemMediaSession, PermissionState, PhaseSummary, Renderer, Snapshot, TextRendering } from "../protocol";
import { type MediaController } from "../media-element";
import { type NativeBridge } from "../bridge";
import { type HotkeyHandler } from "../hotkeys";
import { type VNode } from "../jsx-runtime";
import { type WebSignInOptions } from "./requests";
import { type TrayHandle, type TrayOptions } from "./tray";
import { type MenuBarItem, type MenuBarOptions } from "./menu-bar";
import type { ComponentAdapter } from "../component-adapter";
import { type DevOptions } from "../devtools/inspector";
import { type TarvePlugin } from "../plugins";
import { type OpenFilesListener, type OpenUrlListener } from "./open-requests";
import { type AuthenticateOptions, type AuthenticateResult, type PositionOptions, type PositionResult, type ShareOptions, type ShareResult } from "./device";
import type { FileTypeAssociation } from "../associations";

export type AppErrorSource =
  | "render"
  | "event-handler"
  | "listener"
  | "hotkey"
  | "bridge"
  | "native"
  | "request"
  | "file-dialog"
  | "plugin";

export interface AppErrorEvent {
  error: Error;
  source: AppErrorSource;
  event?: string;
  targetId?: string;
}

export interface AppOptions {
  debug?: boolean;
  /** Keep the native window hidden while still creating a real renderer surface. */
  headless?: boolean;
  /** Native renderer selected when the app starts. Explicit cpu/gpu wins over TARVE_RENDERER. */
  renderer?: Renderer;
  /** Optional adapters that translate foreign component types into Tarve VNodes. */
  componentAdapters?: readonly ComponentAdapter[];
  bridge?: NativeBridge;
  onError?: (event: AppErrorEvent) => void;
  /**
   * Development mode: runtime errors render an in-window overlay and render() remounts in the same window. Defaults to TARVE_DEV=1.
   * `{ inspector: true }` also opens the visual inspector window (component tree, props, layout, picker, render counts,
   * events); `TARVE_INSPECTOR=1` (`tarve dev --inspect`) opens it too. (TARVE_INSPECT is the automation's node-tree path.)
   */
  dev?: boolean | DevOptions;
  /** Show the native frame-time graph. Defaults to TARVE_FRAME_OVERLAY=1. Never schedules frames on its own. */
  frameOverlay?: boolean;
  /** Animation frames per second (transitions, `spin`, keyframes); `null` follows the display's refresh rate. Default 60. */
  maxFps?: number | null;
  /**
   * Font files the app ships, like CSS `@font-face`: TTF/OTF/WOFF2 paths (or `import font from "./Inter.ttf" with { type: "file" }`).
   * Each font is then available by its family name in `fontFamily`.
   */
  fontFaces?: readonly string[];
  /**
   * Remember the window's size, position and maximized state between runs, per user
   * (`<config dir>/<app>/window-state.json`): `true` for this window, or a key naming it.
   * A saved position off every monitor reopens the window centred.
   */
  rememberWindow?: boolean | string;
  /** What the window close button does without an onCloseRequest handler: quit (default) or hide the window, e.g. for tray apps. */
  closeBehavior?: "exit" | "hide";
  /**
   * GPU antialiasing on Windows (D3D11). `0` (default): no multisampling; shape edges
   * get a one-pixel coverage fringe, ~30 MB less memory. `2`, `4` or `8`: MSAA with that
   * many samples, smoother clip edges (rounded `overflow: hidden`, gradients). `TARVE_MSAA` overrides it.
   */
  msaa?: 0 | 2 | 4 | 8;
  /**
   * Text on Windows' GPU renderer. `"grayscale"` (default): the same glyph pixels as the
   * CPU renderer and Linux. `"cleartype"`: DirectWrite rasterizes glyphs with Windows'
   * hinting and subpixel ClearType, as native apps draw them; transparent windows, variable
   * fonts and a system with ClearType turned off keep grayscale. `TARVE_TEXT_RENDERING` overrides it.
   */
  textRendering?: TextRendering;
  /** Report every key press and release to `onEvent` as `keyboard` events (DOM `key`/`code`), whatever is focused. */
  keyboardEvents?: boolean;
  /** Report every mouse button press/release and wheel turn to `onEvent` as `pointer` events, on the deepest node under the pointer. */
  pointerEvents?: boolean;
  /**
   * Windows, opt-in: after this many ms without a new frame, move the process's pages to the
   * standby list (`EmptyWorkingSet`), and do the same when a window is hidden or minimized.
   * Task Manager's working set drops but nothing is freed: commit stays the same and touched
   * pages fault back in. Unset or `false` never trims. `TARVE_TRIM` (ms, or 0 to disable) overrides it.
   */
  memoryTrimDelay?: number | false;
  /**
   * Least memory over speed: the CPU renderer (no GPU driver, ~90 MB less, more CPU
   * per frame while animating or scrolling) and no MSAA. Explicit `renderer` and `msaa`
   * still win. A minimized or hidden window gives its renderer back
   * and asks Windows for EcoQoS with or without this option.
   */
  lowPower?: boolean;
  /**
   * Windows app identity (AppUserModelID). Without it, media controls and notifications show
   * the host executable (bun.exe, node.exe) or "Unknown app". `icon` is an .ico/.png path.
   */
  appIdentity?: { id: string; name: string; icon?: string };
  /**
   * Window and taskbar icon: a .png/.ico/.jpg/.webp path (or `import icon from "./icon.png" with { type: "file" }`)
   * or a data URL. Defaults to the `tarve.icon` of the app's package.json under `tarve run`/`dev`/`build`.
   */
  icon?: string;
  /** URL schemes the app opens (`"myapp"` for `myapp://…`): what `onOpenUrl` reports. Register them with `registerProtocol` or a package. */
  protocols?: readonly string[];
  /** File types the app opens: what `onOpenFiles` reports. Register them with `registerFileType` or a package. */
  fileTypes?: readonly FileTypeAssociation[];
  /**
   * Plugins (`definePlugin`, usually imported from their npm package). Each one's setup runs
   * once, before the window opens; their commands are called with `app.invoke`.
   */
  plugins?: readonly TarvePlugin[];
}

export interface SystemMediaSession extends NativeSystemMediaSession {
  onAction?: (action: "play" | "pause" | "next" | "previous" | "seek", time?: number) => void;
}

/**
 * A system notification: a toast on Windows, org.freedesktop.Notifications on Linux, the
 * notification shade on Android (which asks for POST_NOTIFICATIONS the first time on Android
 * 13+). No tray icon is needed. Clicking it brings the window forward and runs `onClick`.
 */
export interface NotifyOptions { title: string; body?: string; onClick?: () => void }

export type DiagnosticInput = Extract<NativeCommand, { type: "input" | "resize" }>;
/** JS update phases, each a summary in milliseconds. */
export interface AppJsStats {
  /** The view function and compileTree. */
  render: PhaseSummary;
  /** Building the patch against what the native tree holds. */
  diff: PhaseSummary;
  /** Updating the JS mirror of the native tree. */
  shadow: PhaseSummary;
  /** Serializing the patch and handing it to the native thread. */
  send: PhaseSummary;
  /** One whole update, from the queued render to the patch sent. */
  update: PhaseSummary;
  heapUsedMb: number;
}
export interface AppStats { js: AppJsStats; native: NativeStats }
/** Options of a window opened with `app.openWindow`: an app of its own on the same native app. */
export interface OpenWindowOptions extends Pick<AppOptions, "rememberWindow" | "debug" | "renderer" | "componentAdapters" | "onError" | "dev" | "maxFps" | "msaa" | "textRendering" | "lowPower" | "keyboardEvents" | "pointerEvents" | "closeBehavior"> {
  /** Names the window in native events; unique among the app's open windows. Default `window-<n>`. */
  id?: string;
}

export interface AppHandle {
  ready: Promise<void>;
  closed: Promise<void>;
  update(): void;
  /** Renders a queued `update()` now instead of at the end of the task. */
  flush(): void;
  /**
   * Lays the window out now and returns these nodes' boxes: a synchronous layout
   * read (`getBoundingClientRect` right after a change). Renders a queued update
   * first and blocks until native answers. `undefined` when the bridge cannot
   * answer synchronously or native did not answer in time.
   */
  layout(ids: string[]): Record<string, LayoutBox> | undefined;
  /**
   * The focused text field and its selection (UTF-8 offsets into its value), read
   * synchronously. `undefined` when nothing editable has focus or the bridge cannot answer.
   */
  textSelection(): { id: string; anchor: number; focus: number } | undefined;
  close(): void;
  /**
   * Opens another window of the app, rendering `view` (a `<Window>` of its own: title,
   * size, position, backdrop…). It returns that window's own handle: `update()`,
   * `close()`, `closed`, `onEvent`, `inspect()`… for that window only. The tray,
   * notifications, media session, desktop widget and `alwaysOnBottom`/`skipTaskbar`
   * stay with the first window. Closing the first window closes every other one.
   */
  openWindow(view: () => VNode, options?: OpenWindowOptions): AppHandle;
  focus(id: string): void;
  /** Scrolls a variable VirtualList to an item; `smooth` eases there like CSS `scroll-behavior: smooth`. */
  scrollToItem(id: string, index: number, offset?: number, options?: { smooth?: boolean }): void;
  registerHotkey(shortcut: string, handler: HotkeyHandler): () => void;
  show(): void;
  hide(): void;
  minimize(): void;
  /** Shows the window, restores it if minimized and brings it to the front (a second launch, a tray click). */
  activate(): void;
  /** Maximizes (`true`) or restores (`false`) the window. */
  setMaximized(maximized: boolean): void;
  /** Borderless full screen on the window's monitor (`true`), or back to the window it was (`false`). */
  setFullscreen(fullscreen: boolean): void;
  toggleFullscreen(): void;
  /** Shows a system tray icon (Windows). A second call replaces the first tray. */
  tray(options: TrayOptions): TrayHandle;
  /**
   * The window's menu bar, replaced as a whole on each call; `null` removes it. Drawn in
   * the theme at the top of the window (after a `TitleBar`), the same on every system, with
   * F10 and Alt access keys (`&File`). `{ native: true }` uses the system's instead (a
   * Win32 menu on Windows, framed windows only). Choosing an item runs its `onSelect` and
   * `onEvent` sees `{ type: "menu", id }`; an item's `accelerator` also runs it from the
   * keyboard. Place `<AppMenuBar items>` yourself to put it elsewhere (inside a `TitleBar`).
   */
  menuBar(items: readonly MenuBarItem[] | null, options?: MenuBarOptions): void;
  systemMedia(session: SystemMediaSession | null): void;
  /** Shows a system notification (see `NotifyOptions`); the same call on every platform. */
  notify(options: NotifyOptions): void;
  /** Runtime permission states by name (`CAMERA` or `android.permission.CAMERA`); every name is "granted" on desktops. */
  checkPermissions(names: readonly string[]): Promise<Record<string, PermissionState>>;
  /**
   * Android: shows the system prompt for the permissions not granted yet (each must be in the
   * manifest: package.json `tarve.android.permissions` or `tarve build --permission`) and
   * resolves with every state. Desktops grant every name at once.
   */
  requestPermissions(names: readonly string[]): Promise<Record<string, PermissionState>>;
  /** HTMLMediaElement methods for an `<audio>` element by id. */
  media(id: string): MediaController;
  openFileDialog(options?: FileDialogOptions): Promise<string | undefined>;
  openFilesDialog(options?: FileDialogOptions): Promise<string[]>;
  openFolderDialog(options?: FileDialogOptions): Promise<string | undefined>;
  saveFileDialog(options?: FileDialogOptions): Promise<string | undefined>;
  /** Android: a sign-in page in the system WebView; resolves with the cookies of `cookieUrl` (see `NativeRequests.webSignIn`). */
  webSignIn(options: WebSignInOptions): Promise<string | undefined>;
  onEvent(listener: (event: NativeEvent) => void): () => void;
  /**
   * Links of `protocols` the app is asked to open: those it was launched with (right after
   * this call), then those of later launches `requestSingleInstance` hands to this process.
   */
  onOpenUrl(listener: OpenUrlListener): () => void;
  /** Files (absolute paths) of `fileTypes` the app is asked to open, like `onOpenUrl`. Android copies a shared document into the app's cache first. */
  onOpenFiles(listener: OpenFilesListener): () => void;
  /** The system share sheet (Android chooser, Windows share UI); `{ supported: false }` on Linux. Resolves once it is shown. */
  share(options: ShareOptions): Promise<ShareResult>;
  /** One location fix (Android LocationManager, Windows Geolocator); asks for the location permission first. `{ supported: false }` on Linux. */
  getCurrentPosition(options?: PositionOptions): Promise<PositionResult>;
  /** Location fixes about every second until the returned function is called; errors come to `callback` too. */
  watchPosition(callback: (result: PositionResult) => void, options?: Pick<PositionOptions, "highAccuracy">): () => void;
  /** A biometric (or device PIN) check: Android BiometricPrompt, Windows Hello. `{ supported: false }` on Linux. */
  authenticate(options: AuthenticateOptions): Promise<AuthenticateResult>;
  /**
   * Calls a plugin command (`"<namespace>.<command>"`, see `definePlugin`); rejects when no
   * installed plugin registered it. `plugin.client(app)` gives typed calls.
   */
  invoke<R = unknown>(command: string, ...args: unknown[]): Promise<R>;
  inspect(): Promise<Snapshot>;
  /**
   * Where time and memory go: percentiles (ms) of the JS update phases and of the
   * native frame phases over their recent samples, plus process memory after each
   * startup stage. `reset` clears the samples after reading them.
   */
  stats(options?: { reset?: boolean }): Promise<AppStats>;
  capture(path: string): Promise<void>;
  /** Advance the native deterministic motion clock. Requires debug mode. */
  advanceMotion(milliseconds: number): Promise<void>;
  debug(command: DiagnosticInput): void;
  /** Replace the view in the same native window, resetting component state. */
  remount(view: () => VNode): void;
  /** Toggle the native frame-time overlay. */
  setFrameOverlay(enabled: boolean): void;
  /** Animation frames per second; `null` follows the display's refresh rate. Motion keeps its speed. */
  setMaxFps(fps: number | null): void;
}

