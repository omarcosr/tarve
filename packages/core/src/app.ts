import type { NativeEvent, NativeCommand, Snapshot } from "../../protocol/src/index";
import { BunFfiBridge, type NativeBridge } from "./bridge";
import { compileTree, diffTrees } from "./reconciler";
import type { VNode } from "./jsx-runtime";

export interface AppOptions { debug?: boolean; bridge?: NativeBridge; onError?: (error: Error) => void }
export type DiagnosticInput = Extract<NativeCommand, { type: "input" | "resize" }>;
export interface AppHandle {
  ready: Promise<void>; closed: Promise<void>;
  update(): void; close(): void; focus(id: string): void;
  onEvent(listener: (event: NativeEvent) => void): () => void;
  inspect(): Promise<Snapshot>; capture(path: string): Promise<void>;
  debug(command: DiagnosticInput): void;
}
export function createApp(view: () => VNode, options: AppOptions = {}): AppHandle {
  const bridge = options.bridge ?? new BunFfiBridge();
  let compiled = compileTree(view(), options.debug);
  let queued = false;
  let ended = false;
  let started = false;
  const listeners = new Set<(event: NativeEvent) => void>();
  const pending = new Map<string, { resolve: (event: NativeEvent) => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout> }>();
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
      const nodes = diffTrees(compiled, next);
      compiled = next;
      if (nodes === null) bridge.send({ type: "update", root: compiled.document.root });
      else if (nodes.length > 0) bridge.send({ type: "patch", nodes });
    });
  }
  function request(command: NativeCommand & { requestId: string }): Promise<NativeEvent> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { pending.delete(command.requestId); reject(new Error(`Native request timed out: ${command.type}`)); }, 10_000);
      pending.set(command.requestId, { resolve, reject, timer });
      try { bridge.send(command); } catch (error) { clearTimeout(timer); pending.delete(command.requestId); reject(error); }
    });
  }
  bridge.start(compiled.document, (event) => {
    if (event.type === "ready") { started = true; resolveReady(); }
    if (event.type === "closed") {
      ended = true;
      bridge.join();
      if (!started) rejectReady(new Error("Native window closed before becoming ready"));
      for (const item of pending.values()) { clearTimeout(item.timer); item.reject(new Error("Native window closed")); }
      pending.clear();
      resolveClosed();
    }
    if (event.type === "error") {
      const error = new Error(event.message);
      if (!started) rejectReady(error);
      if (options.onError) options.onError(error); else console.error(`[tarve] ${error.message}`);
    }
    if ("requestId" in event) {
      const item = pending.get(event.requestId);
      if (item) { clearTimeout(item.timer); pending.delete(event.requestId); item.resolve(event); }
    }
    if ("id" in event) {
      const handlers = compiled.handlers.get(event.id);
      if (event.type === "click") { handlers?.onClick?.(); update(); }
      if (event.type === "change") { handlers?.onChange?.(event.value); update(); }
      if (event.type === "valueChange") { handlers?.onValueChange?.(event.value); update(); }
      if (event.type === "hover") handlers?.onHover?.(event.entered);
    }
    for (const listener of listeners) listener(event);
  });
  return {
    ready, closed, update,
    close(): void { if (!ended) bridge.send({ type: "close" }); },
    focus(id: string): void { if (!ended) bridge.send({ type: "focus", id }); },
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
