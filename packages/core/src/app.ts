import type { FileDialogOptions, NativeEvent, NativeCommand, Snapshot } from "../../protocol/src/index";
import { BunFfiBridge, type NativeBridge } from "./bridge";
import { compileTree, diffTrees } from "./reconciler";
import { normalizeHotkey, type HotkeyHandler } from "./hotkeys";
import type { VNode } from "./jsx-runtime";

export interface AppOptions { debug?: boolean; bridge?: NativeBridge; onError?: (error: Error) => void }
export type DiagnosticInput = Extract<NativeCommand, { type: "input" | "resize" }>;
export interface AppHandle {
  ready: Promise<void>; closed: Promise<void>;
  update(): void; close(): void; focus(id: string): void;
  registerHotkey(shortcut: string, handler: HotkeyHandler): () => void;
  openFileDialog(options?: FileDialogOptions): Promise<string | undefined>;
  openFilesDialog(options?: FileDialogOptions): Promise<string[]>;
  openFolderDialog(options?: FileDialogOptions): Promise<string | undefined>;
  saveFileDialog(options?: FileDialogOptions): Promise<string | undefined>;
  onEvent(listener: (event: NativeEvent) => void): () => void;
  inspect(): Promise<Snapshot>; capture(path: string): Promise<void>;
  debug(command: DiagnosticInput): void;
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
export function createApp(view: () => VNode, options: AppOptions = {}): AppHandle {
  const bridge = options.bridge ?? new BunFfiBridge();
  let compiled = compileTree(view(), options.debug);
  let queued = false;
  let ended = false;
  let started = false;
  const listeners = new Set<(event: NativeEvent) => void>();
  const hotkeys = new Map<string, Set<HotkeyHandler>>();
  const pending = new Map<string, { resolve: (event: NativeEvent) => void; reject: (error: Error) => void; timer?: ReturnType<typeof setTimeout> }>();
  let resolveReady!: () => void;
  let rejectReady!: (error: Error) => void;
  let resolveClosed!: () => void;
  const ready = new Promise<void>((resolve, reject) => { resolveReady = resolve; rejectReady = reject; });
  const closed = new Promise<void>((resolve) => { resolveClosed = resolve; });
  function update(): void {
    if (queued || ended) return;
    queued = true;
    queueMicrotask(() => {
      queued = false;
      if (ended) return;
      const next = compileTree(view(), options.debug);
      if (compiled.document.window.decorations !== next.document.window.decorations) {
        const error = new Error("Adding or removing TitleBar after the native window has been created is not supported. Recreate the Window instead.");
        if (options.onError) options.onError(error); else console.error(`[tarve] ${error.message}`);
        return;
      }
      const nodes = diffTrees(compiled, next);
      compiled = next;
      if (nodes === null) bridge.send({ type: "update", root: compiled.document.root });
      else if (nodes.length > 0) bridge.send({ type: "patch", nodes });
    });
  }
  function request(command: NativeCommand & { requestId: string }, timeoutMs: number | undefined = 10_000): Promise<NativeEvent> {
    return new Promise((resolve, reject) => {
      const timer = timeoutMs === undefined ? undefined : setTimeout(() => {
        pending.delete(command.requestId);
        reject(new Error(`Native request timed out: ${command.type}`));
      }, timeoutMs);
      pending.set(command.requestId, { resolve, reject, timer });
      try { bridge.send(command); } catch (error) {
        if (timer) clearTimeout(timer);
        pending.delete(command.requestId);
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    });
  }
  async function fileDialog(mode: "openFile" | "openFiles" | "openFolder" | "saveFile", dialogOptions: FileDialogOptions = {}): Promise<string[]> {
    validateFileDialogOptions(dialogOptions);
    const event = await request({ type: "fileDialog", mode, options: dialogOptions, requestId: crypto.randomUUID() }, undefined);
    if (event.type !== "fileDialog") throw new Error("Unexpected native file dialog response");
    if (event.error) throw new Error(event.error);
    return event.paths;
  }
  bridge.start(compiled.document, (event) => {
    if (event.type === "ready") { started = true; resolveReady(); }
    if (event.type === "closed") {
      ended = true;
      bridge.join();
      if (!started) rejectReady(new Error("Native window closed before becoming ready"));
      for (const item of pending.values()) { if (item.timer) clearTimeout(item.timer); item.reject(new Error("Native window closed")); }
      pending.clear();
      resolveClosed();
    }
    if (event.type === "error") {
      const error = new Error(event.message);
      if (!started) rejectReady(error);
      if (options.onError) options.onError(error); else console.error(`[tarve] ${error.message}`);
    }
    if (event.type === "escape") {
      const handler = [...compiled.handlers.values()].reverse().find(item => item.onEscape)?.onEscape;
      if (handler) { handler(); update(); }
    }
    if (event.type === "closeRequest") {
      const handler = compiled.handlers.get(compiled.document.root.id)?.onCloseRequest;
      if (!handler) {
        bridge.send({ type: "close" });
      } else {
        let defaultPrevented = false;
        const request = {
          get defaultPrevented(): boolean { return defaultPrevented; },
          preventDefault(): void { defaultPrevented = true; },
        };
        try {
          handler(request);
        } catch (error) {
          bridge.send({ type: "cancelCloseRequest" });
          throw error;
        }
        update();
        bridge.send(defaultPrevented ? { type: "cancelCloseRequest" } : { type: "close" });
      }
    }
    if (event.type === "shortcut") {
      const handlers = hotkeys.get(event.shortcut);
      if (handlers) {
        for (const handler of [...handlers]) handler();
        update();
      }
    }
    if ("requestId" in event) {
      const item = pending.get(event.requestId);
      if (item) { if (item.timer) clearTimeout(item.timer); pending.delete(event.requestId); item.resolve(event); }
    }
    if ("id" in event) {
      const handlers = compiled.handlers.get(event.id);
      if (event.type === "change") {
        const node = compiled.nodes.get(event.id);
        if (node && (node.kind === "input" || node.kind === "textarea")) node.value = event.value;
      }
      if (event.type === "valueChange") {
        const node = compiled.nodes.get(event.id);
        if (node?.control) node.control = { ...node.control, value: event.value };
      }
      if (event.type === "click" && handlers?.onClick) { handlers.onClick(); update(); }
      if (event.type === "context" && handlers?.onContextMenu) { handlers.onContextMenu({ x: event.x, y: event.y }); update(); }
      if (event.type === "outside" && handlers?.onOutsideClick) { handlers.onOutsideClick(); update(); }
      if (event.type === "change" && handlers?.onChange) { handlers.onChange(event.value); update(); }
      if (event.type === "valueChange" && handlers?.onValueChange) { handlers.onValueChange(event.value); update(); }
      if (event.type === "scroll" && handlers?.onScroll) { handlers.onScroll(event.offset, event.max); update(); }
      if (event.type === "hover" && handlers?.onHover) { handlers.onHover(event.entered); update(); }
      if (event.type === "key" && handlers?.onKeyDown) { handlers.onKeyDown(event.key); update(); }
      if (event.type === "blur" && handlers?.onBlur) { handlers.onBlur(); update(); }
    }
    for (const listener of listeners) listener(event);
  });
  return {
    ready, closed, update,
    close(): void { if (!ended) bridge.send({ type: "close" }); },
    focus(id: string): void { if (!ended) bridge.send({ type: "focus", id }); },
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
    onEvent(listener: (event: NativeEvent) => void): () => void { listeners.add(listener); return () => { listeners.delete(listener); }; },
    async inspect(): Promise<Snapshot> {
      const event = await request({ type: "inspect", requestId: crypto.randomUUID() });
      if (event.type !== "inspect") throw new Error("Unexpected native response");
      return event.snapshot;
    },
    async capture(path: string): Promise<void> {
      if (!options.debug) throw new Error("Enable debug to capture the rendered scene");
      await request({ type: "capture", path, requestId: crypto.randomUUID() });
    },
    debug(command: DiagnosticInput): void {
      if (!options.debug) throw new Error("Enable debug to use diagnostic input/resize");
      bridge.send(command);
    },
  };
}
export async function render(view: () => VNode, options?: AppOptions): Promise<void> {
  const app = createApp(view, options);
  await app.ready;
  await app.closed;
}
