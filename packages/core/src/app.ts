import type { FileDialogOptions, NativeEvent, NativeCommand, NativeNode, Renderer, Snapshot } from "../../protocol/src/index";
import { BunFfiBridge, type NativeBridge } from "./bridge";
import { compileTree, diffTreeMutations, type CompiledTree } from "./reconciler";
import { normalizeHotkey, type HotkeyHandler } from "./hotkeys";
import type { VNode } from "./jsx-runtime";
import { withRenderScope } from "./render-scope";
import type { ComponentAdapter } from "./component-adapter";

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
  openFileDialog(options?: FileDialogOptions): Promise<string | undefined>;
  openFilesDialog(options?: FileDialogOptions): Promise<string[]>;
  openFolderDialog(options?: FileDialogOptions): Promise<string | undefined>;
  saveFileDialog(options?: FileDialogOptions): Promise<string | undefined>;
  onEvent(listener: (event: NativeEvent) => void): () => void;
  inspect(): Promise<Snapshot>;
  capture(path: string): Promise<void>;
  debug(command: DiagnosticInput): void;
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

function nativeShadow(tree: CompiledTree, previous?: CompiledTree): CompiledTree {
  const document = structuredClone(tree.document);
  const nodes = new Map<string, NativeNode>();
  const index = (node: NativeNode): void => {
    const old = previous?.nodes.get(node.id);
    if ((node.kind === "input" || node.kind === "textarea") && node.value === undefined && old?.kind === node.kind) {
      node.value = old.value;
    }
    nodes.set(node.id, node);
    for (const child of node.children) index(child);
  };
  index(document.root);
  return { document, handlers: tree.handlers, nodes };
}

function reconciliationCommand(previous: CompiledTree, next: CompiledTree): NativeCommand | undefined {
  const mutations = diffTreeMutations(previous, next);
  if (mutations === null) return { type: "update", root: next.document.root };
  if (mutations.length === 0) return undefined;
  if (mutations.every(mutation => mutation.type === "patch")) {
    return { type: "patch", nodes: mutations.map(mutation => mutation.node) };
  }
  return { type: "mutate", mutations };
}

export function createApp(view: () => VNode, options: AppOptions = {}): AppHandle {
  const bridge = options.bridge ?? new BunFfiBridge();
  const renderScope = {};
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
    return error;
  }

  function settleReadySuccess(): void {
    if (readySettled) return;
    readySettled = true;
    started = true;
    resolveReady();
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
        next = withRenderScope(renderScope, () => compileTree(
          view(), options.debug, options.renderer ?? "auto", options.componentAdapters, renderScope, !options.headless,
        ));
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
    });
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

  function dispatchNativeEvent(event: NativeEvent): void {
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
        if (sendInternal({ type: "close" }, { source: "bridge", event: "closeRequest:close", targetId })) closing = true;
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
      let optimisticEdit = false;
      if (event.type === "change") {
        const node = observed.nodes.get(event.id);
        if (node && (node.kind === "input" || node.kind === "textarea")) {
          node.value = event.value;
          optimisticEdit = true;
        }
      }
      if (event.type === "valueChange") {
        const node = observed.nodes.get(event.id);
        if (node?.control) {
          node.control = { ...node.control, value: event.value };
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
      if (event.type === "hover" && handlers?.onHover) { handled = true; succeeded = invokeHandler("hover", event.id, handlers.onHover as (...args: never[]) => void, event.entered as never); }
      if (event.type === "key" && handlers?.onKeyDown) { handled = true; succeeded = invokeHandler("key", event.id, handlers.onKeyDown as (...args: never[]) => void, event.key as never); }
      if (event.type === "blur" && handlers?.onBlur) { handled = true; succeeded = invokeHandler("blur", event.id, handlers.onBlur); }

      if (!succeeded) restoreCommitted();
      else if (handled || optimisticEdit) update();
    }
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
      const event = await request({ type: "inspect", requestId: crypto.randomUUID() });
      if (event.type !== "inspect") {
        const error = reportError(new Error("Unexpected native response"), { source: "request", event: "inspect" });
        throw error;
      }
      return event.snapshot;
    },
    async capture(path: string): Promise<void> {
      if (!options.debug) throw new Error("Enable debug to capture the rendered scene");
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
    debug(command: DiagnosticInput): void {
      if (!options.debug) throw new Error("Enable debug to use diagnostic input/resize");
      sendPublic(command);
    },
  };

  try {
    committed = withRenderScope(renderScope, () => compileTree(
      view(), options.debug, options.renderer ?? "auto", options.componentAdapters, renderScope, !options.headless,
    ));
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
    bridge.start(committed.document, onNativeEvent);
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

export async function render(view: () => VNode, options?: AppOptions): Promise<void> {
  const app = createApp(view, options);
  await app.ready;
  await app.closed;
}
