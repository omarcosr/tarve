import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import {
  TestRenderer,
  Window,
  compareRgbaImages,
  createApp,
  readPngRgba,
  type AppHandle,
  type AppOptions,
  type PixelComparison,
  type PixelComparisonOptions,
  type RgbaImage,
  type ThemeDefinition,
  type VNode,
} from "@tarve/core";
import { jsx } from "@tarve/core/jsx-runtime";
import { HeadlessBridge, type HeadlessBridgeOptions } from "./bridge";
import { encodePng } from "./png";
import { loadHeadlessRuntime, type HeadlessRuntimeOptions } from "./runtime";

export { HeadlessBridge, type HeadlessBridgeOptions } from "./bridge";
export { encodePng } from "./png";
export {
  loadHeadlessRuntime,
  registerHeadlessFont,
  type HeadlessFont,
  type HeadlessRuntimeOptions,
} from "./runtime";

export type HeadlessAppOptions = Omit<AppOptions, "bridge" | "debug" | "headless"> & HeadlessBridgeOptions & HeadlessRuntimeOptions;

export interface HeadlessApp extends AppHandle {
  readonly bridge: HeadlessBridge;
  /** Waits until the app stops re-rendering in response to layout and input. */
  settle(): Promise<void>;
  /** The current frame as RGBA pixels. */
  pixels(): RgbaImage;
  /** The current frame as PNG bytes. */
  png(): Uint8Array;
}

/**
 * Runs a Tarve app on the WebAssembly runtime: no window, GPU or native library, so it works in
 * any CI. Input, `inspect`, `advanceMotion` and `capture` behave as in a debug window.
 */
export async function createHeadlessApp(view: () => VNode, options: HeadlessAppOptions = {}): Promise<HeadlessApp> {
  const { width, height, scale, clock, assetRoot, fonts, ...appOptions } = options;
  await loadHeadlessRuntime({ fonts });
  const bridge = new HeadlessBridge({ width, height, scale, clock, assetRoot });
  const app = createApp(view, { ...appOptions, debug: true, bridge });
  await app.ready;
  await bridge.settle();
  return Object.assign(app, {
    bridge,
    settle: () => bridge.settle(),
    pixels: () => bridge.pixels(),
    png: () => bridge.png(),
  });
}

/** `createTestRenderer` on the WebAssembly runtime: locators, clicks, typing and captures without a window. */
export async function createHeadlessTestRenderer(view: () => VNode, options: HeadlessAppOptions = {}): Promise<TestRenderer> {
  return new TestRenderer(await createHeadlessApp(view, options));
}

export interface RenderOptions extends HeadlessBridgeOptions, HeadlessRuntimeOptions {
  /** Theme of the Window wrapped around a view that is not a Window already. */
  theme?: ThemeDefinition;
}

function windowed(view: VNode | (() => VNode), options: RenderOptions): () => VNode {
  const render = typeof view === "function" ? view : () => view;
  return () => {
    const root = render();
    if (root.type === Window) return root;
    return jsx(Window, {
      width: options.width ?? 640,
      height: options.height ?? 480,
      ...(options.theme ? { theme: options.theme } : {}),
      children: root,
    });
  };
}

/** Renders a view (or a component tree that is not a Window, inside a default one) to RGBA pixels. */
export async function renderToRgba(view: VNode | (() => VNode), options: RenderOptions = {}): Promise<RgbaImage> {
  const { theme: _theme, ...appOptions } = options;
  const app = await createHeadlessApp(windowed(view, options), appOptions);
  try {
    return app.pixels();
  } finally {
    app.close();
  }
}

/** Renders a view to PNG bytes. Same input, same bytes, on every platform. */
export async function renderToPng(view: VNode | (() => VNode), options: RenderOptions = {}): Promise<Uint8Array> {
  const image = await renderToRgba(view, options);
  return encodePng(image.rgba, image.width, image.height);
}

export interface ImageSnapshotOptions extends PixelComparisonOptions {
  /** Share of pixels allowed to differ. Default 0: captures are deterministic. */
  maxDifferenceRatio?: number;
  /** Overwrite the stored image. Default: `TARVE_UPDATE_SNAPSHOTS=1`. */
  update?: boolean;
}

/**
 * Compares an image with the PNG stored at `file`. A missing file is written (except on CI,
 * where it fails); a mismatch writes `<file>.actual.png` next to it and throws.
 */
export async function matchImageSnapshot(image: RgbaImage, file: string, options: ImageSnapshotOptions = {}): Promise<PixelComparison | undefined> {
  const update = options.update ?? process.env.TARVE_UPDATE_SNAPSHOTS === "1";
  const write = (path: string) => {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, encodePng(image.rgba, image.width, image.height));
  };
  if (update || !existsSync(file)) {
    if (!update && process.env.CI) throw new Error(`Missing image snapshot ${file}. Run the tests locally to create it and commit it.`);
    write(file);
    return undefined;
  }
  const expected = await readPngRgba(file);
  const actualPath = file.replace(/\.png$/i, "") + ".actual.png";
  if (expected.width !== image.width || expected.height !== image.height) {
    write(actualPath);
    throw new Error(`Image snapshot ${file} is ${expected.width}x${expected.height}, got ${image.width}x${image.height}; wrote ${actualPath}`);
  }
  const comparison = compareRgbaImages(image, expected, options);
  if (comparison.differenceRatio > (options.maxDifferenceRatio ?? 0)) {
    write(actualPath);
    throw new Error(
      `Image snapshot ${file} differs in ${comparison.differentPixels} of ${comparison.totalPixels} pixels ` +
        `(max channel delta ${comparison.maxChannelDelta}); wrote ${actualPath}`,
    );
  }
  return comparison;
}
