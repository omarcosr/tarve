import { readFileSync } from "node:fs";
// `with { type: "file" }` is how Tarve apps reach files on every runtime: Bun resolves it to the
// path, the Node.js bundle (`tarve run --runtime node`) copies the file next to itself and the
// txiki.js build embeds it (packages/core/esbuild-file-imports.ts, txiki-build.ts).
import interFont from "../fonts/InterVariable.ttf" with { type: "file" };
import monoFont from "../fonts/JetBrainsMono.ttf" with { type: "file" };

/** The part of the wasm-bindgen output this package uses (see native/src/web.rs). */
export interface WebTreeHandle {
  command(command: string): void;
  resize(width: number, height: number, scale: number): void;
  frame(nowMs: number): boolean;
  pixelsPtr(): number;
  pixelsLen(): number;
  deviceWidth(): number;
  deviceHeight(): number;
  nextTickMs(): number;
  takeEvents(): string;
  takeRemoteImageRequests(): string;
  finishRemoteImage(url: string, bytes: Uint8Array, error?: string): void;
  free(): void;
}

/** zlib streams from the WebAssembly runtime (native/src/zlib.rs): the PNG encoder's, on every engine. */
export interface HeadlessZlib {
  /** A zlib-wrapped deflate stream of `data` at `level` (0–9). */
  deflate(data: Uint8Array, level: number): Uint8Array;
  /** The bytes of a zlib stream; throws when `data` is not one. */
  inflate(data: Uint8Array): Uint8Array;
}

interface WasmModule extends HeadlessZlib {
  initSync(options: { module: BufferSource }): { memory: WebAssembly.Memory };
  registerFont(bytes: Uint8Array, generics: string): void;
  WebTree: new (document: string) => WebTreeHandle;
}

/** A font to register before rendering, e.g. a CJK or emoji font. */
export interface HeadlessFont {
  data: Uint8Array;
  /** CSS generic families it serves: `sans-serif`, `monospace`, `emoji`… */
  families: readonly string[];
}

export interface HeadlessRuntimeOptions {
  /** Extra fonts, registered after the bundled Inter and JetBrains Mono. */
  fonts?: readonly HeadlessFont[];
}

export interface HeadlessRuntime {
  memory: WebAssembly.Memory;
  WebTree: WasmModule["WebTree"];
  zlib: HeadlessZlib;
  /**
   * Which build runs: `simd` (wasm simd128, about twice as fast to paint) where the engine has
   * WebAssembly SIMD, else `baseline`. Both render the same pixels.
   */
  build: "simd" | "baseline";
}

const SANS = ["system-ui", "ui-sans-serif", "sans-serif", "serif", "ui-serif", "cursive", "fantasy", "emoji"];
const MONO = ["monospace", "ui-monospace"];

let runtime: Promise<HeadlessRuntime> | undefined;
let loaded: HeadlessRuntime | undefined;
let wasmModule: WasmModule | undefined;

/** The smallest module with a v128 value: engines without WebAssembly SIMD (txiki.js's WAMR) reject it. */
const SIMD_PROBE = new Uint8Array([0, 97, 115, 109, 1, 0, 0, 0, 1, 5, 1, 96, 0, 1, 123, 3, 2, 1, 0, 10, 10, 1, 8, 0, 65, 0, 253, 15, 253, 98, 11]);

type FileModule = { default: string };

/** The build this engine can compile, chosen by feature detection: the glue module and the path of its binary. */
async function wasmBuild(): Promise<{ build: HeadlessRuntime["build"]; module: WasmModule; binary: string }> {
  const build = WebAssembly.validate(SIMD_PROBE) ? "simd" : "baseline";
  try {
    // Literal specifiers, so bundlers (Node.js and txiki.js builds) include both builds.
    const [module, binary] = await (build === "simd"
      ? Promise.all([import("../wasm/tarve_web.js"), import("../wasm/tarve_web_bg.wasm", { with: { type: "file" } })])
      : Promise.all([import("../wasm/baseline/tarve_web.js"), import("../wasm/baseline/tarve_web_bg.wasm", { with: { type: "file" } })]));
    return { build, module: module as WasmModule, binary: (binary as unknown as FileModule).default };
  } catch (cause) {
    throw new Error(`@tarve/headless: could not load the ${build} WebAssembly runtime. In the Tarve repository, build it with \`bun run build:wasm\`.`, { cause });
  }
}

/**
 * Loads the WebAssembly build of Tarve's native tree and the bundled fonts, once per process.
 * There are no system fonts here: text renders with the same Inter and JetBrains Mono on every
 * machine, which is what makes captures comparable across platforms.
 */
export function loadHeadlessRuntime(options: HeadlessRuntimeOptions = {}): Promise<HeadlessRuntime> {
  runtime ??= (async () => {
    const { build, module, binary } = await wasmBuild();
    const { memory } = module.initSync({ module: readFileSync(binary) });
    module.registerFont(readFileSync(interFont), SANS.join(","));
    module.registerFont(readFileSync(monoFont), MONO.join(","));
    wasmModule = module;
    loaded = { memory, WebTree: module.WebTree, zlib: { deflate: module.deflate, inflate: module.inflate }, build };
    return loaded;
  })();
  return runtime.then((ready) => {
    for (const font of options.fonts ?? []) registerHeadlessFont(font);
    return ready;
  });
}

/** Registers a font for every tree created afterwards. Call after `loadHeadlessRuntime`. */
export function registerHeadlessFont(font: HeadlessFont): void {
  if (!wasmModule) throw new Error("@tarve/headless: call loadHeadlessRuntime() before registering fonts");
  wasmModule.registerFont(font.data, font.families.join(","));
}

/** The loaded runtime, for code that cannot await (bridges start synchronously). */
export function headlessRuntime(): HeadlessRuntime {
  if (!loaded) throw new Error("@tarve/headless: call and await loadHeadlessRuntime() first");
  return loaded;
}
