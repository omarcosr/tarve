import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, extname, isAbsolute, resolve } from "node:path";
import type { NativeBridge, RgbaImage } from "@tarve/core";
import { encodePng } from "./png";
import { headlessRuntime, type WebTreeHandle } from "./runtime";

type SceneDocument = Parameters<NativeBridge["start"]>[0];
type NativeEvent = Parameters<Parameters<NativeBridge["start"]>[1]>[0];
type NativeCommand = Parameters<NativeBridge["send"]>[0];

export interface HeadlessBridgeOptions {
  /** Logical size of the render target. Defaults to the Window's width and height. */
  width?: number;
  height?: number;
  /** Device pixel ratio of captures. Default 1. */
  scale?: number;
  /**
   * `manual` (default): time stands still and only `advanceMotion` moves it, so transitions,
   * spinners and the caret are frozen and every capture is reproducible.
   * `realtime`: the clock follows `performance.now()`, as in a window.
   */
  clock?: "manual" | "realtime";
  /** Directory relative `Image` paths (and web-style `/…` paths) are read from. Default `process.cwd()`. */
  assetRoot?: string;
}

const MEDIA: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".gif": "image/gif",
  ".svg": "image/svg+xml",
};

/**
 * A `NativeBridge` over the WebAssembly build of Tarve's native tree: the same layout, text,
 * input and CPU painter as a window, with no window, GPU or native library. Pass it to
 * `createApp({ bridge })`; `inspect`, `debug` input, `advanceMotion` and `capture` all work.
 */
export class HeadlessBridge implements NativeBridge {
  private tree?: WebTreeHandle;
  private onEvent?: (event: NativeEvent) => void;
  private flushQueued = false;
  private tickTimer?: ReturnType<typeof setTimeout>;
  private readonly epoch = performance.now();
  private closed = false;
  /** Bumped by every command and every delivered event, so `settle` can tell when work stops. */
  private activity = 0;

  constructor(private readonly options: HeadlessBridgeOptions = {}) {}

  start(document: SceneDocument, onEvent: (event: NativeEvent) => void): void {
    this.onEvent = onEvent;
    this.inlineImages(document);
    const { WebTree } = headlessRuntime();
    this.tree = new WebTree(JSON.stringify(document));
    this.tree.resize(
      this.options.width ?? document.window.width,
      this.options.height ?? document.window.height,
      this.options.scale ?? 1,
    );
    queueMicrotask(() => {
      this.flush();
      this.onEvent?.({ type: "ready" });
    });
  }

  send(command: NativeCommand): void {
    if (this.closed || !this.tree) return;
    this.activity++;
    switch (command.type) {
      case "close":
        this.dispose();
        queueMicrotask(() => this.onEvent?.({ type: "closed" }));
        return;
      case "cancelCloseRequest":
        return;
      case "capture":
        this.captureTo(command.path, command.requestId);
        return;
      case "fileDialog":
        this.emitSoon({ type: "fileDialog", requestId: command.requestId, paths: [], error: "File dialogs are not available headless" });
        return;
    }
    this.inlineImages(command);
    try {
      this.tree.command(JSON.stringify(command));
    } catch (error) {
      this.emitSoon({ type: "error", message: error instanceof Error ? error.message : String(error) });
    }
    this.queueFlush();
  }

  join(): void {}

  /** Lays out, paints if needed and returns the current frame. */
  pixels(): RgbaImage {
    const tree = this.requireTree();
    this.flush();
    const { memory } = headlessRuntime();
    return {
      width: tree.deviceWidth(),
      height: tree.deviceHeight(),
      rgba: new Uint8Array(memory.buffer, tree.pixelsPtr(), tree.pixelsLen()).slice(),
    };
  }

  /** The current frame as PNG bytes. */
  png(): Uint8Array {
    const image = this.pixels();
    return encodePng(image.rgba, image.width, image.height);
  }

  /**
   * Resolves once the app stops reacting: no commands and no events for a few turns of the event
   * loop. Layout feedback (virtual lists, scroll positions) and the re-renders it triggers are
   * done by then.
   */
  async settle(maxTurns = 100): Promise<void> {
    let quiet = 0;
    for (let turn = 0; turn < maxTurns && quiet < 3; turn++) {
      const before = this.activity;
      await new Promise((resolve) => setTimeout(resolve, 0));
      this.flush();
      quiet = this.activity === before ? quiet + 1 : 0;
    }
  }

  private now(): number {
    return this.options.clock === "realtime" ? performance.now() - this.epoch : 0;
  }

  private requireTree(): WebTreeHandle {
    if (!this.tree) throw new Error(this.closed ? "The headless app is closed" : "The headless app has not started");
    return this.tree;
  }

  private queueFlush(): void {
    if (this.flushQueued) return;
    this.flushQueued = true;
    queueMicrotask(() => this.flush());
  }

  /** Steps the clock, lays out, paints, and delivers whatever the tree emitted. */
  private flush(): void {
    this.flushQueued = false;
    const tree = this.tree;
    if (!tree || this.closed) return;
    try {
      tree.frame(this.now());
    } catch (error) {
      this.onEvent?.({ type: "error", message: error instanceof Error ? error.message : String(error) });
    }
    const events = JSON.parse(tree.takeEvents()) as NativeEvent[];
    if (events.length > 0) this.activity++;
    for (const event of events) {
      if (this.closed) break;
      this.onEvent?.(event);
    }
    if (this.options.clock === "realtime") this.scheduleTick();
  }

  private scheduleTick(): void {
    clearTimeout(this.tickTimer);
    const next = this.tree?.nextTickMs() ?? -1;
    if (next < 0) return;
    this.tickTimer = setTimeout(() => this.flush(), Math.max(0, next - this.now()));
    (this.tickTimer as { unref?: () => void }).unref?.();
  }

  private emitSoon(event: NativeEvent): void {
    queueMicrotask(() => {
      if (!this.closed) this.onEvent?.(event);
    });
  }

  private captureTo(path: string, requestId: string): void {
    try {
      const png = this.png();
      mkdirSync(dirname(resolve(path)), { recursive: true });
      writeFileSync(path, png);
      this.emitSoon({ type: "captured", requestId, path });
    } catch (error) {
      this.emitSoon({ type: "captured", requestId, path, error: error instanceof Error ? error.message : String(error) });
    }
  }

  private dispose(): void {
    this.closed = true;
    clearTimeout(this.tickTimer);
    this.tree?.free();
    this.tree = undefined;
  }

  /** The wasm tree cannot open files: `Image` sources that are paths are read here and inlined. */
  private inlineImages(value: unknown): void {
    if (Array.isArray(value)) {
      for (const item of value) this.inlineImages(item);
      return;
    }
    if (!value || typeof value !== "object") return;
    const node = value as Record<string, unknown> & { src?: unknown; image?: unknown };
    if (typeof node.kind === "string" && typeof node.id === "string" && typeof node.src === "string" && !node.image) {
      const src = node.src;
      // A single letter before ":" is a Windows drive, not a URL scheme.
      if (!/^[a-z][a-z0-9+.-]+:/i.test(src) || src.startsWith("file:")) {
        const path = src.startsWith("file:") ? new URL(src).pathname : src;
        const root = this.options.assetRoot ?? process.cwd();
        // "/assets/a.png" is a real absolute path, or, as on the web, rooted at assetRoot.
        const file = [isAbsolute(path) ? path : resolve(root, path), resolve(root, path.replace(/^[\\/]+/, ""))].find((candidate) => existsSync(candidate));
        if (file) {
          node.image = { kind: "encoded", key: src, data: readFileSync(file).toString("base64"), mediaType: MEDIA[extname(file).toLowerCase()] };
          delete node.src;
        }
      }
    }
    for (const key in node) if (key !== "style") this.inlineImages(node[key]);
  }
}
