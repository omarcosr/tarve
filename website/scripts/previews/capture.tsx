// Renders every documentation example with the same WebAssembly build of Tarve the live
// playground runs (same fonts, same layout, same paint), and saves a 2x PNG per component to
// public/previews. The poster and the first live frame are therefore the same picture.
//   bun run docs:previews            all components
//   bun run docs:previews Button     only the named components
// Needs the wasm build: bun run build:wasm
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { basename, extname, resolve } from "node:path";
import { Column, Window, createApp, darkTheme, type NativeBridge, type VNode } from "@tarve/core";
import type { NativeCommand, NativeEvent, NativeImageSource, SceneDocument } from "../../../packages/protocol/src/index";
import { toPreviewModule } from "../../src/lib/playground/example-transform";
import { WebTree, initSync, registerFont } from "../../src/lib/playground/wasm/tarve_web.js";
import { cropRgba, encodePng } from "./png";

const here = import.meta.dir;
const website = resolve(here, "../..");
const publicDir = resolve(website, "public");
const examplesDir = resolve(website, "src/lib/docs/examples");
const generatedDir = resolve(here, ".generated");
const outDir = resolve(publicDir, "previews");
const manifestPath = resolve(website, "src/lib/generated/previews.json");
const wasmPath = resolve(website, "src/lib/playground/wasm/tarve_web_bg.wasm");

// Same width as the inside of the playground stage in the docs column (.doc max-width minus the
// stage border) and the same padding as the live playground
// (mount.tsx), so the poster and the first live frame line up pixel for pixel.
const WINDOW: [number, number] = [858, 720];
const PAD = 40;
const MIN: [number, number] = [480, 220];
const SCALE = 2;

/** CSS pixels. The poster is the `left/top/width/height` crop of a `frameWidth × frameHeight` frame. */
type Preview = { width: number; height: number; left: number; top: number; frameWidth: number; frameHeight: number };

if (!existsSync(wasmPath)) {
  console.error("Missing src/lib/playground/wasm — run bun run build:wasm first.");
  process.exit(1);
}
const wasm = initSync({ module: readFileSync(wasmPath) });
registerFont(readFileSync(resolve(publicDir, "fonts/InterVariable.ttf")), "system-ui,ui-sans-serif,sans-serif,serif,ui-serif,cursive,fantasy,emoji");
registerFont(readFileSync(resolve(publicDir, "fonts/JetBrainsMono.ttf")), "monospace,ui-monospace");

const MEDIA: Record<string, string> = { ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".webp": "image/webp", ".svg": "image/svg+xml" };

/** The browser fetches `Image` paths as URLs from public/; here they are read from disk. */
function inlineImages(value: unknown): void {
  if (Array.isArray(value)) {
    for (const item of value) inlineImages(item);
    return;
  }
  if (!value || typeof value !== "object") return;
  const node = value as Record<string, unknown> & { src?: string; image?: NativeImageSource };
  if (typeof node.kind === "string" && typeof node.id === "string" && typeof node.src === "string" && !node.image && !node.src.startsWith("data:")) {
    const file = resolve(publicDir, node.src.replace(/^\//, ""));
    if (existsSync(file)) {
      node.image = { kind: "encoded", key: node.src, data: readFileSync(file).toString("base64"), mediaType: MEDIA[extname(file)] };
      delete node.src;
    }
  }
  for (const key in node) if (key !== "style") inlineImages(node[key]);
}

/** `NativeBridge` over the wasm tree, without a canvas. */
class HeadlessBridge implements NativeBridge {
  private tree?: WebTree;
  private onEvent?: (event: NativeEvent) => void;
  constructor(private readonly size: [number, number] | undefined) {}

  start(document: SceneDocument, onEvent: (event: NativeEvent) => void): void {
    this.onEvent = onEvent;
    inlineImages(document);
    this.tree = new WebTree(JSON.stringify(document));
    const [width, height] = this.size ?? [document.window.width, document.window.height];
    this.tree.resize(width, height, SCALE);
    queueMicrotask(() => {
      this.frame();
      onEvent({ type: "ready" });
    });
  }

  send(command: NativeCommand): void {
    if (!this.tree) return;
    if (command.type === "close") {
      this.tree.free();
      this.tree = undefined;
      this.onEvent?.({ type: "closed" });
      return;
    }
    inlineImages(command);
    this.tree.command(JSON.stringify(command));
    this.flush();
  }

  join(): void {}

  frame(): void {
    this.tree?.frame(performance.now());
    this.flush();
  }

  pixels(): { rgba: Uint8Array; width: number; height: number } {
    const tree = this.tree!;
    this.frame();
    return {
      rgba: new Uint8Array(wasm.memory.buffer, tree.pixelsPtr(), tree.pixelsLen()).slice(),
      width: tree.deviceWidth(),
      height: tree.deviceHeight(),
    };
  }

  private flush(): void {
    if (!this.tree) return;
    for (const event of JSON.parse(this.tree.takeEvents()) as NativeEvent[]) this.onEvent?.(event);
  }
}

/** Deterministic placeholder images for the Image, AspectRatio and Avatar examples. */
function writeAssets(): void {
  const dir = resolve(publicDir, "assets");
  mkdirSync(dir, { recursive: true });
  const paint = (file: string, width: number, height: number, pixel: (u: number, v: number) => [number, number, number]) => {
    const rgba = new Uint8Array(width * height * 4);
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const [r, g, b] = pixel(x / (width - 1), y / (height - 1));
        rgba.set([r, g, b, 255], (y * width + x) * 4);
      }
    }
    writeFileSync(resolve(dir, file), encodePng(rgba, width, height));
  };
  const mix = (a: number[], b: number[], t: number) => a.map((value, i) => Math.round(value + (b[i]! - value) * t)) as [number, number, number];
  const violet = [124, 92, 255];
  const cyan = [34, 211, 238];
  const pink = [244, 114, 182];
  const night = [12, 12, 22];
  paint("cover.png", 960, 540, (u, v) => {
    const glow = Math.max(0, 1 - Math.hypot(u - 0.7, v - 0.35) * 1.6);
    return mix(mix(violet, cyan, u * 0.8 + v * 0.2), night, 0.25 + v * 0.35 - glow * 0.25);
  });
  paint("photo.png", 640, 400, (u, v) => {
    const sun = Math.hypot(u - 0.3, v - 0.42) < 0.12 ? 1 : 0;
    const hill = v > 0.62 + Math.sin(u * 7) * 0.06 ? 1 : 0;
    const sky = mix(pink, violet, v * 1.3);
    return hill ? mix(night, violet, 0.25 * (1 - v)) : sun ? [253, 224, 171] : sky;
  });
  paint("ada.png", 128, 128, (u, v) => mix(cyan, violet, Math.min(1, Math.hypot(u - 0.35, v - 0.3) * 1.4)));
}


async function captureOne(name: string): Promise<Preview> {
  const { code, fullWindow } = toPreviewModule(name, readFileSync(resolve(examplesDir, name + ".tsx"), "utf8"));
  const file = resolve(generatedDir, name + ".tsx");
  writeFileSync(file, code);
  const mod = (await import(file)) as { preview: () => VNode };
  const bridge = new HeadlessBridge(fullWindow ? undefined : WINDOW);
  const errors: string[] = [];
  const app = createApp(
    fullWindow
      ? mod.preview
      : () => (
          <Window title={name} theme={darkTheme}>
            <Column flex={1} align="center" justify="center" padding={PAD}>
              {mod.preview()}
            </Column>
          </Window>
        ),
    { bridge, renderer: "cpu", onError: (event) => errors.push(event.error.message) },
  );
  try {
    await app.ready;
    for (let pass = 0; pass < 6; pass++) {
      await Bun.sleep(20);
      bridge.frame();
    }
    if (errors.length) throw new Error(errors.join("; "));
    const png = bridge.pixels();
    let x0 = 0;
    let y0 = 0;
    let x1 = png.width;
    let y1 = png.height;
    if (!fullWindow) {
      // Crop to the painted pixels (anything that differs from the window/overlay background), plus padding.
      const { rgba, width: w, height: h } = png;
      const bg = [rgba[0]!, rgba[1]!, rgba[2]!];
      let minX = w;
      let minY = h;
      let maxX = -1;
      let maxY = -1;
      for (let y = 0; y < h; y++) {
        for (let x = 0; x < w; x++) {
          const i = (y * w + x) * 4;
          if (Math.abs(rgba[i]! - bg[0]!) + Math.abs(rgba[i + 1]! - bg[1]!) + Math.abs(rgba[i + 2]! - bg[2]!) > 24) {
            if (x < minX) minX = x;
            if (x > maxX) maxX = x;
            if (y < minY) minY = y;
            if (y > maxY) maxY = y;
          }
        }
      }
      if (maxX < 0) throw new Error("rendered nothing");
      // Work in CSS pixels so the crop is a whole number of them at either scale.
      const css = (value: number) => value / SCALE;
      const width = css(maxX - minX + 1) + PAD * 2;
      const height = css(maxY - minY + 1) + PAD * 2;
      const growX = Math.max(0, MIN[0] - width) / 2;
      const growY = Math.max(0, MIN[1] - height) / 2;
      const left = Math.max(0, Math.floor(css(minX) - PAD - growX));
      const top = Math.max(0, Math.floor(css(minY) - PAD - growY));
      const right = Math.min(css(w), Math.ceil(css(maxX + 1) + PAD + growX));
      const bottom = Math.min(css(h), Math.ceil(css(maxY + 1) + PAD + growY));
      x0 = left * SCALE;
      y0 = top * SCALE;
      x1 = right * SCALE;
      y1 = bottom * SCALE;
    }
    const width = x1 - x0;
    const height = y1 - y0;
    writeFileSync(resolve(outDir, name + ".png"), encodePng(cropRgba(png.rgba, png.width, x0, y0, width, height), width, height));
    return {
      width: width / SCALE,
      height: height / SCALE,
      left: x0 / SCALE,
      top: y0 / SCALE,
      frameWidth: png.width / SCALE,
      frameHeight: png.height / SCALE,
    };
  } finally {
    app.close();
  }
}

async function captureAll(selected: string[]): Promise<void> {
  writeAssets();
  rmSync(generatedDir, { recursive: true, force: true });
  mkdirSync(generatedDir, { recursive: true });
  mkdirSync(outDir, { recursive: true });
  const names = readdirSync(examplesDir)
    .filter((file) => file.endsWith(".tsx"))
    .map((file) => basename(file, ".tsx"))
    .filter((name) => selected.length === 0 || selected.includes(name))
    .sort();
  const manifest: Record<string, Preview> =
    selected.length && existsSync(manifestPath) ? JSON.parse(readFileSync(manifestPath, "utf8")) : {};
  const failures: string[] = [];
  for (const name of names) {
    try {
      manifest[name] = await captureOne(name);
      console.log(`  ✓ ${name} ${manifest[name]!.width}×${manifest[name]!.height}`);
    } catch (error) {
      failures.push(`${name}: ${error instanceof Error ? error.message : String(error)}`);
      console.log(`  ✗ ${name}`);
    }
  }
  const sorted = Object.fromEntries(Object.entries(manifest).sort(([a], [b]) => a.localeCompare(b)));
  writeFileSync(manifestPath, JSON.stringify(sorted, null, 2) + "\n");
  if (failures.length) {
    console.error(failures.map((failure) => "  " + failure).join("\n"));
    process.exit(1);
  }
  console.log(`[previews] ${names.length} components captured → public/previews`);
}

await captureAll(process.argv.slice(2));
process.exit(0);
