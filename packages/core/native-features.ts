import { existsSync } from "node:fs";
import { copyFile, mkdir } from "node:fs/promises";
import { spawn, spawnSync } from "node:child_process";
import { builtinModules } from "node:module";
import { join, resolve } from "node:path";
import type { Plugin } from "esbuild";
import { frameworkPlugins } from "./framework-plugins";
import { hostBuildTarget, targetConfig, type BuildTarget } from "./targets";

/** Optional subsystems of the native library (native/Cargo.toml `[features]`). */
export const NATIVE_FEATURES = ["vello-gpu", "syntax", "markdown", "net", "media"] as const;
export type NativeFeature = typeof NATIVE_FEATURES[number];

export interface NativeFeatureReport {
  features: NativeFeature[];
  /** Why each feature is in: the API or literal that pulled it. */
  reasons: Partial<Record<NativeFeature, string>>;
}

const ASSET = /\.(?:png|jpe?g|webp|gif|svg|ico|ttf|otf|woff2?|css)$/i;
const CORE = /^(?:@tarve\/core(?:-internal)?|tarve)(?:\/.*)?$/;
/** XML namespaces in SVG icon sets are identifiers, not requests. */
const NAMESPACE = /^https?:\/\/www\.w3\.org\//;

/** The app's code with @tarve/core left external, so only what the app itself uses is scanned. */
async function appSource(entrypoint: string): Promise<string> {
  const { build } = await import("esbuild");
  const external: Plugin = {
    name: "tarve-native-features",
    setup(builder) {
      builder.onResolve({ filter: CORE }, args => ({ path: args.path, external: true }));
      builder.onResolve({ filter: /.*/ }, args => {
        const name = args.path.replace(/^node:/, "");
        if (args.path.startsWith("node:") || args.path.startsWith("bun:") || args.path.startsWith("tjs:") || builtinModules.includes(name)) {
          return { path: args.path, external: true };
        }
        if (args.with?.type === "file" || args.with?.type === "text" || ASSET.test(args.path)) return { path: args.path, external: true };
        return undefined;
      });
    },
  };
  const result = await build({
    entryPoints: [resolve(entrypoint)],
    bundle: true,
    write: false,
    format: "esm",
    platform: "neutral",
    mainFields: ["module", "main"],
    target: "es2023",
    jsx: "automatic",
    jsxImportSource: "@tarve/core",
    logLevel: "silent",
    plugins: [external, ...await frameworkPlugins(entrypoint)],
  });
  return result.outputFiles.map(file => file.text).join("\n");
}

/** Names the app imports from @tarve/core. */
function coreImports(source: string): Set<string> {
  const names = new Set<string>();
  for (const match of source.matchAll(/import\s*\{([^}]*)\}\s*from\s*["'](?:@tarve\/core|tarve)(?:\/[^"']*)?["']/g)) {
    for (const part of match[1]!.split(",")) {
      const name = part.trim().split(/\s+as\s+/)[0]!.trim();
      if (name) names.add(name);
    }
  }
  return names;
}

/** Native features an app's source needs, for `platform` (process.platform naming). */
export function nativeFeaturesFor(source: string, platform: string): NativeFeatureReport {
  const reasons: NativeFeatureReport["reasons"] = {};
  const imports = coreImports(source);
  const element = (name: string) => new RegExp(`\\bjsxs?\\(\\s*["']${name}["']|["']${name}["']`).test(source);
  if (imports.has("Markdown") || element("markdown")) reasons.markdown = "Markdown";
  const syntax = ["Markdown", "Code", "Diff"].find(name => imports.has(name)) ?? ["markdown", "code", "diff"].find(element);
  if (syntax) reasons.syntax = syntax;
  const media = ["Audio", "Video"].find(name => imports.has(name)) ?? ["audio", "video"].find(element);
  if (media) reasons.media = `<${media.toLowerCase()}>`;
  const url = [...source.matchAll(/["'`](https?:\/\/[^"'`\s]*)/g)].map(match => match[1]!).find(url => !NAMESPACE.test(url));
  if (url) reasons.net = url.length > 60 ? `${url.slice(0, 57)}...` : url;
  // Windows draws on D3D11 (CPU fallback); Vello over wgpu is the GPU renderer elsewhere.
  if (platform !== "win32" && !/\brenderer\s*:\s*["']cpu["']/.test(source)) reasons["vello-gpu"] = "GPU renderer";
  return { features: NATIVE_FEATURES.filter(feature => reasons[feature]), reasons };
}

export async function detectNativeFeatures(entrypoint: string, platform: string): Promise<NativeFeatureReport> {
  return nativeFeaturesFor(await appSource(entrypoint), platform);
}

/** `all`, `auto`, or a comma list of features; `TARVE_NATIVE_FEATURES` and package.json `tarve.nativeFeatures` set the default. */
export function parseNativeFeatures(value: string | readonly string[] | undefined): NativeFeature[] | "all" | "auto" {
  if (value === undefined) return "auto";
  const list = typeof value === "string" ? value.split(",") : [...value];
  const names = list.map(name => name.trim()).filter(Boolean);
  if (names.length === 1 && (names[0] === "all" || names[0] === "auto")) return names[0];
  for (const name of names) {
    if (!(NATIVE_FEATURES as readonly string[]).includes(name)) {
      throw new Error(`Unknown native feature: ${name}. Expected all, auto or a list of ${NATIVE_FEATURES.join(", ")}.`);
    }
  }
  return NATIVE_FEATURES.filter(feature => names.includes(feature));
}

/**
 * Prebuilt trimmed libraries shipped next to the full one (native/<platform>/variants/<name>/),
 * smallest first, so an app built from npm without Rust still gets a smaller executable.
 * Linux variants also carry vello-gpu: it is the GPU renderer there.
 */
export const NATIVE_VARIANTS: readonly { name: string; features: readonly NativeFeature[] }[] = [
  { name: "core", features: [] },
  { name: "rich", features: ["syntax", "markdown"] },
  { name: "media", features: ["net", "media"] },
  { name: "rich-media", features: ["syntax", "markdown", "net", "media"] },
];

/** The features a variant is compiled with on `platform`. */
export function variantFeatures(variant: typeof NATIVE_VARIANTS[number], platform: string): NativeFeature[] {
  const features = new Set<NativeFeature>(variant.features);
  if (platform !== "win32") features.add("vello-gpu");
  return NATIVE_FEATURES.filter(feature => features.has(feature));
}

/** The smallest variant covering `required`, or undefined when only the full library does. */
export function pickNativeVariant(required: readonly NativeFeature[], platform: string): typeof NATIVE_VARIANTS[number] | undefined {
  return NATIVE_VARIANTS.find(variant => {
    const features = variantFeatures(variant, platform);
    return required.every(feature => features.includes(feature));
  });
}

/** Where a variant sits relative to the full library's directory. */
export function nativeVariantPath(libraryDirectory: string, variant: string, nativeName: string): string {
  return join(libraryDirectory, "variants", variant, nativeName);
}

const repository = resolve(import.meta.dirname, "../..");
const manifest = join(repository, "native/Cargo.toml");

/** Whether this Tarve checkout can compile a trimmed native library for `target`. */
export function canTrimNative(target: BuildTarget): boolean {
  return target === hostBuildTarget() && existsSync(manifest) && spawnSync("cargo", ["--version"], { stdio: "ignore", shell: process.platform === "win32" }).status === 0;
}

/** Compiles the native library with only `features` (plus the allocator defaults); returns its path. */
export async function buildTrimmedNative(target: BuildTarget, features: readonly NativeFeature[]): Promise<string> {
  const config = targetConfig(target);
  const key = features.length ? [...features].sort().join("+") : "core";
  const targetDirectory = join(repository, "native/target-features");
  const env = { ...process.env };
  if (config.platform === "win32") {
    // Same as the release library: the CRT stays inside the DLL.
    env.RUSTFLAGS = `${env.RUSTFLAGS ?? ""} -Ctarget-feature=+crt-static`.trim();
  }
  const args = [
    "build", "--release", "--locked", "--manifest-path", manifest, "--target-dir", targetDirectory,
    "--no-default-features", "--features", ["mimalloc", "fxhash", ...features].join(","),
  ];
  const cargo = spawn("cargo", args, { cwd: repository, env, stdio: ["ignore", "inherit", "inherit"], shell: process.platform === "win32" });
  const status = await new Promise<number | null>(done => cargo.on("close", done));
  if (status !== 0) throw new Error(`Native build with features [${features.join(", ")}] failed.`);
  const output = join(repository, "native/bin-features", key);
  await mkdir(output, { recursive: true });
  const library = join(output, config.nativeName);
  await copyFile(join(targetDirectory, "release", config.nativeName), library);
  return library;
}
