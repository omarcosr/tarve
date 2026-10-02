import type { NativeCommand, NativeEvent, NativeImageSource, SceneDocument } from "../../../../packages/protocol/src/index";
import type { NativeBridge } from "../../../../packages/core/src/bridge";
import type { WebTree } from "./wasm/tarve_web.js";

type WebTreeConstructor = new (document: string) => WebTree;

/** Same names the desktop runtime sends to `Tree::key`. */
function namedKey(event: KeyboardEvent): string | undefined {
  const word = event.ctrlKey || event.altKey;
  const mod = event.ctrlKey || event.metaKey;
  const shift = event.shiftKey;
  switch (event.key) {
    case "Tab":
      return shift ? "ShiftTab" : "Tab";
    case "Enter":
      return mod ? "ModEnter" : shift ? "ShiftEnter" : "Enter";
    case " ":
      return "Space";
    case "Backspace":
      return word ? "WordBackspace" : "Backspace";
    case "Delete":
      return word ? "WordDelete" : "Delete";
    case "ArrowLeft":
      return word ? (shift ? "ShiftWordLeft" : "WordLeft") : shift ? "ShiftArrowLeft" : "ArrowLeft";
    case "ArrowRight":
      return word ? (shift ? "ShiftWordRight" : "WordRight") : shift ? "ShiftArrowRight" : "ArrowRight";
    case "ArrowUp":
      return shift ? "ShiftArrowUp" : "ArrowUp";
    case "ArrowDown":
      return shift ? "ShiftArrowDown" : "ArrowDown";
    case "Home":
      return shift ? "ShiftHome" : "Home";
    case "End":
      return shift ? "ShiftEnd" : "End";
    case "PageUp":
    case "PageDown":
    case "Escape":
      return event.key;
  }
  const letter = event.key.toLowerCase();
  if (mod && letter === "a") return "SelectAll";
  if (mod && letter === "z") return shift ? "Redo" : "Undo";
  if (mod && letter === "y") return "Redo";
  return undefined;
}

const imageCache = new Map<string, Promise<NativeImageSource | undefined>>();

function imageUrl(src: string): string | undefined {
  if (src.startsWith("data:")) return undefined;
  return new URL(src, location.origin + "/").href;
}

function loadImage(url: string): Promise<NativeImageSource | undefined> {
  let pending = imageCache.get(url);
  if (!pending) {
    pending = fetch(url)
      .then(async (response) => {
        if (!response.ok) return undefined;
        const bytes = new Uint8Array(await response.arrayBuffer());
        let binary = "";
        for (let index = 0; index < bytes.length; index += 0x8000) {
          binary += String.fromCharCode(...bytes.subarray(index, index + 0x8000));
        }
        const source: NativeImageSource = {
          kind: "encoded",
          key: url,
          data: btoa(binary),
          mediaType: response.headers.get("content-type") ?? undefined,
        };
        return source;
      })
      .catch(() => undefined);
    imageCache.set(url, pending);
  }
  return pending;
}

const loadedImages = new Map<string, NativeImageSource>();

/** Visits every native node in a document or command. */
function eachNode(value: unknown, visit: (node: { src?: string; image?: NativeImageSource }) => void): void {
  if (Array.isArray(value)) {
    for (const item of value) eachNode(item, visit);
  } else if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    if (typeof record.kind === "string" && typeof record.id === "string") visit(record as { src?: string });
    for (const key in record) if (key !== "style") eachNode(record[key], visit);
  }
}

/**
 * The desktop runtime reads `Image` paths from disk; in the browser they are URLs. Image
 * paths are fetched once and inlined as encoded bytes before the tree sees them.
 */
async function preloadImages(value: unknown): Promise<void> {
  const urls = new Set<string>();
  eachNode(value, (node) => {
    const url = node.src && !node.image ? imageUrl(node.src) : undefined;
    if (url && !loadedImages.has(url)) urls.add(url);
  });
  await Promise.all(
    [...urls].map(async (url) => {
      const source = await loadImage(url);
      if (source) loadedImages.set(url, source);
    }),
  );
}

function inlineImages(value: unknown): void {
  eachNode(value, (node) => {
    const url = node.src && !node.image ? imageUrl(node.src) : undefined;
    const source = url ? loadedImages.get(url) : undefined;
    if (source) {
      node.image = source;
      delete node.src;
    }
  });
}

/**
 * A `NativeBridge` that runs Tarve's native tree (compiled to WebAssembly) inside a canvas.
 * Commands from `createApp` go to the tree; pointer and keyboard input come from the canvas;
 * frames are painted only when the tree reports a change, like the desktop runtime.
 */
export class CanvasBridge implements NativeBridge {
  private tree?: WebTree;
  private onEvent?: (event: NativeEvent) => void;
  private readonly context: CanvasRenderingContext2D;
  private frameRequest = 0;
  private tickTimer: ReturnType<typeof setTimeout> | undefined;
  private ready = false;
  private disposed = false;
  private readonly cleanup: (() => void)[] = [];

  /** Paint timings, readable from devtools as `canvas.tarveStats`. */
  readonly stats = { frames: 0, totalMs: 0, maxMs: 0, lastMs: 0, events: [] as string[] };

  constructor(
    private readonly canvas: HTMLCanvasElement,
    private readonly Tree: WebTreeConstructor,
    private readonly memory: WebAssembly.Memory,
  ) {
    (canvas as HTMLCanvasElement & { tarveStats?: CanvasBridge["stats"] }).tarveStats = this.stats;
    const context = canvas.getContext("2d", { alpha: false });
    if (!context) throw new Error("Canvas 2D context is not available");
    this.context = context;
  }

  private queued: NativeCommand[] | undefined = [];

  start(document: SceneDocument, onEvent: (event: NativeEvent) => void): void {
    this.onEvent = onEvent;
    void preloadImages(document).then(() => {
      if (this.disposed) return;
      inlineImages(document);
      try {
        this.tree = new this.Tree(JSON.stringify(document));
      } catch (error) {
        onEvent({ type: "error", message: error instanceof Error ? error.message : String(error) });
        return;
      }
      const queued = this.queued ?? [];
      this.queued = undefined;
      this.resize();
      this.listen();
      for (const command of queued) this.send(command);
      this.schedule();
    });
  }

  send(command: NativeCommand): void {
    if (this.queued) {
      if (command.type === "close") {
        this.dispose();
        this.onEvent?.({ type: "closed" });
      } else {
        this.queued.push(command);
      }
      return;
    }
    if (!this.tree || this.disposed) return;
    inlineImages(command);
    if (command.type === "close") {
      this.dispose();
      this.onEvent?.({ type: "closed" });
      return;
    }
    try {
      // An idle tree's clock stops at its last frame; motion a patch starts must begin now.
      this.tree.advanceClock(performance.now());
      this.tree.command(JSON.stringify(command));
    } catch (error) {
      this.onEvent?.({ type: "error", message: error instanceof Error ? error.message : String(error) });
    }
    this.flush();
    this.schedule();
  }

  join(): void {}

  /** Device pixel ratio cap; lowered when this machine cannot paint a frame in budget. */
  private maxScale = 2;
  private slowFrames = 0;

  private resize(): void {
    const rect = this.canvas.getBoundingClientRect();
    const scale = Math.min(window.devicePixelRatio || 1, this.maxScale);
    this.tree?.resize(Math.max(1, rect.width), Math.max(1, rect.height), scale);
    this.schedule();
  }

  /** Keeps interaction smooth on slow machines: three frames over budget drop the resolution a step. */
  private adapt(elapsed: number): void {
    this.slowFrames = elapsed > 12 ? this.slowFrames + 1 : 0;
    if (this.slowFrames < 3 || this.maxScale <= 1) return;
    this.slowFrames = 0;
    this.maxScale = Math.max(1, Math.min(this.maxScale, window.devicePixelRatio || 1) - 0.5);
    this.resize();
  }

  private schedule(): void {
    if (this.frameRequest || this.disposed) return;
    this.frameRequest = requestAnimationFrame(() => {
      this.frameRequest = 0;
      this.paint();
    });
  }

  private paint(): void {
    const tree = this.tree;
    if (!tree || this.disposed) return;
    const now = performance.now();
    let changed = false;
    try {
      changed = tree.frame(now);
    } catch (error) {
      this.onEvent?.({ type: "error", message: error instanceof Error ? error.message : String(error) });
    }
    if (changed) {
      const width = tree.deviceWidth();
      const height = tree.deviceHeight();
      if (this.canvas.width !== width) this.canvas.width = width;
      if (this.canvas.height !== height) this.canvas.height = height;
      // A view straight into wasm memory: the frame is copied once, by putImageData.
      const pixels = new Uint8ClampedArray(this.memory.buffer, tree.pixelsPtr(), tree.pixelsLen());
      this.context.putImageData(new ImageData(pixels, width, height), 0, 0);
      const elapsed = performance.now() - now;
      this.stats.frames += 1;
      this.stats.totalMs += elapsed;
      this.stats.lastMs = elapsed;
      this.stats.maxMs = Math.max(this.stats.maxMs, elapsed);
      this.adapt(elapsed);
    }
    if (!this.ready) {
      this.ready = true;
      this.onEvent?.({ type: "ready" });
    }
    this.flush();
    clearTimeout(this.tickTimer);
    const next = tree.nextTickMs();
    if (next >= 0) this.tickTimer = setTimeout(() => this.schedule(), Math.max(0, next - performance.now()));
  }

  /** Delivers queued tree events to `createApp`, whose handlers may send new commands. */
  private flush(): void {
    const tree = this.tree;
    if (!tree || this.disposed) return;
    const events = JSON.parse(tree.takeEvents()) as NativeEvent[];
    for (const event of events) {
      // Title bar buttons act on the desktop window; here the page decides what they mean.
      const action = event.type === "click" ? tree.windowAction(event.id) : undefined;
      if (action) this.canvas.dispatchEvent(new CustomEvent("tarve:windowaction", { detail: action }));
      this.stats.events.push(event.type + ("id" in event ? `:${event.id}` : ""));
      if (this.stats.events.length > 30) this.stats.events.shift();
      this.onEvent?.(event);
    }
    if (events.length) this.schedule();
  }

  private input(action: (tree: WebTree) => void): void {
    if (!this.tree || this.disposed) return;
    action(this.tree);
    this.canvas.style.cursor = this.tree.cursor();
    this.flush();
    this.schedule();
  }

  private point(event: PointerEvent | WheelEvent): [number, number] {
    const rect = this.canvas.getBoundingClientRect();
    return [event.clientX - rect.left, event.clientY - rect.top];
  }

  private listen(): void {
    const canvas = this.canvas;
    const on = <K extends keyof HTMLElementEventMap>(
      target: HTMLElement | Document,
      type: K,
      handler: (event: HTMLElementEventMap[K]) => void,
      options?: AddEventListenerOptions,
    ) => {
      target.addEventListener(type, handler as EventListener, options);
      this.cleanup.push(() => target.removeEventListener(type, handler as EventListener, options));
    };
    on(canvas, "pointermove", (event) => this.input((tree) => tree.pointerMove(...this.point(event))));
    on(canvas, "pointerleave", () => this.input((tree) => tree.pointerLeave()));
    on(canvas, "pointerdown", (event) => {
      canvas.focus({ preventScroll: true });
      canvas.setPointerCapture(event.pointerId);
      this.input((tree) => {
        tree.pointerMove(...this.point(event));
        if (event.button === 2) tree.pointerContext();
        else if (event.button === 0) tree.pointerDown();
      });
    });
    on(canvas, "pointerup", (event) => {
      if (event.button !== 0) return;
      this.input((tree) => {
        tree.pointerMove(...this.point(event));
        tree.pointerUp();
      });
    });
    on(canvas, "contextmenu", (event) => event.preventDefault());
    on(
      canvas,
      "wheel",
      (event) => {
        const unit = event.deltaMode === 1 ? 36 : event.deltaMode === 2 ? canvas.clientHeight : 1;
        let consumed = false;
        this.input((tree) => {
          tree.pointerMove(...this.point(event));
          tree.wheel(event.deltaX * unit, event.deltaY * unit);
          const pending = tree.takeEvents();
          consumed = pending !== "[]";
          for (const nativeEvent of JSON.parse(pending) as NativeEvent[]) this.onEvent?.(nativeEvent);
        });
        if (consumed) event.preventDefault();
      },
      { passive: false },
    );
    on(canvas, "keydown", (event) => {
      const tree = this.tree;
      if (!tree) return;
      const mod = event.ctrlKey || event.metaKey;
      const letter = event.key.toLowerCase();
      if (mod && (letter === "c" || letter === "x")) {
        const text = tree.selectedText();
        if (text) void navigator.clipboard?.writeText(text);
        if (letter === "x" && text) this.input((current) => current.key("Backspace"));
        event.preventDefault();
        return;
      }
      if (mod && letter === "v") return;
      const name = namedKey(event);
      let handled = false;
      this.input((current) => {
        if (name) handled = current.key(name);
        if (!mod && !event.altKey && (name === undefined || name === "Space") && event.key.length === 1) {
          current.typeText(event.key);
          handled = true;
        }
      });
      if (handled || name === "Space" || (name !== undefined && name !== "Tab" && name !== "ShiftTab")) event.preventDefault();
    });
    on(document, "paste", (event) => {
      if (document.activeElement !== canvas) return;
      const text = (event as ClipboardEvent).clipboardData?.getData("text/plain");
      if (!text) return;
      event.preventDefault();
      this.input((tree) => tree.typeText(text));
    });
    on(canvas, "blur", () => this.input((tree) => tree.blur()));
    const observer = new ResizeObserver(() => this.resize());
    observer.observe(canvas);
    this.cleanup.push(() => observer.disconnect());
  }

  private dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    cancelAnimationFrame(this.frameRequest);
    clearTimeout(this.tickTimer);
    for (const remove of this.cleanup.splice(0)) remove();
    this.tree?.free();
    this.tree = undefined;
  }
}
