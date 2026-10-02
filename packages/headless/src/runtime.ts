import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

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
  free(): void;
}

interface WasmModule {
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
}

const SANS = ["system-ui", "ui-sans-serif", "sans-serif", "serif", "ui-serif", "cursive", "fantasy", "emoji"];
const MONO = ["monospace", "ui-monospace"];

let runtime: Promise<HeadlessRuntime> | undefined;
let loaded: HeadlessRuntime | undefined;
let wasmModule: WasmModule | undefined;

function asset(path: string): string {
  return fileURLToPath(new URL(path, import.meta.url));
}

/**
 * Loads the WebAssembly build of Tarve's native tree and the bundled fonts, once per process.
 * There are no system fonts here: text renders with the same Inter and JetBrains Mono on every
 * machine, which is what makes captures comparable across platforms.
 */
export function loadHeadlessRuntime(options: HeadlessRuntimeOptions = {}): Promise<HeadlessRuntime> {
  runtime ??= (async () => {
    const glue = asset("../wasm/tarve_web.js");
    const binary = asset("../wasm/tarve_web_bg.wasm");
    if (!existsSync(glue) || !existsSync(binary)) {
      throw new Error("@tarve/headless: the WebAssembly runtime is missing. Run `bun run build:wasm` in the Tarve repository.");
    }
    const module = (await import(glue)) as WasmModule;
    const { memory } = module.initSync({ module: readFileSync(binary) });
    module.registerFont(readFileSync(asset("../fonts/InterVariable.ttf")), SANS.join(","));
    module.registerFont(readFileSync(asset("../fonts/JetBrainsMono.ttf")), MONO.join(","));
    wasmModule = module;
    loaded = { memory, WebTree: module.WebTree };
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
