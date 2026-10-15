import type { FileDialogOptions, NativeEvent, NativeCommand, NativeStats, NativeSystemMediaSession, PhaseSummary, Renderer, Snapshot } from "./protocol";
import { readFileSync } from "node:fs";
import { applyMediaEvent, type MediaController } from "./media-element";
import { BunFfiBridge, type NativeBridge } from "./bridge";
import { compileTree, type CompiledTree, invalidateMemos } from "./reconciler";
import { normalizeHotkey, type HotkeyHandler } from "./hotkeys";
import type { VNode } from "./jsx-runtime";
import { createElementDispatcher } from "./app/element-events";
import { createMediaSync, mediaController } from "./app/media";
import { createNativeRequests } from "./app/requests";
import { editShadowNode, nativeShadow, reconciliationCommand } from "./app/shadow";
import { createTrayController, type TrayHandle, type TrayOptions } from "./app/tray";
import { withRenderScope } from "./render-scope";
import { PhaseSamples } from "./app/stats";
import type { ComponentAdapter } from "./component-adapter";
import { DevErrorOverlay } from "./dev-overlay";
import { iconBytes, iconFileForShell, runtimeAppMetadata } from "./app-metadata";
import { nativeAssetPath } from "./embedded-assets";

export type AppErrorSource =
  | "render"
  | "event-handler"
  | "listener"
  | "hotkey"
  | "bridge"
  | "native"
  | "request"
  | "file-dialog";

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
  /** Development mode: runtime errors render an in-window overlay and render() remounts in the same window. Defaults to TARVE_DEV=1. */
  dev?: boolean;
  /** Show the native frame-time graph. Defaults to TARVE_FRAME_OVERLAY=1. Never schedules frames on its own. */
  frameOverlay?: boolean;
  /** Animation frames per second (transitions, `spin`, keyframes); `null` follows the display's refresh rate. Default 60. */
  maxFps?: number | null;
  /**
   * Font files the app ships, like CSS `@font-face`: TTF/OTF/WOFF2 paths (or `import font from "./Inter.ttf" with { type: "file" }`).
   * Each font is then available by its family name in `fontFamily`.
   */
  fontFaces?: readonly string[];
  /** What the window close button does without an onCloseRequest handler: quit (default) or hide the window, e.g. for tray apps. */
  closeBehavior?: "exit" | "hide";
  /**
   * GPU antialiasing on Windows (D3D11). `0` (default): no multisampling; shape edges
   * get a one-pixel coverage fringe, ~30 MB less memory. `2`, `4` or `8`: MSAA with that
   * many samples, smoother clip edges (rounded `overflow: hidden`, gradients). `TARVE_MSAA` overrides it.
   */
  msaa?: 0 | 2 | 4 | 8;
  /**
   * Windows: after this many ms without a new frame (default 3000), return the pages only
   * startup touched to the OS, so Task Manager shows what the app really uses. `false` never
   * does. `TARVE_TRIM` (ms, or 0 to disable) overrides it.
   */
  memoryTrimDelay?: number | false;
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
}

export interface SystemMediaSession extends NativeSystemMediaSession {
  onAction?: (action: "play" | "pause" | "next" | "previous" | "seek", time?: number) => void;
}

export type { TrayMenuItem, TrayOptions, TrayHandle } from "./app/tray";

export interface NotifyOptions { title: string; body?: string; onClick?: () => void }

const DEV_OVERLAY_SOURCES = new Set<AppErrorSource>(["render", "event-handler", "listener", "hotkey"]);
const DEV_APP_KEY = Symbol.for("tarve.devApp");
// <input type="file"> and <audio controls> reach the app that is rendering or
// handling an event through this slot, as DOM elements reach their document.
const ACTIVE_APP_KEY = Symbol.for("tarve.activeApp");

function envFlag(name: string): boolean {
  return typeof process !== "undefined" && process.env?.[name] === "1";
}

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
export interface AppHandle {
  ready: Promise<void>;
  closed: Promise<void>;
  update(): void;
  close(): void;
  focus(id: string): void;
  /** Scrolls a variable VirtualList to an item; `smooth` eases there like CSS `scroll-behavior: smooth`. */
  scrollToItem(id: string, index: number, offset?: number, options?: { smooth?: boolean }): void;
  registerHotkey(shortcut: string, handler: HotkeyHandler): () => void;
  show(): void;
  hide(): void;
  minimize(): void;
  /** Shows a system tray icon (Windows). A second call replaces the first tray. */
  tray(options: TrayOptions): TrayHandle;
  systemMedia(session: SystemMediaSession | null): void;
  /** Shows a system notification from the tray icon; requires an active tray. */
  notify(options: NotifyOptions): void;
  /** HTMLMediaElement methods for an `<audio>` element by id. */
  media(id: string): MediaController;
  openFileDialog(options?: FileDialogOptions): Promise<string | undefined>;
  openFilesDialog(options?: FileDialogOptions): Promise<string[]>;
  openFolderDialog(options?: FileDialogOptions): Promise<string | undefined>;
  saveFileDialog(options?: FileDialogOptions): Promise<string | undefined>;
  onEvent(listener: (event: NativeEvent) => void): () => void;
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

function asError(value: unknown): Error {
  return value instanceof Error ? value : new Error(String(value));
}

export function createApp(view: () => VNode, options: AppOptions = {}): AppHandle {
  const bridge = options.bridge ?? new BunFfiBridge();
  let renderScope: object = {};
  let currentView = view;
  const devMode = options.dev ?? envFlag("TARVE_DEV");
  let devError: AppErrorEvent | undefined;
  let devOverlayBroken = false;
  let overlayCompiled = false;
  const overlayScope = {};
  let appWindow: CompiledTree["document"]["window"] | undefined;
  // Read once: the window is created from the first document only.
  let identityDocument: Pick<CompiledTree["document"], "windowIcon" | "appIdentity"> | undefined;
  /** The app's own icon: `createApp({ icon })`, else package.json `tarve.icon`. */
  const appIcon = (): string | undefined => options.icon ?? runtimeAppMetadata().icon;
  function appIdentityDocument(): Pick<CompiledTree["document"], "windowIcon" | "appIdentity"> {
    if (identityDocument) return identityDocument;
    const metadata = runtimeAppMetadata();
    const icon = appIcon();
    // package.json `tarve.appId` names the app to Windows without code; an explicit appIdentity wins.
    const identity = options.appIdentity ?? (metadata.appId ? { id: metadata.appId, name: metadata.name ?? metadata.appId, ...(icon ? { icon } : {}) } : undefined);
    const shellIcon = identity?.icon ? iconFileForShell(identity.icon) : undefined;
    identityDocument = {
      ...(icon ? { windowIcon: Buffer.from(iconBytes(icon)).toString("base64") } : {}),
      ...(identity ? { appIdentity: { id: identity.id, name: identity.name, ...(shellIcon ? { icon: shellIcon } : {}) } } : {}),
    };
    return identityDocument;
  }

  function compileView(): CompiledTree {
    const scope = renderScope;
    // A hidden (headless) window never reaches the screen: the CPU renderer draws and
    // captures the same pixels without loading a GPU driver (~85 MB, ~70 ms on Windows).
    const renderer = options.renderer ?? (options.headless ? "cpu" : "auto");
    const shown = devError;
    const shownWindow = appWindow;
    overlayCompiled = false;
    if (shown && shownWindow && !devOverlayBroken) {
      try {
        // Separate scope: rendering the overlay must not advance the app's render
        // epochs, or epoch-swept state (AnimatePresence) is lost on dismiss.
        const overlay = withRenderScope(overlayScope, () => compileTree(
          DevErrorOverlay({ event: shown, onDismiss: dismissDevError, decorations: shownWindow.decorations }), options.debug, renderer, undefined, overlayScope, !options.headless,
        ));
        overlayCompiled = true;
        overlay.document.window = shownWindow;
        if (options.closeBehavior === "hide") overlay.document.root.closeIntercept = true;
        return overlay;
      } catch (overlayError) {
        devOverlayBroken = true;
        try { console.error("[tarve] dev error overlay failed", asError(overlayError)); } catch {}
      }
    }
    (globalThis as Record<symbol, unknown>)[ACTIVE_APP_KEY] = app;
    const tree = withRenderScope(scope, () => compileTree(
      currentView(), options.debug, renderer, options.componentAdapters, scope, !options.headless, viewport,
    ));
    appWindow = tree.document.window;
    if (options.closeBehavior === "hide") tree.document.root.closeIntercept = true;
    Object.assign(tree.document, appIdentityDocument());
    if (options.msaa !== undefined) tree.document.msaa = options.msaa;
    if (options.memoryTrimDelay !== undefined) tree.document.memoryTrimDelay = options.memoryTrimDelay === false ? -1 : options.memoryTrimDelay;
    return tree;
  }

  function dismissDevError(): void {
    devError = undefined;
    update();
  }
  let committed: CompiledTree | undefined;
  let observed: CompiledTree | undefined;
  const jsStats = { render: new PhaseSamples(), diff: new PhaseSamples(), shadow: new PhaseSamples(), send: new PhaseSamples(), update: new PhaseSamples() };
  /** The window's content size, from the root's size reports; breakpoint styles read it. */
  let viewport: { width: number; height: number } | undefined;
  let queued = false;
  let ended = false;
  let closing = false;
  let started = false;
  let readySettled = false;
  let closedSettled = false;
  let terminalError: Error | undefined;
  const listeners = new Set<(event: NativeEvent) => void>();
  const hotkeys = new Map<string, Set<HotkeyHandler>>();
  let resolveReady!: () => void;
  let rejectReady!: (error: Error) => void;
  let resolveClosed!: () => void;
  const ready = new Promise<void>((resolve, reject) => { resolveReady = resolve; rejectReady = reject; });
  const closed = new Promise<void>((resolve) => { resolveClosed = resolve; });

  function reportError(value: unknown, context: Omit<AppErrorEvent, "error">): Error {
    const error = asError(value);
    const event: AppErrorEvent = { error, ...context };
    if (options.onError) {
      try {
        options.onError(event);
      } catch (reportingError) {
        try {
          console.error("[tarve] onError callback failed", asError(reportingError));
          console.error(`[tarve] ${context.source}${context.event ? `:${context.event}` : ""}`, error);
        } catch {}
      }
    } else {
      try { console.error(`[tarve] ${context.source}${context.event ? `:${context.event}` : ""}`, error); } catch {}
    }
    if (devMode && context.source === "render" && overlayCompiled) {
      // The overlay itself failed to diff/commit; re-showing it would loop.
      devOverlayBroken = true;
    } else if (devMode && !devOverlayBroken && started && !ended && DEV_OVERLAY_SOURCES.has(context.source)) {
      devError = event;
      update();
    }
    return error;
  }

  function settleReadySuccess(): void {
    if (readySettled) return;
    readySettled = true;
    started = true;
    resolveReady();
    if (options.maxFps !== undefined) {
      sendInternal({ type: "frameRate", maxFps: options.maxFps }, { source: "bridge", event: "frameRate" });
    }
    if (options.frameOverlay ?? envFlag("TARVE_FRAME_OVERLAY")) {
      sendInternal({ type: "frameOverlay", enabled: true }, { source: "bridge", event: "frameOverlay" });
    }
  }

  function settleReadyFailure(error: Error): void {
    if (readySettled) return;
    readySettled = true;
    rejectReady(error);
  }

  function settleClosed(): void {
    if (closedSettled) return;
    closedSettled = true;
    resolveClosed();
  }

  function sendInternal(command: NativeCommand, context: Omit<AppErrorEvent, "error">): boolean {
    if (ended) return false;
    try {
      bridge.send(command);
      return true;
    } catch (error) {
      reportError(error, context);
      return false;
    }
  }

  function sendPublic(command: NativeCommand): void {
    try {
      bridge.send(command);
    } catch (error) {
      throw reportError(error, { source: "bridge", event: command.type });
    }
  }

  const requests = createNativeRequests({
    send: command => bridge.send(command),
    reportError,
    closedError: () => (ended ? terminalError ?? new Error("Native window is closed") : undefined),
  });
  const trays = createTrayController(appIcon, command => { if (!ended) sendPublic(command); });
  const syncLoadedMedia = createMediaSync((command, event, targetId) => sendInternal(command, { source: "bridge", event, targetId }));
  const dispatchElementEvent = createElementDispatcher(invokeHandler, id => committed?.handlers.get(id));

  function restoreCommitted(): void {
    if (ended || closing || !committed || !observed) return;
    let command: NativeCommand | undefined;
    try {
      command = reconciliationCommand(observed, committed);
    } catch (error) {
      reportError(error, { source: "render", event: "rollback" });
      return;
    }
    if (!command) return;
    let restoredObserved: CompiledTree;
    try {
      restoredObserved = nativeShadow(committed, observed);
    } catch (error) {
      reportError(error, { source: "render", event: "rollback-shadow" });
      return;
    }
    if (sendInternal(command, { source: "bridge", event: `rollback:${command.type}` })) {
      observed = restoredObserved;
    }
  }

  function update(): void {
    if (queued || ended || closing || !committed || !observed) return;
    queued = true;
    queueMicrotask(() => {
      queued = false;
      if (ended || closing || !committed || !observed) return;
      const updateStarted = performance.now();

      let next: CompiledTree;
      try {
        next = jsStats.render.time(compileView);
        if (committed.document.window.decorations !== next.document.window.decorations) {
          throw new Error("Adding or removing TitleBar after the native window has been created is not supported. Recreate the Window instead.");
        }
      } catch (error) {
        reportError(error, { source: "render", event: "update" });
        restoreCommitted();
        return;
      }

      let command: NativeCommand | undefined;
      try {
        const current = observed;
        command = jsStats.diff.time(() => reconciliationCommand(current, next));
      } catch (error) {
        reportError(error, { source: "render", event: "diff" });
        restoreCommitted();
        return;
      }

      let nextObserved: CompiledTree;
      try {
        const current = observed;
        nextObserved = jsStats.shadow.time(() => nativeShadow(next, current));
      } catch (error) {
        reportError(error, { source: "render", event: "shadow" });
        restoreCommitted();
        return;
      }

      if (command) {
        const patch = command;
        if (!jsStats.send.time(() => sendInternal(patch, { source: "bridge", event: patch.type }))) {
          restoreCommitted();
          return;
        }
      }

      const level = next.document.window.level ?? "normal";
      if ((committed.document.window.level ?? "normal") !== level) {
        sendInternal({ type: "windowLevel", level }, { source: "bridge", event: "windowLevel" });
      }
      committed = next;
      observed = nextObserved;
      syncMedia();
      jsStats.update.push(performance.now() - updateStarted);
    });
  }

  /**
   * Sends a command that targets nodes after the render already queued by
   * `update()`: `update(); focus("new-field")` must find the field it adds.
   */
  function sendAfterRender(command: NativeCommand): void {
    if (!queued) { sendPublic(command); return; }
    // The render's microtask was queued first, so this one runs after it.
    queueMicrotask(() => { if (!ended) sendPublic(command); });
  }

  async function flushQueuedUpdate(): Promise<void> {
    while (queued && !ended && !closing) {
      // `update()` batches rendering in a microtask. Request-style APIs that
      // inspect or advance native state must cross that boundary first so the
      // request is ordered after the declarative patch on the bridge.
      await Promise.resolve();
    }
  }

  function invokeHandler(event: string, targetId: string | undefined, handler: (...args: never[]) => void, ...args: never[]): boolean {
    try {
      handler(...args);
      return true;
    } catch (error) {
      reportError(error, { source: "event-handler", event, ...(targetId ? { targetId } : {}) });
      return false;
    }
  }

  function finishClosed(): void {
    if (ended) return;
    ended = true;
    closing = true;
    const closeError = terminalError ?? new Error("Native window closed");
    if (!started && !readySettled) {
      terminalError = closeError;
      reportError(closeError, { source: "native", event: "closed-before-ready" });
      settleReadyFailure(closeError);
    }
    requests.rejectAll(closeError);
    settleClosed();
    // Keep native teardown outside the event-dispatch stack. This also preserves deterministic
    // ordering if the close event was drained together with other queued native events.
    queueMicrotask(() => {
      try {
        bridge.join();
      } catch (error) {
        reportError(error, { source: "bridge", event: "join" });
      }
    });
  }

  function dispatchNativeEvent(event: NativeEvent): void {
    (globalThis as Record<symbol, unknown>)[ACTIVE_APP_KEY] = app;
    if (event.type === "ready") settleReadySuccess();

    if (event.type === "error") {
      const error = new Error(event.message);
      if (!started && !readySettled) {
        terminalError = error;
        settleReadyFailure(error);
      }
      reportError(error, { source: "native", event: "error" });
    }

    if (event.type === "closed") finishClosed();

    if (!ended && committed && observed && event.type === "escape") {
      const item = [...committed.handlers.entries()].reverse().find(([, handlers]) => handlers.onEscape);
      const handler = item?.[1].onEscape;
      if (handler && invokeHandler("escape", item?.[0], handler)) update();
    }

    if (!ended && committed && event.type === "closeRequest") {
      const targetId = committed.document.root.id;
      const handler = committed.handlers.get(targetId)?.onCloseRequest;
      if (!handler) {
        if (options.closeBehavior === "hide") {
          sendInternal({ type: "window", action: "hide" }, { source: "bridge", event: "closeRequest:hide", targetId });
          sendInternal({ type: "cancelCloseRequest" }, { source: "bridge", event: "cancelCloseRequest", targetId });
        } else if (sendInternal({ type: "close" }, { source: "bridge", event: "closeRequest:close", targetId })) closing = true;
      } else {
        let defaultPrevented = false;
        const closeRequest = {
          get defaultPrevented(): boolean { return defaultPrevented; },
          preventDefault(): void { defaultPrevented = true; },
        };
        const succeeded = invokeHandler("closeRequest", targetId, handler as (...args: never[]) => void, closeRequest as never);
        if (!succeeded) {
          if (!closing) sendInternal({ type: "cancelCloseRequest" }, { source: "bridge", event: "cancelCloseRequest", targetId });
        } else if (!closing && defaultPrevented) {
          if (sendInternal({ type: "cancelCloseRequest" }, { source: "bridge", event: "cancelCloseRequest", targetId })) update();
        } else if (!closing) {
          if (sendInternal({ type: "close" }, { source: "bridge", event: "closeRequest:close", targetId })) closing = true;
        }
      }
    }

    if (!ended && (event.type === "tray" || event.type === "trayMenu" || event.type === "notificationClick")) {
      const run = (name: string, handler: (() => void) | undefined): boolean => {
        if (!handler) return false;
        try { handler(); return true; } catch (error) { reportError(error, { source: "event-handler", event: name }); return false; }
      };
      let ran = false;
      const tray = trays.options();
      if (event.type === "tray") ran = run(event.action === "click" ? "trayClick" : "trayDoubleClick", event.action === "click" ? tray?.onClick : tray?.onDoubleClick);
      else if (event.type === "trayMenu") {
        ran = run("trayMenu", trays.menuHandler(event.id));
        const onMenu = tray?.onMenu;
        if (onMenu) ran = run("trayMenu", () => onMenu(event.id)) || ran;
      } else ran = run("notificationClick", notificationClick);
      if (ran) update();
    }

    if (!ended && event.type === "systemMedia" && systemMediaAction) {
      try { systemMediaAction(event.action, event.time); } catch (error) { reportError(error, { source: "event-handler", event: `systemMedia:${event.action}` }); }
    }

    if (!ended && event.type === "media") {
      const handler = applyMediaEvent(event, committed?.media?.get(event.id), renderScope);
      if (handler) {
        try { handler(); } catch (error) { reportError(error, { source: "event-handler", event: `media:${event.event}`, targetId: event.id }); }
      }
      update();
    }

    if (!ended && event.type === "shortcut") {
      const handlers = hotkeys.get(event.shortcut);
      if (handlers) {
        let succeeded = false;
        for (const handler of [...handlers]) {
          try {
            handler();
            succeeded = true;
          } catch (error) {
            reportError(error, { source: "hotkey", event: event.shortcut });
          }
        }
        if (succeeded) update();
      }
    }

    requests.settle(event);

    if (!ended && committed && event.type === "size" && event.id === committed.document.root.id) {
      const crossed = committed.usesViewport && viewport?.width !== event.width;
      viewport = { width: event.width, height: event.height };
      if (crossed) update();
    }
    if (!ended && committed && observed && "id" in event) {
      const handlers = committed.handlers.get(event.id);
      if (handlers) invalidateMemos(renderScope, event.id);
      let optimisticEdit = false;
      if (event.type === "change") {
        const node = observed.nodes.get(event.id);
        if (node && (node.kind === "input" || node.kind === "textarea")) {
          editShadowNode(observed, event.id, { value: event.value });
          optimisticEdit = true;
        }
      }
      if (event.type === "valueChange") {
        const node = observed.nodes.get(event.id);
        if (node?.control) {
          editShadowNode(observed, event.id, { control: { ...node.control, value: event.value } });
          optimisticEdit = true;
        }
      }

      const { handled, succeeded } = dispatchElementEvent(event, handlers);

      if (!succeeded) {
        // Motion completion is a notification, not an optimistic native edit.
        // Presence bookkeeping may already have completed before a user callback
        // throws, so still render once to let retained exit nodes be removed.
        if (event.type === "motionComplete") update();
        else restoreCommitted();
      }
      else if (handled || optimisticEdit) update();
    }
  }

  let systemMediaAction: SystemMediaSession["onAction"];
  let notificationClick: (() => void) | undefined;

  function syncMedia(): void {
    if (!ended && committed) syncLoadedMedia(committed);
  }

  function onNativeEvent(event: NativeEvent): void {
    try {
      dispatchNativeEvent(event);
    } catch (error) {
      reportError(error, { source: "native", event: `dispatch:${event.type}` });
      restoreCommitted();
    }
    for (const listener of [...listeners]) {
      try {
        listener(event);
      } catch (error) {
        reportError(error, { source: "listener", event: event.type, ...( "id" in event ? { targetId: event.id } : {}) });
      }
    }
  }

  const app: AppHandle = {
    ready,
    closed,
    update,
    close(): void {
      if (ended || closing) return;
      sendPublic({ type: "close" });
      closing = true;
    },
    focus(id: string): void {
      if (!ended) sendAfterRender({ type: "focus", id });
    },
    scrollToItem(id: string, index: number, offset = 0, options: { smooth?: boolean } = {}): void {
      if (!id) throw new TypeError("scrollToItem requires a list id");
      if (!Number.isInteger(index) || index < 0) throw new RangeError("scrollToItem index must be a nonnegative integer");
      if (!Number.isFinite(offset)) throw new RangeError("scrollToItem offset must be finite");
      if (!ended) sendAfterRender({ type: "scrollToItem", id, index, ...(offset !== 0 ? { offset } : {}), ...(options.smooth ? { smooth: true } : {}) });
    },
    show(): void {
      if (!ended) sendPublic({ type: "window", action: "show" });
    },
    hide(): void {
      if (!ended) sendPublic({ type: "window", action: "hide" });
    },
    minimize(): void {
      if (!ended) sendPublic({ type: "window", action: "minimize" });
    },
    tray(initial: TrayOptions): TrayHandle {
      return trays.tray(initial);
    },
    systemMedia(session: SystemMediaSession | null): void {
      if (session) {
        const { onAction, ...nativeSession } = session;
        systemMediaAction = onAction;
        if (!ended) sendPublic({ type: "systemMedia", session: nativeSession });
      } else {
        systemMediaAction = undefined;
        if (!ended) sendPublic({ type: "systemMedia", session: null });
      }
    },
    notify({ title, body = "", onClick }: NotifyOptions): void {
      if (!title) throw new TypeError("notify requires a title");
      notificationClick = onClick;
      if (!ended) sendPublic({ type: "notify", title, body });
    },
    media(id: string): MediaController {
      return mediaController(id, command => { if (!ended) sendPublic(command); });
    },
    registerHotkey(shortcut: string, handler: HotkeyHandler): () => void {
      const canonical = normalizeHotkey(shortcut);
      const handlers = hotkeys.get(canonical) ?? new Set<HotkeyHandler>();
      handlers.add(handler);
      hotkeys.set(canonical, handlers);
      return () => {
        handlers.delete(handler);
        if (handlers.size === 0) hotkeys.delete(canonical);
      };
    },
    async openFileDialog(dialogOptions?: FileDialogOptions): Promise<string | undefined> {
      return (await requests.fileDialog("openFile", dialogOptions))[0];
    },
    async openFilesDialog(dialogOptions?: FileDialogOptions): Promise<string[]> {
      return requests.fileDialog("openFiles", dialogOptions);
    },
    async openFolderDialog(dialogOptions?: FileDialogOptions): Promise<string | undefined> {
      return (await requests.fileDialog("openFolder", dialogOptions))[0];
    },
    async saveFileDialog(dialogOptions?: FileDialogOptions): Promise<string | undefined> {
      return (await requests.fileDialog("saveFile", dialogOptions))[0];
    },
    onEvent(listener: (event: NativeEvent) => void): () => void {
      listeners.add(listener);
      return () => { listeners.delete(listener); };
    },
    async inspect(): Promise<Snapshot> {
      if (queued) await flushQueuedUpdate();
      const event = await requests.request({ type: "inspect", requestId: crypto.randomUUID() });
      if (event.type !== "inspect") {
        const error = reportError(new Error("Unexpected native response"), { source: "request", event: "inspect" });
        throw error;
      }
      return event.snapshot;
    },
    async stats(statsOptions: { reset?: boolean } = {}): Promise<AppStats> {
      if (queued) await flushQueuedUpdate();
      const reset = statsOptions.reset === true;
      const event = await requests.request({ type: "stats", requestId: crypto.randomUUID(), reset });
      if (event.type !== "stats") {
        throw reportError(new Error("Unexpected native stats response"), { source: "request", event: "stats" });
      }
      const js: AppJsStats = {
        render: jsStats.render.summary(), diff: jsStats.diff.summary(), shadow: jsStats.shadow.summary(),
        send: jsStats.send.summary(), update: jsStats.update.summary(),
        heapUsedMb: Math.round(process.memoryUsage().heapUsed / 104857.6) / 10,
      };
      if (reset) for (const samples of Object.values(jsStats)) samples.reset();
      return { js, native: event.stats };
    },
    async capture(path: string): Promise<void> {
      if (!options.debug) throw new Error("Enable debug to capture the rendered scene");
      if (queued) await flushQueuedUpdate();
      const event = await requests.request({ type: "capture", path, requestId: crypto.randomUUID() });
      if (event.type !== "captured") {
        const error = reportError(new Error("Unexpected native capture response"), { source: "request", event: "capture" });
        throw error;
      }
      if (event.error) {
        const error = reportError(new Error(event.error), { source: "request", event: "capture" });
        throw error;
      }
    },
    async advanceMotion(milliseconds: number): Promise<void> {
      if (!options.debug) throw new Error("Enable debug to advance native motion");
      if (!Number.isFinite(milliseconds) || milliseconds < 0 || milliseconds > 60_000) {
        throw new RangeError("advanceMotion milliseconds must be finite and between 0 and 60000");
      }
      if (queued) await flushQueuedUpdate();
      const event = await requests.request({ type: "motionAdvance", milliseconds, requestId: crypto.randomUUID() });
      if (event.type !== "motionAdvanced") {
        const error = reportError(new Error("Unexpected native motion response"), { source: "request", event: "motionAdvance" });
        throw error;
      }
      if (event.error) {
        const error = reportError(new Error(event.error), { source: "request", event: "motionAdvance" });
        throw error;
      }
    },
    debug(command: DiagnosticInput): void {
      if (!options.debug) throw new Error("Enable debug to use diagnostic input/resize");
      sendPublic(command);
    },
    remount(nextView: () => VNode): void {
      if (ended || closing) return;
      currentView = nextView;
      renderScope = {};
      devError = undefined;
      devOverlayBroken = false;
      update();
    },
    setFrameOverlay(enabled: boolean): void {
      if (!ended) sendPublic({ type: "frameOverlay", enabled });
    },
    setMaxFps(fps: number | null): void {
      if (fps !== null && !(Number.isFinite(fps) && fps > 0)) throw new RangeError("setMaxFps expects a positive number or null");
      if (!ended) sendPublic({ type: "frameRate", maxFps: fps });
    },
  };

  try {
    committed = compileView();
    observed = nativeShadow(committed);
  } catch (error) {
    const startupError = reportError(error, { source: "render", event: "startup" });
    terminalError = startupError;
    ended = true;
    settleReadyFailure(startupError);
    settleClosed();
    return app;
  }

  try {
    const fonts = options.fontFaces?.map(path => Buffer.from(readFileSync(nativeAssetPath(path))).toString("base64"));
    bridge.start(fonts?.length ? { ...committed.document, fonts } : committed.document, onNativeEvent);
    syncMedia();
  } catch (error) {
    const startupError = reportError(error, { source: "bridge", event: "start" });
    terminalError = startupError;
    ended = true;
    settleReadyFailure(startupError);
    requests.rejectAll(startupError);
    settleClosed();
  }

  return app;
}

/**
 * Renders the app until its window closes. A second call in the same
 * process (e.g. a `bun --hot` reload) remounts into the already open window.
 */
export async function render(view: () => VNode, options?: AppOptions): Promise<void> {
    // Only one native app can run per process, so a second render() (e.g. a
      // `bun --hot` reload re-evaluating the entry) remounts into the open window.
      // Bun defers hot reloads while a top-level await is pending, so under --hot
      // render() resolves once the window is ready and the process exits on close.
      const hot = process.execArgv.includes("--hot") || process.env.TARVE_HOT === "1";
      const registry = globalThis as { [DEV_APP_KEY]?: AppHandle };
      const existing = registry[DEV_APP_KEY];
      if (existing) {
        existing.remount(view);
        if (!hot) await existing.closed;
        return;
      }
      const app = createApp(view, options);
      registry[DEV_APP_KEY] = app;
      void app.closed.then(() => {
        if (registry[DEV_APP_KEY] === app) delete registry[DEV_APP_KEY];
        if (hot) process.exit(0);
      });
      try {
        await app.ready;
      } catch (error) {
        if (registry[DEV_APP_KEY] === app) delete registry[DEV_APP_KEY];
        throw error;
      }
      if (!hot) await app.closed;
}
