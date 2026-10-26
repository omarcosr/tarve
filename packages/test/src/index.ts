import { Window, type AppOptions, type PixelComparison, type RgbaImage, type ThemeDefinition, type VNode } from "@tarve/core";
import { jsx } from "@tarve/core/jsx-runtime";
import {
  createHeadlessApp,
  matchImageSnapshot,
  type HeadlessApp,
  type HeadlessBridge,
  type HeadlessBridgeOptions,
  type HeadlessRuntimeOptions,
  type ImageSnapshotOptions,
  type SceneNode,
} from "@tarve/headless";
import { TestElement, type ElementHost } from "./element";
import { bindQueries, type Queries, type WaitForOptions } from "./queries";

export { TestElement, roleOf, type Role } from "./element";
export type { Matcher, MatcherOptions, Queries, RoleOptions, WaitForOptions } from "./queries";
export type { SceneNode } from "@tarve/headless";

type NativeEvent = Parameters<HeadlessBridge["emit"]>[0];
type NodeBox = Awaited<ReturnType<HeadlessApp["inspect"]>>["nodes"][number];

export interface RenderOptions extends Omit<AppOptions, "bridge" | "debug" | "headless">, HeadlessBridgeOptions, HeadlessRuntimeOptions {
  /** Theme of the Window wrapped around a view that is not a Window. */
  theme?: ThemeDefinition;
}

/** Where an event goes: an element, or a node id in the render. */
export type Target = TestElement | string;

export interface ClickOptions {
  /**
   * `pointer` (default): move, press and release at the element's centre, through native hit
   * testing, like a user (a disabled or covered element does not get the click). `event`:
   * deliver a `click` event for the node straight to the app's handler dispatch.
   */
  via?: "pointer" | "event";
}

export interface TypeOptions {
  /** Select everything and delete it first. */
  clear?: boolean;
}

export interface ScrollOptions {
  delta?: number;
  deltaX?: number;
  deltaY?: number;
}

/** Input for one render. Every call waits until the app has re-rendered (`settle`). */
export interface FireEvent {
  click(target: Target, options?: ClickOptions): Promise<void>;
  /** Moves the pointer over the element's centre. */
  hover(target: Target): Promise<void>;
  /** Focuses the element and types `text`. `{Enter}`, `{Tab}`, `{Backspace}`… inside it press keys. */
  type(target: Target, text: string, options?: TypeOptions): Promise<void>;
  /** Selects everything in a field and deletes it. */
  clear(target: Target): Promise<void>;
  /** Presses a key (`Enter`, `Escape`, `Tab`, `ArrowDown`, `Backspace`, `SelectAll`…), on `target` when given (it gets focus). */
  key(key: string, target?: Target): Promise<void>;
  /** Wheels over the element's centre: a number is the vertical delta in pixels. */
  scroll(target: Target, options: number | ScrollOptions): Promise<void>;
  /** Delivers a native event to the app as the native tree would (`{ type: "change", id, value }`…). */
  native(event: NativeEvent): Promise<void>;
}

export interface RenderResult extends Queries {
  readonly app: HeadlessApp;
  /** The root element: the Window. */
  readonly container: TestElement;
  readonly fireEvent: FireEvent;
  /** The compiled scene tree as the app last sent it (no layout). */
  scene(): SceneNode;
  /** The element with this node id, or undefined. */
  element(id: string): TestElement | undefined;
  /** Every element in document order. */
  elements(): TestElement[];
  /** The tree as indented text, as printed under a failed query. */
  debug(): string;
  /** Renders again: the same view, or `ui` in its place. Component state in your own variables stays. */
  rerender(ui?: VNode | (() => VNode)): Promise<void>;
  /** Closes the app. `cleanup()` unmounts every render still open. */
  unmount(): void;
  /** Waits until layout feedback and re-renders stop. */
  settle(): Promise<void>;
  /** Layout box of an element from the native tree, or undefined when it is not laid out. */
  box(target: Target): Promise<NodeBox | undefined>;
  /** The current frame as PNG bytes. */
  snapshot(): Uint8Array;
  /** The current frame as RGBA pixels. */
  pixels(): RgbaImage;
  /** Advances the manual motion clock (transitions, spinners) and settles. */
  advance(milliseconds: number): Promise<void>;
}

const mounted = new Set<RenderResult>();
const owners = new WeakMap<TestElement, RenderResult>();

function asView(ui: VNode | (() => VNode)): () => VNode {
  return typeof ui === "function" ? ui : () => ui;
}

interface Indexed {
  version: number;
  nodes: Map<string, SceneNode>;
  parents: Map<string, string | undefined>;
  children: Map<string, string[]>;
  order: string[];
}

function indexScene(root: SceneNode | undefined, version: number): Indexed {
  const index: Indexed = { version, nodes: new Map(), parents: new Map(), children: new Map(), order: [] };
  const walk = (node: SceneNode, parent: string | undefined) => {
    index.nodes.set(node.id, node);
    index.parents.set(node.id, parent);
    index.children.set(node.id, node.children.map((child) => child.id));
    index.order.push(node.id);
    for (const child of node.children) walk(child, node.id);
  };
  if (root) walk(root, undefined);
  return index;
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Retries `callback` until it stops throwing (and settles every open render before each try), then
 * returns its value. Throws its last error after `timeout` ms.
 */
export async function waitFor<T>(callback: () => T | Promise<T>, options: WaitForOptions = {}): Promise<T> {
  const timeout = options.timeout ?? 1000;
  const interval = options.interval ?? 10;
  const deadline = performance.now() + timeout;
  for (;;) {
    await Promise.all([...mounted].map((result) => result.settle()));
    try {
      return await callback();
    } catch (error) {
      if (performance.now() >= deadline) {
        if (error instanceof Error) error.message = `waitFor timed out after ${timeout}ms: ${error.message}`;
        throw error;
      }
    }
    await sleep(interval);
  }
}

/** Waits until `callback` throws or returns `null`/`undefined`/`false`/an empty array: the element went away. */
export async function waitForElementToBeRemoved(callback: () => unknown, options?: WaitForOptions): Promise<void> {
  await waitFor(() => {
    let value: unknown;
    try {
      value = callback();
    } catch {
      return;
    }
    if (value instanceof TestElement && !value.isConnected) return;
    if (value === null || value === undefined || value === false || (Array.isArray(value) && value.length === 0)) return;
    throw new Error(`Still present: ${String(value)}`);
  }, options);
}

const KEY_TOKEN = /\{([^{}]+)\}/g;

/**
 * Renders `ui` on the headless WebAssembly runtime (no window, no GPU) and returns queries over
 * its compiled scene tree, input that goes through the same native event dispatch as a window,
 * and pixel snapshots. A view that is not a `Window` is wrapped in one (640×480 by default).
 */
export async function render(ui: VNode | (() => VNode), options: RenderOptions = {}): Promise<RenderResult> {
  const { theme, ...appOptions } = options;
  let view = asView(ui);
  const root = () => {
    const node = view();
    if (node.type === Window) return node;
    return jsx(Window, { width: options.width ?? 640, height: options.height ?? 480, ...(theme ? { theme } : {}), children: node });
  };
  const app = await createHeadlessApp(root, appOptions);
  const bridge = app.bridge;
  let index = indexScene(bridge.scene(), bridge.sceneVersion);
  let closed = false;
  const elementCache = new Map<string, TestElement>();

  const current = (): Indexed => {
    if (index.version !== bridge.sceneVersion) index = indexScene(bridge.scene(), bridge.sceneVersion);
    return index;
  };
  const host: ElementHost = {
    node: (id) => current().nodes.get(id),
    parentId: (id) => current().parents.get(id),
    childIds: (id) => current().children.get(id) ?? [],
    element: (id) => {
      let element = elementCache.get(id);
      if (!element) {
        elementCache.set(id, (element = new TestElement(host, id)));
        owners.set(element, result);
      }
      return element;
    },
  };
  const elements = () => current().order.map((id) => host.element(id));
  const debug = () => printTree(elements()[0]);
  const settle = async () => {
    if (!closed) await app.settle();
  };
  const resolve = (target: Target): TestElement => {
    if (typeof target !== "string") return target;
    if (!current().nodes.has(target)) throw new Error(`No node with id ${JSON.stringify(target)}\n\n${debug()}`);
    return host.element(target);
  };
  const box = async (target: Target) => {
    const id = resolve(target).id;
    return (await app.inspect()).nodes.find((node) => node.id === id);
  };
  const centre = async (target: Target) => {
    const found = await box(target);
    if (!found || found.width <= 0 || found.height <= 0) return undefined;
    return { x: found.x + found.width / 2, y: found.y + found.height / 2 };
  };
  const input = (command: Parameters<HeadlessApp["debug"]>[0]) => app.debug(command);
  const typeText = (text: string) => {
    let last = 0;
    for (const match of text.matchAll(KEY_TOKEN)) {
      if (match.index > last) input({ type: "input", action: "text", text: text.slice(last, match.index) });
      input({ type: "input", action: "key", text: match[1]! });
      last = match.index + match[0].length;
    }
    if (last < text.length) input({ type: "input", action: "text", text: text.slice(last) });
  };

  const fireEvent: FireEvent = {
    async click(target, clickOptions = {}) {
      const element = resolve(target);
      const point = clickOptions.via === "event" ? undefined : await centre(element);
      if (point) {
        input({ type: "input", action: "move", ...point });
        input({ type: "input", action: "down" });
        input({ type: "input", action: "up" });
      } else {
        if (clickOptions.via !== "event" && element.disabled) throw new Error(`${element} is disabled and not laid out`);
        bridge.emit({ type: "click", id: element.id });
      }
      await settle();
    },
    async hover(target) {
      const point = await centre(target);
      if (!point) throw new Error(`${resolve(target)} is not laid out: nothing to hover`);
      input({ type: "input", action: "move", ...point });
      await settle();
    },
    async type(target, text, typeOptions = {}) {
      const element = resolve(target);
      app.focus(element.id);
      if (typeOptions.clear) {
        input({ type: "input", action: "key", text: "SelectAll" });
        input({ type: "input", action: "key", text: "Backspace" });
      }
      typeText(text);
      await settle();
    },
    async clear(target) {
      app.focus(resolve(target).id);
      input({ type: "input", action: "key", text: "SelectAll" });
      input({ type: "input", action: "key", text: "Backspace" });
      await settle();
    },
    async key(key, target) {
      if (!key) throw new TypeError("fireEvent.key needs a key");
      if (target !== undefined) app.focus(resolve(target).id);
      input({ type: "input", action: "key", text: key });
      await settle();
    },
    async scroll(target, scrollOptions) {
      const point = await centre(target);
      if (!point) throw new Error(`${resolve(target)} is not laid out: nothing to scroll`);
      const wheel = typeof scrollOptions === "number" ? { deltaY: scrollOptions } : scrollOptions;
      input({ type: "input", action: "move", ...point });
      input({ type: "input", action: "wheel", ...wheel });
      await settle();
    },
    async native(event) {
      bridge.emit(event);
      await settle();
    },
  };

  const queries = bindQueries({ elements, debug, waitFor });
  const result: RenderResult = {
    ...queries,
    app,
    get container() {
      return host.element(current().order[0]!);
    },
    fireEvent,
    scene: () => {
      const scene = bridge.scene();
      if (!scene) throw new Error("The app has not rendered");
      return scene;
    },
    element: (id) => (current().nodes.has(id) ? host.element(id) : undefined),
    elements,
    debug,
    async rerender(next) {
      if (next !== undefined) view = asView(next);
      app.update();
      app.flush();
      await settle();
    },
    unmount() {
      if (closed) return;
      closed = true;
      mounted.delete(result);
      app.close();
    },
    settle,
    box,
    snapshot: () => app.png(),
    pixels: () => app.pixels(),
    async advance(milliseconds) {
      await app.advanceMotion(milliseconds);
      await settle();
    },
  };
  mounted.add(result);
  return result;
}

/** Queries limited to an element and its descendants. */
export function within(element: TestElement): Queries {
  return bindQueries({
    elements: () => (element.isConnected ? [element, ...element.descendants()] : []),
    debug: () => (element.isConnected ? printTree(element) : String(element)),
    waitFor,
  });
}

function ownerOf(target: Target): RenderResult {
  const owner = typeof target === "string" ? [...mounted].at(-1) : owners.get(target);
  if (!owner) throw new Error("fireEvent: the element does not belong to an open render");
  return owner;
}

/** Input on the render an element belongs to (a string id targets the latest render). */
export const fireEvent: FireEvent = {
  click: (target, options) => ownerOf(target).fireEvent.click(target, options),
  hover: (target) => ownerOf(target).fireEvent.hover(target),
  type: (target, text, options) => ownerOf(target).fireEvent.type(target, text, options),
  clear: (target) => ownerOf(target).fireEvent.clear(target),
  key: (key, target) => (target === undefined ? latest() : ownerOf(target)).fireEvent.key(key, target),
  scroll: (target, options) => ownerOf(target).fireEvent.scroll(target, options),
  native: (event) => latest().fireEvent.native(event),
};

function latest(): RenderResult {
  const last = [...mounted].at(-1);
  if (!last) throw new Error("fireEvent: nothing is rendered");
  return last;
}

/** Unmounts every render still open. Call it in `afterEach`. */
export function cleanup(): void {
  for (const result of [...mounted]) result.unmount();
}

/** The tree under `element` as indented text. */
export function printTree(element: TestElement | undefined, maxLines = 200): string {
  if (!element) return "(empty tree)";
  const lines: string[] = [];
  const walk = (current: TestElement, depth: number) => {
    if (lines.length >= maxLines) return;
    lines.push(`${"  ".repeat(depth)}${current}`);
    for (const child of current.children) walk(child, depth + 1);
  };
  walk(element, 0);
  if (lines.length >= maxLines) lines.push("…");
  return lines.join("\n");
}

export interface MatchImageOptions extends ImageSnapshotOptions {}

/**
 * Compares the render's current frame (or an image) with the PNG at `file`. A missing file is
 * written (on CI it fails); a mismatch past `maxDifferenceRatio` (share of pixels, default 0)
 * — counting only channel deltas above `threshold` — writes `<file>.actual.png` and throws.
 * `TARVE_UPDATE_SNAPSHOTS=1` rewrites the stored images.
 */
export async function toMatchImageSnapshot(source: RenderResult | RgbaImage, file: string, options: MatchImageOptions = {}): Promise<PixelComparison | undefined> {
  if ("settle" in source) await source.settle();
  const image = "pixels" in source && typeof source.pixels === "function" ? source.pixels() : (source as RgbaImage);
  return matchImageSnapshot(image, file, options);
}

/**
 * Matchers for `expect.extend(tarveMatchers)`: `await expect(view).toMatchImageSnapshot(file, options)`.
 */
export const tarveMatchers = {
  async toMatchImageSnapshot(received: unknown, file: string, options?: MatchImageOptions) {
    try {
      await toMatchImageSnapshot(received as RenderResult | RgbaImage, file, options);
      return { pass: true, message: () => `expected the image not to match ${file}` };
    } catch (error) {
      return { pass: false, message: () => (error instanceof Error ? error.message : String(error)) };
    }
  },
};
