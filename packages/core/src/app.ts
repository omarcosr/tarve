import type { FileDialogOptions, NativeEvent, NativeCommand, NativeNode, NativeTrayMenuItem, Renderer, Snapshot } from "../../protocol/src/index";
import { readFileSync } from "node:fs";
import { applyMediaEvent, type MediaController, type MediaRequest } from "./media-element";
import { BunFfiBridge, type NativeBridge } from "./bridge";
import { compileTree, diffTreeMutations, type CompiledTree, type Handlers, invalidateMemos } from "./reconciler";
import { normalizeHotkey, type HotkeyHandler } from "./hotkeys";
import type { VNode, PastePayload } from "./jsx-runtime";
import { withRenderScope } from "./render-scope";
import type { ComponentAdapter } from "./component-adapter";
import { DevErrorOverlay } from "./dev-overlay";

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
}

export type TrayMenuItem =
  | { type: "separator" }
  | { type?: "item"; id: string; label: string; checked?: boolean; disabled?: boolean; onSelect?: () => void; items?: TrayMenuItem[] };

export interface TrayOptions {
  /** PNG/JPEG/WebP path (also `import icon from "./tray.png" with { type: "file" }` in compiled apps). Defaults to the system application icon. */
  icon?: string;
  tooltip?: string;
  menu?: TrayMenuItem[];
  onClick?: () => void;
  onDoubleClick?: () => void;
  /** Called with the selected item id, after the item's own onSelect. */
  onMenu?: (id: string) => void;
}

export interface TrayHandle {
  /** Merges and re-applies options; the shell icon is modified in place, not recreated. */
  update(options: Partial<TrayOptions>): void;
  remove(): void;
}

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
export interface AppHandle {
  ready: Promise<void>;
  closed: Promise<void>;
  update(): void;
  close(): void;
  focus(id: string): void;
  scrollToItem(id: string, index: number, offset?: number): void;
  registerHotkey(shortcut: string, handler: HotkeyHandler): () => void;
  show(): void;
  hide(): void;
  minimize(): void;
  /** Shows a system tray icon (Windows). A second call replaces the first tray. */
  tray(options: TrayOptions): TrayHandle;
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

function validateFileDialogOptions(options: FileDialogOptions): void {
  if ((options.title?.length ?? 0) > 4096 || (options.fileName?.length ?? 0) > 4096 || (options.directory?.length ?? 0) > 32_768) {
    throw new RangeError("File dialog text exceeds length limit");
  }
  const filters = options.filters ?? [];
  if (filters.length > 64) throw new RangeError("File dialog filter limit exceeded");
  for (const filter of filters) {
    if (!filter.name || filter.name.length > 256 || filter.extensions.length === 0 || filter.extensions.length > 64) {
      throw new TypeError("File dialog filters require a name and 1-64 extensions");
    }
    if (filter.extensions.some(extension => {
      const value = extension.trim().replace(/^\./, "");
      return !value || value.length > 32 || /[\\/*?]/.test(value);
    })) throw new TypeError("Invalid file dialog extension");
  }
}

/**
 * The tree native is known to hold. Nodes are copied shallowly: the shadow only
 * ever replaces a node's own `value`/`control` fields (optimistic edits), so
 * styles and other nested values are shared with the compiled tree instead of
 * deep-cloned, which kept a second copy of every style object alive.
 */
/** The compiled node each shadow node copies; a memoized subtree keeps its shadow. */
const shadowSources = new WeakMap<NativeNode, NativeNode>();
/** Set when a native edit mutates a shadow node, so the next shadow copies every node. */
let shadowEdited = false;

function nativeShadow(tree: CompiledTree, previous?: CompiledTree): CompiledTree {
  const nodes = new Map<string, NativeNode>();
  // A native edit (typing, a slider drag) changed a shadow node in place: copy everything once.
  const reuse = !shadowEdited;
  shadowEdited = false;
  const keep = (node: NativeNode): void => {
    nodes.set(node.id, node);
    for (const child of node.children) keep(child);
  };
  const copy = (source: NativeNode): NativeNode => {
    const kept = previous?.nodes.get(source.id);
    if (reuse && kept && shadowSources.get(kept) === source) {
      keep(kept);
      return kept;
    }
    const node: NativeNode = { ...source, children: source.children.map(copy) };
    shadowSources.set(node, source);
    const old = previous?.nodes.get(node.id);
    if ((node.kind === "input" || node.kind === "textarea") && node.value === undefined && old?.kind === node.kind) {
      node.value = old.value;
    }
    nodes.set(node.id, node);
    return node;
  };
  const document = { ...tree.document, root: copy(tree.document.root) };
  return { document, handlers: tree.handlers, nodes };
}

function reconciliationCommand(previous: CompiledTree, next: CompiledTree): NativeCommand | undefined {
  const mutations = diffTreeMutations(previous, next, (old, node) => shadowSources.get(old) === node);
  if (mutations === null) return { type: "update", root: next.document.root };
  if (mutations.length === 0) return undefined;
  if (mutations.every(mutation => mutation.type === "patch")) {
    return { type: "patch", nodes: mutations.map(mutation => mutation.node) };
  }
  return { type: "mutate", mutations };
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
        return overlay;
      } catch (overlayError) {
        devOverlayBroken = true;
        try { console.error("[tarve] dev error overlay failed", asError(overlayError)); } catch {}
      }
    }
    (globalThis as Record<symbol, unknown>)[ACTIVE_APP_KEY] = app;
    const tree = withRenderScope(scope, () => compileTree(
      currentView(), options.debug, renderer, options.componentAdapters, scope, !options.headless,
    ));
    appWindow = tree.document.window;
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
  let queued = false;
  let ended = false;
  let closing = false;
  let started = false;
  let readySettled = false;
  let closedSettled = false;
  let terminalError: Error | undefined;
  const listeners = new Set<(event: NativeEvent) => void>();
  const hotkeys = new Map<string, Set<HotkeyHandler>>();
  const pending = new Map<string, {
    resolve: (event: NativeEvent) => void;
    reject: (error: Error) => void;
    source: "request" | "file-dialog";
    command: NativeCommand["type"];
    timer?: ReturnType<typeof setTimeout>;
  }>();
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

  function rejectPending(error: Error): void {
    for (const item of pending.values()) {
      if (item.timer) clearTimeout(item.timer);
      item.reject(error);
    }
    pending.clear();
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

      let next: CompiledTree;
      try {
        next = compileView();
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
        command = reconciliationCommand(observed, next);
      } catch (error) {
        reportError(error, { source: "render", event: "diff" });
        restoreCommitted();
        return;
      }

      let nextObserved: CompiledTree;
      try {
        nextObserved = nativeShadow(next, observed);
      } catch (error) {
        reportError(error, { source: "render", event: "shadow" });
        restoreCommitted();
        return;
      }

      if (command) {
        if (!sendInternal(command, { source: "bridge", event: command.type })) {
          restoreCommitted();
          return;
        }
      }

      committed = next;
      observed = nextObserved;
      syncMedia();
    });
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

  function request(
    command: NativeCommand & { requestId: string },
    timeoutMs: number | undefined = 10_000,
    source: "request" | "file-dialog" = "request",
  ): Promise<NativeEvent> {
    if (ended) return Promise.reject(terminalError ?? new Error("Native window is closed"));
    return new Promise((resolve, reject) => {
      const timer = timeoutMs === undefined ? undefined : setTimeout(() => {
        pending.delete(command.requestId);
        const error = reportError(new Error(`Native request timed out: ${command.type}`), { source, event: command.type });
        reject(error);
      }, timeoutMs);
      pending.set(command.requestId, { resolve, reject, source, command: command.type, timer });
      try {
        bridge.send(command);
      } catch (value) {
        if (timer) clearTimeout(timer);
        pending.delete(command.requestId);
        const error = reportError(value, { source, event: command.type });
        reject(error);
      }
    });
  }

  async function fileDialog(mode: "openFile" | "openFiles" | "openFolder" | "saveFile", dialogOptions: FileDialogOptions = {}): Promise<string[]> {
    validateFileDialogOptions(dialogOptions);
    const event = await request({ type: "fileDialog", mode, options: dialogOptions, requestId: crypto.randomUUID() }, undefined, "file-dialog");
    if (event.type !== "fileDialog") {
      const error = reportError(new Error("Unexpected native file dialog response"), { source: "file-dialog", event: mode });
      throw error;
    }
    if (event.error) {
      const error = reportError(new Error(event.error), { source: "file-dialog", event: mode });
      throw error;
    }
    return event.paths;
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
    rejectPending(closeError);
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

  /** Last known pointer position and drop target per in-flight drag source. */
  const drags = new Map<string, { x: number; y: number; over: string | null }>();

  function dispatchDrag(
    event: Extract<NativeEvent, { type: "dragStart" | "dragMove" | "drop" | "dragCancel" }>,
    handlers: Handlers | undefined,
  ): { handled: boolean; succeeded: boolean } {
    let handled = false;
    let succeeded = true;
    const call = (name: string, id: string, handler: ((...args: never[]) => void) | undefined, arg?: unknown) => {
      if (!handler) return;
      handled = true;
      succeeded = invokeHandler(name, id, handler, arg as never) && succeeded;
    };
    const target = (id: string) => committed?.handlers.get(id);
    const source = event.id;
    if (event.type === "dragStart") {
      drags.set(source, { x: event.x, y: event.y, over: null });
      call("dragStart", source, handlers?.onDragStart as never, { x: event.x, y: event.y });
      return { handled, succeeded };
    }
    const state = drags.get(source) ?? { x: 0, y: 0, over: null };
    if (event.type === "dragMove") {
      drags.set(source, { x: event.x, y: event.y, over: event.over });
      if (state.over !== event.over) {
        if (state.over) call("dragLeave", state.over, target(state.over)?.onDragLeave as never, source);
        if (event.over) call("dragEnter", event.over, target(event.over)?.onDragEnter as never, source);
      }
      call("dragMove", source, handlers?.onDragMove as never, { x: event.x, y: event.y, over: event.over });
      return { handled, succeeded };
    }
    drags.delete(source);
    const dropped = event.type === "drop" ? event.target : null;
    const x = event.type === "drop" ? event.x : state.x;
    const y = event.type === "drop" ? event.y : state.y;
    if (state.over && state.over !== dropped) call("dragLeave", state.over, target(state.over)?.onDragLeave as never, source);
    if (dropped) call("drop", dropped, target(dropped)?.onDrop as never, { source, x, y });
    call("dragEnd", source, handlers?.onDragEnd as never, { target: dropped, x, y, cancelled: event.type === "dragCancel" });
    return { handled, succeeded };
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
      if (event.type === "tray") ran = run(event.action === "click" ? "trayClick" : "trayDoubleClick", event.action === "click" ? trayOptions?.onClick : trayOptions?.onDoubleClick);
      else if (event.type === "trayMenu") {
        ran = run("trayMenu", trayItemHandlers.get(event.id));
        const onMenu = trayOptions?.onMenu;
        if (onMenu) ran = run("trayMenu", () => onMenu(event.id)) || ran;
      } else ran = run("notificationClick", notificationClick);
      if (ran) update();
    }

    if (!ended && event.type === "media") {
      const handler = applyMediaEvent(event, committed?.media?.get(event.id));
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

    if ("requestId" in event) {
      const item = pending.get(event.requestId);
      if (item) {
        if (item.timer) clearTimeout(item.timer);
        pending.delete(event.requestId);
        item.resolve(event);
      }
    }

    if (!ended && committed && observed && "id" in event) {
      const handlers = committed.handlers.get(event.id);
      if (handlers) invalidateMemos(renderScope, event.id);
      let optimisticEdit = false;
      if (event.type === "change") {
        const node = observed.nodes.get(event.id);
        if (node && (node.kind === "input" || node.kind === "textarea")) {
          node.value = event.value;
          shadowSources.delete(node);
            shadowEdited = true;
          optimisticEdit = true;
        }
      }
      if (event.type === "valueChange") {
        const node = observed.nodes.get(event.id);
        if (node?.control) {
          node.control = { ...node.control, value: event.value };
          shadowSources.delete(node);
            shadowEdited = true;
          optimisticEdit = true;
        }
      }

      let handled = false;
      let succeeded = true;
      if (event.type === "click" && handlers?.onClick) { handled = true; succeeded = invokeHandler("click", event.id, handlers.onClick); }
      if (event.type === "markdownLink" && handlers?.onMarkdownLink) { handled = true; succeeded = invokeHandler("markdownLink", event.id, handlers.onMarkdownLink as (...args: never[]) => void, event.href as never); }
      if (event.type === "diffToggleFile" && handlers?.onDiffToggleFile) { handled = true; succeeded = invokeHandler("diffToggleFile", event.id, handlers.onDiffToggleFile as (...args: never[]) => void, event.path as never); }
      if (event.type === "diffShowMore" && handlers?.onDiffShowMore) { handled = true; succeeded = invokeHandler("diffShowMore", event.id, handlers.onDiffShowMore as (...args: never[]) => void, event.hidden as never, (event.path ?? undefined) as never); }
      if (event.type === "diffLineClick" && handlers?.onDiffLineClick) { handled = true; succeeded = invokeHandler("diffLineClick", event.id, handlers.onDiffLineClick as (...args: never[]) => void, { text: event.text, path: event.path ?? undefined, oldLine: event.oldLine ?? undefined, newLine: event.newLine ?? undefined } as never); }
      if (event.type === "highlight" && handlers?.onHighlight) { handled = true; succeeded = invokeHandler("highlight", event.id, handlers.onHighlight as (...args: never[]) => void, { matchCount: event.matchCount, query: event.query, caseSensitive: event.caseSensitive, wholeWord: event.wholeWord } as never); }
      if (event.type === "context" && handlers?.onContextMenu) { handled = true; succeeded = invokeHandler("context", event.id, handlers.onContextMenu as (...args: never[]) => void, { x: event.x, y: event.y } as never); }
      if (event.type === "outside" && handlers?.onOutsideClick) { handled = true; succeeded = invokeHandler("outside", event.id, handlers.onOutsideClick); }
      if (event.type === "submit" && handlers?.onSubmit) { handled = true; succeeded = invokeHandler("submit", event.id, handlers.onSubmit as (...args: never[]) => void, event.value as never); }
      if (event.type === "paste" && handlers?.onPaste) {
        const payload = pastePayload(event);
        if (payload) { handled = true; succeeded = invokeHandler("paste", event.id, handlers.onPaste as (...args: never[]) => void, payload as never); }
      }
      if (event.type === "change" && handlers?.onChange) { handled = true; succeeded = invokeHandler("change", event.id, handlers.onChange as (...args: never[]) => void, event.value as never); }
      if (event.type === "valueChange" && handlers?.onValueChange) { handled = true; succeeded = invokeHandler("valueChange", event.id, handlers.onValueChange as (...args: never[]) => void, event.value as never); }
      if (event.type === "scroll" && handlers?.onScroll) { handled = true; succeeded = invokeHandler("scroll", event.id, handlers.onScroll as (...args: never[]) => void, event.offset as never, event.max as never); }
      if (event.type === "scroll" && handlers?.onScrollPosition) {
        handled = true;
        const position = {
          x: event.offsetX ?? 0,
          y: event.offsetY ?? event.offset,
          maxX: event.maxX ?? 0,
          maxY: event.maxY ?? event.max,
        };
        succeeded = invokeHandler("scrollPosition", event.id, handlers.onScrollPosition as (...args: never[]) => void, position as never) && succeeded;
      }
      if (event.type === "virtualListLayout" && handlers?.onVirtualListLayout) {
        handled = true;
        succeeded = invokeHandler("virtualListLayout", event.id, handlers.onVirtualListLayout as (...args: never[]) => void, event.items as never) && succeeded;
      }
      if (event.type === "size" && handlers?.onSize) {
        handled = true;
        succeeded = invokeHandler("size", event.id, handlers.onSize as (...args: never[]) => void, { width: event.width, height: event.height } as never) && succeeded;
      }
      if (event.type === "virtualListScrollToItem" && handlers?.onVirtualListScrollToItem) {
        handled = true;
        succeeded = invokeHandler(
          "virtualListScrollToItem",
          event.id,
          handlers.onVirtualListScrollToItem as (...args: never[]) => void,
          event.index as never,
          event.offset as never,
        ) && succeeded;
      }
      if (event.type === "virtualListFocus" && handlers?.onVirtualListFocus) {
        handled = true;
        succeeded = invokeHandler("virtualListFocus", event.id, handlers.onVirtualListFocus as (...args: never[]) => void, event.key as never) && succeeded;
      }
      if (event.type === "dragStart" || event.type === "dragMove" || event.type === "drop" || event.type === "dragCancel") {
        const result = dispatchDrag(event, handlers);
        handled = result.handled;
        succeeded = result.succeeded && succeeded;
      }
      if (event.type === "hover" && handlers?.onHover) { handled = true; succeeded = invokeHandler("hover", event.id, handlers.onHover as (...args: never[]) => void, event.entered as never); }
      if (event.type === "key" && handlers?.onKeyDown) { handled = true; succeeded = invokeHandler("key", event.id, handlers.onKeyDown as (...args: never[]) => void, event.key as never); }
      if (event.type === "blur" && handlers?.onBlur) { handled = true; succeeded = invokeHandler("blur", event.id, handlers.onBlur); }
      if (event.type === "motionComplete" && handlers?.onTransitionEnd) {
        handled = true;
        succeeded = invokeHandler(
          "motionComplete",
          event.id,
          handlers.onTransitionEnd as (...args: never[]) => void,
          { property: event.property } as never,
        );
      }

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

  let trayOwner: object | undefined;
  let trayOptions: TrayOptions | undefined;
  let notificationClick: (() => void) | undefined;
  let trayIconPath: string | undefined;
  let trayIconData: string | undefined;
  let trayIconSent = false;
  const trayItemHandlers = new Map<string, () => void>();

  function applyTray(): void {
    if (!trayOptions) return;
    trayItemHandlers.clear();
    const seen = new Set<string>();
    const convert = (items: readonly TrayMenuItem[]): NativeTrayMenuItem[] => items.map(item => {
      if (item.type === "separator") return { separator: true };
      if (!item.id) throw new TypeError("tray menu items need an id");
      if (item.items?.length) return { label: item.label, ...(item.disabled ? { disabled: true } : {}), items: convert(item.items) };
      if (seen.has(item.id)) throw new TypeError(`duplicate tray menu id "${item.id}"`);
      seen.add(item.id);
      if (item.onSelect) trayItemHandlers.set(item.id, item.onSelect);
      return { id: item.id, label: item.label, ...(item.checked !== undefined ? { checked: item.checked } : {}), ...(item.disabled ? { disabled: true } : {}) };
    });
    const menu = convert(trayOptions.menu ?? []);
    // Read here, not natively: `$bunfs` paths of compiled executables and imported
    // assets (`import icon from "./tray.png" with { type: "file" }`) only exist in JS.
    if (trayOptions.icon !== trayIconPath) {
      trayIconData = trayOptions.icon ? Buffer.from(readFileSync(trayOptions.icon)).toString("base64") : undefined;
      trayIconPath = trayOptions.icon;
      trayIconSent = false;
    }
    const iconData = trayIconSent ? undefined : trayIconData;
    trayIconSent = true;
    if (!ended) sendPublic({ type: "tray", tray: { ...(iconData ? { iconData } : {}), ...(trayOptions.tooltip ? { tooltip: trayOptions.tooltip } : {}), menu } });
  }

  // Loaded media per element id; reconciled with each committed render.
  const loadedMedia = new Map<string, MediaRequest>();
  function syncMedia(): void {
    if (ended || !committed) return;
    const wanted = committed.media ?? new Map<string, MediaRequest>();
    for (const id of [...loadedMedia.keys()]) {
      if (!wanted.has(id) || !wanted.get(id)!.src) {
        loadedMedia.delete(id);
        sendInternal({ type: "media", id, action: "unload" }, { source: "bridge", event: "media:unload", targetId: id });
      }
    }
    for (const [id, request] of wanted) {
      if (!request.src) continue;
      const previous = loadedMedia.get(id);
      const src = resolveMediaPath(request.src);
      if (!previous || resolveMediaPath(previous.src!) !== src) {
        sendInternal({ type: "media", id, action: "load", src, loop: request.loop, muted: request.muted, volume: request.volume },
          { source: "bridge", event: "media:load", targetId: id });
        if (request.autoPlay) sendInternal({ type: "media", id, action: "play" }, { source: "bridge", event: "media:play", targetId: id });
      } else if (previous.loop !== request.loop || previous.muted !== request.muted || previous.volume !== request.volume) {
        sendInternal({ type: "media", id, action: "set", loop: request.loop, muted: request.muted, volume: request.volume },
          { source: "bridge", event: "media:set", targetId: id });
      }
      loadedMedia.set(id, request);
    }
  }
  function resolveMediaPath(src: string): string {
    return src.startsWith("file://") ? new URL(src).pathname.replace(/^\/([A-Za-z]:)/, "$1") : src;
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
      if (!ended) sendPublic({ type: "focus", id });
    },
    scrollToItem(id: string, index: number, offset = 0): void {
      if (!id) throw new TypeError("scrollToItem requires a list id");
      if (!Number.isInteger(index) || index < 0) throw new RangeError("scrollToItem index must be a nonnegative integer");
      if (!Number.isFinite(offset)) throw new RangeError("scrollToItem offset must be finite");
      if (!ended) sendPublic({ type: "scrollToItem", id, index, ...(offset !== 0 ? { offset } : {}) });
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
      const token = {};
      trayOwner = token;
      trayOptions = { ...initial };
      trayIconSent = false;
      applyTray();
      return {
        update(next: Partial<TrayOptions>): void {
          if (trayOwner !== token) return;
          trayOptions = { ...trayOptions, ...next };
          applyTray();
        },
        remove(): void {
          if (trayOwner !== token) return;
          trayOwner = undefined;
          trayOptions = undefined;
          trayIconPath = undefined;
          trayIconData = undefined;
          trayItemHandlers.clear();
          if (!ended) sendPublic({ type: "tray", tray: null });
        },
      };
    },
    notify({ title, body = "", onClick }: NotifyOptions): void {
      if (!title) throw new TypeError("notify requires a title");
      notificationClick = onClick;
      if (!ended) sendPublic({ type: "notify", title, body });
    },
    media(id: string): MediaController {
      const send = (command: Omit<Extract<NativeCommand, { type: "media" }>, "type" | "id">) => {
        if (!ended) sendPublic({ type: "media", id, ...command });
      };
      return {
        play: () => send({ action: "play" }),
        pause: () => send({ action: "pause" }),
        seek: seconds => send({ action: "seek", time: Math.max(0, seconds) }),
        setVolume: volume => send({ action: "set", volume: Math.min(1, Math.max(0, volume)) }),
        setMuted: muted => send({ action: "set", muted }),
      };
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
      return (await fileDialog("openFile", dialogOptions))[0];
    },
    async openFilesDialog(dialogOptions?: FileDialogOptions): Promise<string[]> {
      return fileDialog("openFiles", dialogOptions);
    },
    async openFolderDialog(dialogOptions?: FileDialogOptions): Promise<string | undefined> {
      return (await fileDialog("openFolder", dialogOptions))[0];
    },
    async saveFileDialog(dialogOptions?: FileDialogOptions): Promise<string | undefined> {
      return (await fileDialog("saveFile", dialogOptions))[0];
    },
    onEvent(listener: (event: NativeEvent) => void): () => void {
      listeners.add(listener);
      return () => { listeners.delete(listener); };
    },
    async inspect(): Promise<Snapshot> {
      if (queued) await flushQueuedUpdate();
      const event = await request({ type: "inspect", requestId: crypto.randomUUID() });
      if (event.type !== "inspect") {
        const error = reportError(new Error("Unexpected native response"), { source: "request", event: "inspect" });
        throw error;
      }
      return event.snapshot;
    },
    async capture(path: string): Promise<void> {
      if (!options.debug) throw new Error("Enable debug to capture the rendered scene");
      if (queued) await flushQueuedUpdate();
      const event = await request({ type: "capture", path, requestId: crypto.randomUUID() });
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
      const event = await request({ type: "motionAdvance", milliseconds, requestId: crypto.randomUUID() });
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
    const fonts = options.fontFaces?.map(path => Buffer.from(readFileSync(path)).toString("base64"));
    bridge.start(fonts?.length ? { ...committed.document, fonts } : committed.document, onNativeEvent);
    syncMedia();
  } catch (error) {
    const startupError = reportError(error, { source: "bridge", event: "start" });
    terminalError = startupError;
    ended = true;
    settleReadyFailure(startupError);
    rejectPending(startupError);
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
function pastePayload(event: Extract<NativeEvent, { type: "paste" }>): PastePayload | undefined {
  if (event.files?.length) return { kind: "files", files: [...event.files] };
  if (event.image) {
    const bytes = Buffer.from(event.image.rgba, "base64");
    return { kind: "image", width: event.image.width, height: event.image.height, rgba: new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength) };
  }
  return undefined;
}
