import type { SceneDocument, FileDialogOptions, LayoutBox, NativeEvent, NativeCommand, Snapshot } from "./protocol";
import { readFileSync } from "node:fs";
import { environmentKey, initialViewport, setEnvironment, trackViewport } from "./viewport";
import { applyMediaEvent, type MediaController } from "./media-element";
import { BunFfiBridge, type NativeBridge } from "./bridge";
import { compileTree, type CompiledTree, invalidateMemos } from "./reconciler";
import { normalizeHotkey, type HotkeyHandler } from "./hotkeys";
import { jsx, type VNode } from "./jsx-runtime";
import { createElementDispatcher } from "./app/element-events";
import { createMediaSync, mediaController } from "./app/media";
import { createNativeRequests } from "./app/requests";
import { editShadowNode, nativeShadow, reconciliationCommand } from "./app/shadow";
import { createTrayController, type TrayHandle, type TrayOptions } from "./app/tray";
import { createMenuBarController, withMenuBar, type MenuBarItem, type MenuBarOptions } from "./app/menu-bar";
import { AppMenuBar, menuBarState } from "./menu-bar";
import { withRenderScope } from "./render-scope";
export type { MenuBarItem, MenuBarOptions } from "./app/menu-bar";

const APP_MENU_BAR_ID = "tarve-menubar";

import { PhaseSamples } from "./app/stats";
import { DevErrorOverlay } from "./dev-overlay";
import { iconBytes, iconFileForShell, runtimeAppMetadata } from "./app-metadata";
import { applySavedState, windowStateStore } from "./window-state";
import { nativeAssetPath } from "./embedded-assets";
import { readAutomation, runAutomation } from "./app/automation";
import { createInspector, INSPECTOR_SLOT, type Inspector } from "./devtools/inspector";
export type { DevOptions } from "./devtools/inspector";

/** Bridges of windows opened with `openWindow`: they never get an inspector of their own. */
const childWindowBridges = new WeakSet<NativeBridge>();
/** Windows opened with `openWindow` share the first window's plugins and their commands. */
const childPluginHosts = new WeakMap<NativeBridge, PluginHost>();
import { createPluginHost, type PluginHost } from "./plugins";
import { createOpenRequests } from "./app/open-requests";
import { createDeviceRequests, type DeviceRequests } from "./app/device";
export type { OpenEvent, OpenFilesListener, OpenUrlListener } from "./app/open-requests";

/** The command-line automation (`--tarve-script`, `--tarve-snapshot`) drives the first app only. */
let automationClaimed = false;

export type { TrayAvailability, TrayMenuItem, TrayOptions, TrayHandle } from "./app/tray";
export type { AppErrorSource, AppErrorEvent, AppOptions, SystemMediaSession, NotifyOptions, DiagnosticInput, AppJsStats, AppStats, OpenWindowOptions, AppHandle } from "./app/types";
import type { AppErrorSource, AppErrorEvent, AppOptions, SystemMediaSession, NotifyOptions, DiagnosticInput, AppJsStats, AppStats, OpenWindowOptions, AppHandle } from "./app/types";
const DEV_OVERLAY_SOURCES = new Set<AppErrorSource>(["render", "event-handler", "listener", "hotkey"]);
const DEV_APP_KEY = Symbol.for("tarve.devApp");
// <input type="file"> and <audio controls> reach the app that is rendering or
// handling an event through this slot, as DOM elements reach their document.
const ACTIVE_APP_KEY = Symbol.for("tarve.activeApp");

function envFlag(name: string): boolean {
  return typeof process !== "undefined" && process.env?.[name] === "1";
}

function asError(value: unknown): Error {
  return value instanceof Error ? value : new Error(String(value));
}

export function createApp(view: () => VNode, options: AppOptions = {}): AppHandle {
  const automation = options.bridge || automationClaimed ? undefined : readAutomation();
  if (automation) {
    automationClaimed = true;
    options = { ...options, debug: true };
  }
  const bridge = options.bridge ?? new BunFfiBridge();
  /** Event listeners of the windows opened with `openWindow`, by window id. */
  const windows = new Map<string, (event: NativeEvent) => void>();
  let windowCount = 0;
  /** A bridge for one more window of this app: its commands and events go through the app's bridge. */
  function windowBridge(id: string): NativeBridge {
    return {
      start(document: SceneDocument, onEvent: (event: NativeEvent) => void): void {
        if (ended || closing) throw new Error("The app has closed");
        windows.set(id, onEvent);
        bridge.send({ type: "openWindow", window: id, document });
      },
      send(command: NativeCommand): void {
        bridge.send({ type: "toWindow", window: id, command });
      },
      join(): void {
        windows.delete(id);
      },
      ...(bridge.requestSync ? {
        requestSync(command: NativeCommand & { requestId: string }, timeoutMs: number): NativeEvent | undefined {
          return bridge.requestSync!({ type: "toWindow", window: id, command, requestId: command.requestId }, timeoutMs);
        },
      } : {}),
    };
  }
  let renderScope: object = {};
  let currentView = view;
  const devMode = options.dev === undefined ? envFlag("TARVE_DEV") : options.dev !== false;
  const wantsInspector = !(options.bridge && childWindowBridges.has(options.bridge)) && options.dev !== false
    && (typeof options.dev === "object" && options.dev.inspector !== undefined ? options.dev.inspector : envFlag("TARVE_INSPECTOR"));
  let inspector: Inspector | undefined;
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
    const renderer = options.renderer ?? (options.headless || options.lowPower ? "cpu" : "auto");
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
    const drawnMenu = menus.drawn();
    const size = viewport ?? initialViewport() ?? { width: appWindow?.width ?? 1120, height: appWindow?.height ?? 760 };
    const compile = () => compileTree(
      drawnMenu ? withMenuBar(currentView(), jsx(AppMenuBar, { id: APP_MENU_BAR_ID, items: drawnMenu, onSelect: (id: string) => onNativeEvent({ type: "menu", id }) })) : currentView(), options.debug, renderer, options.componentAdapters, scope, !options.headless, viewport,
    );
    const tracked = trackViewport(size, () => withRenderScope(scope, () => inspector ? inspector.compile(compile) : compile()));
    const tree = tracked.value;
    inspector?.decorate(tree);
    // `viewport()` read the size: the root reports it, and any change re-renders.
    if (tracked.readSize) { tree.usesViewport = true; tree.readsViewportSize = true; tree.document.root.reportSize = true; }
    if (tracked.readEnvironment) tree.environment = environmentKey();
    appWindow = tree.document.window;
    if (options.closeBehavior === "hide") tree.document.root.closeIntercept = true;
    Object.assign(tree.document, appIdentityDocument());
    if (options.msaa !== undefined) tree.document.msaa = options.msaa;
    else if (options.lowPower) tree.document.msaa = 0;
    if (options.textRendering) tree.document.textRendering = options.textRendering;
    if (options.keyboardEvents) tree.document.keyboardEvents = true;
    if (options.pointerEvents) tree.document.pointerEvents = true;
    if (options.memoryTrimDelay !== undefined) tree.document.memoryTrimDelay = options.memoryTrimDelay === false ? -1 : options.memoryTrimDelay;
    if (options.lowPower) tree.document.lowPower = true;
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
  const opens = createOpenRequests({ protocols: options.protocols, fileTypes: options.fileTypes, report: error => reportError(error, { source: "listener", event: "open" }) });
  void closed.then(() => opens.dispose({ appClosed: !childWindowBridges.has(bridge) }));
  // Share, location and biometrics: created with the bridge's requests (below).
  let device!: DeviceRequests;
  void closed.then(() => device?.dispose());
  /** Plugin setups and commands; a window opened with `openWindow` reuses its opener's. */
  let pluginHost: PluginHost | undefined = options.bridge ? childPluginHosts.get(options.bridge) : undefined;

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
  device = createDeviceRequests({
    request: (command, timeoutMs) => requests.request(command, timeoutMs),
    permissions: (action, names) => requests.permissions(action, names),
    send: command => { if (!ended) sendPublic(command); },
    report: (error, event) => reportError(error, { source: "listener", event }),
  });
  const trays = createTrayController(appIcon, command => { if (!ended) sendPublic(command); });
  const menus = createMenuBarController({
    send: command => { if (!ended) sendPublic(command); },
    registerHotkey: (shortcut, handler) => app.registerHotkey(shortcut, handler),
    update: () => { if (!ended) update(); },
    openMenu: index => {
      const state = menuBarState(APP_MENU_BAR_ID, renderScope);
      if (index === null) { state.open = null; state.sub = null; app.focus(`${APP_MENU_BAR_ID}-menu-0`); return; }
      state.open = index;
      state.sub = null;
      // Rendered first: the focus goes to an item of the menu this opens.
      update();
      const first = (menus.drawn()?.[index] as { items?: MenuBarItem[] } | undefined)?.items?.findIndex(item => item.type !== "separator" && !item.disabled) ?? -1;
      app.focus(first >= 0 ? `${APP_MENU_BAR_ID}-item-${index}-${first}` : `${APP_MENU_BAR_ID}-menu-${index}`);
    },
  });
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
    queueMicrotask(() => { if (queued) renderQueued(); });
  }

  /** Renders the queued update and sends its patch. */
  function renderQueued(): void {
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
    // The title is a window option: native sets it at creation, later renders send it.
    const title = next.document.window.title;
    if (committed.document.window.title !== title) {
      sendInternal({ type: "windowTitle", title }, { source: "bridge", event: "windowTitle" });
    }
    committed = next;
    observed = nextObserved;
    syncMedia();
    jsStats.update.push(performance.now() - updateStarted);
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
    // The app's other windows close with it.
    for (const onEvent of [...windows.values()]) onEvent({ type: "closed" });
    windows.clear();
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

    if (event.type === "windowState" && rememberKey) {
      windowStateStore().set(rememberKey, { x: event.x, y: event.y, width: event.width, height: event.height, maximized: event.maximized, ...(event.physical ? { physical: true } : {}) });
    }
    if (event.type === "closed") {
      if (rememberKey) windowStateStore().flush();
      finishClosed();
    }

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

    if (!ended && (event.type === "tray" || event.type === "trayMenu" || event.type === "trayAvailability" || event.type === "notificationClick")) {
      const run = (name: string, handler: (() => void) | undefined): boolean => {
        if (!handler) return false;
        try { handler(); return true; } catch (error) { reportError(error, { source: "event-handler", event: name }); return false; }
      };
      let ran: boolean;
      if (event.type !== "notificationClick") ran = trays.dispatch(event, run);
      else {
        const handler = event.id === undefined ? lastNotificationClick : notificationClicks.get(event.id);
        if (event.id !== undefined) notificationClicks.delete(event.id);
        ran = run("notificationClick", handler);
      }
      if (ran) update();
    }

    if (!ended && event.type === "menu") {
      const handler = menus.handler(event.id);
      if (handler && invokeHandler("menu", event.id, handler)) update();
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
    if (!ended && (event.type === "position" || event.type === "speech")) device[event.type](event);
    if (!ended && event.type === "open") opens.deliver(event, event.initial);

    if (event.type === "environment") {
      setEnvironment(event);
      if (!ended && committed?.environment !== undefined && committed.environment !== environmentKey()) update();
    }

    if (!ended && committed && event.type === "size" && event.id === committed.document.root.id) {
      const portrait = (size?: { width: number; height: number }) => !!size && size.height > size.width;
      const crossed = committed.usesViewport && (viewport?.width !== event.width || portrait(viewport) !== portrait(event))
        || !!committed.readsViewportSize && viewport?.height !== event.height;
      viewport = { width: event.width, height: event.height };
      if (crossed) update();
    }
    // `keyboard` and `pointer` events go to `onEvent` listeners only: they name the focused node, not a handler.
    if (!ended && committed && observed && event.type !== "keyboard" && event.type !== "pointer" && event.type !== "notificationClick" && "id" in event) {
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
  /** onClick by notification id; the newest one answers a click without an id (the Windows tray balloon). */
  const notificationClicks = new Map<string, () => void>();
  let lastNotificationClick: (() => void) | undefined;
  let notificationCount = 0;

  function syncMedia(): void {
    if (!ended && committed) syncLoadedMedia(committed);
  }

  function onNativeEvent(event: NativeEvent): void {
    // Events of the app's other windows go to their own app handles.
    const target = (event as { window?: string }).window;
    if (target !== undefined) {
      const { window: _, ...own } = event as NativeEvent & { window: string };
      windows.get(target)?.(own as NativeEvent);
      return;
    }
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
        reportError(error, { source: "listener", event: event.type, ...("id" in event && event.id !== null ? { targetId: event.id } : {}) });
      }
    }
  }

  const app: AppHandle = {
    ready,
    closed,
    update,
    flush(): void {
      if (queued) renderQueued();
    },
    layout(ids: string[]): Record<string, LayoutBox> | undefined {
      if (ended || closing || !bridge.requestSync) return undefined;
      if (queued) renderQueued();
      try {
        // Startup can wait for the window and graphics device to come up.
        const event = bridge.requestSync({ type: "layout", ids, requestId: crypto.randomUUID() }, started ? 1000 : 5000);
        return event?.type === "layout" ? event.boxes : undefined;
      } catch (error) {
        reportError(error, { source: "bridge", event: "layout" });
        return undefined;
      }
    },
    textSelection(): { id: string; anchor: number; focus: number } | undefined {
      if (ended || closing || !bridge.requestSync) return undefined;
      try {
        const event = bridge.requestSync({ type: "selection", requestId: crypto.randomUUID() }, 1000);
        return event?.type === "selection" && event.target !== null ? { id: event.target, anchor: event.anchor, focus: event.focus } : undefined;
      } catch (error) {
        reportError(error, { source: "bridge", event: "selection" });
        return undefined;
      }
    },
    openWindow(windowView: () => VNode, windowOptions: OpenWindowOptions = {}): AppHandle {
      if (ended || closing) throw new Error("The app has closed");
      const { id = `window-${++windowCount}`, rememberWindow, ...rest } = windowOptions;
      if (windows.has(id)) throw new Error(`Window '${id}' is already open`);
      const childBridge = windowBridge(id);
      childWindowBridges.add(childBridge);
      if (pluginHost) childPluginHosts.set(childBridge, pluginHost);
      return createApp(windowView, {
        debug: options.debug, renderer: options.renderer, componentAdapters: options.componentAdapters,
        onError: options.onError, maxFps: options.maxFps, msaa: options.msaa, textRendering: options.textRendering, lowPower: options.lowPower, ...rest,
        ...(rememberWindow ? { rememberWindow: rememberWindow === true ? id : rememberWindow } : {}),
        bridge: childBridge,
      });
    },
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
    activate(): void {
      if (!ended) sendPublic({ type: "window", action: "activate" });
    },
    setMaximized(maximized: boolean): void {
      if (!ended) sendPublic({ type: "window", action: maximized ? "maximize" : "unmaximize" });
    },
    setFullscreen(fullscreen: boolean): void {
      if (!ended) sendPublic({ type: "window", action: fullscreen ? "fullscreen" : "exitFullscreen" });
    },
    toggleFullscreen(): void {
      if (!ended) sendPublic({ type: "window", action: "toggleFullscreen" });
    },
    tray(initial: TrayOptions): TrayHandle {
      return trays.tray(initial);
    },
    menuBar(items: readonly MenuBarItem[] | null, menuOptions?: MenuBarOptions): void {
      if (!ended) menus.set(items, menuOptions);
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
      const id = `n${++notificationCount}`;
      lastNotificationClick = onClick;
      if (onClick) {
        notificationClicks.set(id, onClick);
        // Unclicked notifications are dismissed eventually: keep the newest 100 handlers.
        if (notificationClicks.size > 100) notificationClicks.delete(notificationClicks.keys().next().value!);
      }
      if (!ended) sendPublic({ type: "notify", title, body, id });
    },
    checkPermissions: names => requests.permissions("check", names),
    requestPermissions: names => requests.permissions("request", names),
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
    openFilesDialog: dialogOptions => requests.fileDialog("openFiles", dialogOptions),
    async openFolderDialog(dialogOptions?: FileDialogOptions): Promise<string | undefined> {
      return (await requests.fileDialog("openFolder", dialogOptions))[0];
    },
    saveFileDialog: async dialogOptions => (await requests.fileDialog("saveFile", dialogOptions))[0],
    webSignIn: options => requests.webSignIn(options),
    onOpenUrl: listener => opens.onOpenUrl(listener),
    onOpenFiles: listener => opens.onOpenFiles(listener),
    share: shareOptions => device.share(shareOptions),
    getCurrentPosition: positionOptions => device.getCurrentPosition(positionOptions),
    watchPosition: (callback, positionOptions) => device.watchPosition(callback, positionOptions),
    authenticate: authOptions => device.authenticate(authOptions), recognizeSpeech: speechOptions => device.recognizeSpeech(speechOptions),
    invoke<R = unknown>(command: string, ...args: unknown[]): Promise<R> {
      if (!pluginHost) return Promise.reject(new Error(`Unknown plugin command: ${command} (the app has no plugins)`));
      return pluginHost.invoke(command, args) as Promise<R>;
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

  if (wantsInspector) {
    inspector = createInspector(app);
    // Not public API: smoke tests reach the inspector through this slot.
    Object.defineProperty(app, INSPECTOR_SLOT, { value: inspector });
  }
  if (!pluginHost && options.plugins?.length) {
    pluginHost = createPluginHost(options.plugins, {
      app,
      request: (command, timeoutMs) => requests.request(command, timeoutMs),
      report: (error, event) => { reportError(error, { source: "plugin", event }); },
    });
  }
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

  const rememberKey = options.rememberWindow === true ? "main" : options.rememberWindow || undefined;
  if (rememberKey) {
    try {
      committed.document.window = applySavedState(committed.document.window, windowStateStore().get(rememberKey));
    } catch (error) {
      reportError(error, { source: "bridge", event: "rememberWindow" });
    }
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

  if (automation && !ended) void runAutomation(app, automation);
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
