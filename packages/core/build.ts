import type { BunPlugin } from "bun";
import { spawnSync } from "node:child_process";
import { closeSync, copyFileSync, existsSync, mkdtempSync, openSync, readFileSync, writeFileSync } from "node:fs";
import { mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { nativePath } from "#tarve/runtime";
import { buildMetadata, writeLinuxDesktopEntry } from "./package-metadata";
import { prebundleForBun } from "./bun-prebundle";
import { BUILD_TARGETS, hostBuildTarget, isBuildTarget, isMacTarget, targetConfig, type BuildTarget } from "./targets";
import { bundleExecutableName, macAppPath, writeMacAppBundle } from "./macos-bundle";
import type { NativeFeature } from "./native-features";
import { pluginNativesForBuild, pluginNativeRuntimeLines } from "./plugins-build";
import {
  NATIVE_COMPATIBILITY_MANIFEST_NAME,
  assertNativeRuntimeCompatible,
  createNativeCompatibilityManifest,
  readNativeCompatibilityManifest,
} from "./native-runtime";

export { BUILD_TARGETS, hostBuildTarget, isBuildTarget, nativeDirectoryForBuildTarget, nativeRelativePath, targetConfig, type BuildTarget } from "./targets";

export interface BuildOptions {
  entrypoint: string;
  outfile?: string;
  /** Executable, window and app-identity metadata; each also reads from package.json `tarve`. */
  name?: string;
  version?: string;
  description?: string;
  publisher?: string;
  copyright?: string;
  /** .png (square, 256 px or more) or .ico. */
  icon?: string;
  /** Windows AppUserModelID / Linux app id, e.g. `Acme.Notes`. */
  appId?: string;
  /** darwin-arm64/darwin-x64 build a `<name>.app` bundle (outfile gets `.app`), with the runtime in Contents/Frameworks. */
  target?: BuildTarget;
  /** Override for building the repository against a freshly compiled release library. */
  nativeLibrary?: string;
  /** "txiki": a txiki.js (QuickJS-ng) executable, no Bun or Node.js at run time. */
  runtime?: "bun" | "node" | "txiki";
  /** Experimental: compile JSX into reusable templates at build time (packages/core/jsx-compile.ts). Bun and txiki.js builds. */
  compileJsx?: boolean;
  /** Runtime binary for the target OS (Node.js or txiki.js); required when cross-compiling a Node SEA or txiki.js app. */
  targetExecutable?: string;
  /**
   * A smaller JavaScript heap, collected more often: Bun's `--smol`, Node.js'
   * `--optimize-for-size` with a 1 MB young generation. Less memory, slower
   * bursts of allocation. txiki.js (QuickJS) has no such setting and ignores it.
   */
  smol?: boolean;
  /**
   * Native subsystems to compile in: "auto" (default) keeps the ones the app's code uses,
   * "all" ships the full prebuilt library, or a list (see native-features.ts). Trimming needs
   * a Tarve checkout with Cargo; otherwise the full library is used. Also TARVE_NATIVE_FEATURES.
   */
  nativeFeatures?: string | readonly string[];
  /**
   * Update private key (base64, or a file holding it; `tarve keygen`): the executable then runs
   * signed app packs (`tarve pack`) newer than the app it embeds. Bun, Node.js and txiki.js.
   */
  updateKey?: string;
}

/** Flags a `smol` executable starts with, per runtime. */
export function smolExecArgv(runtime: "bun" | "node"): string[] {
  return runtime === "bun" ? ["--smol"] : ["--optimize-for-size", "--max-semi-space-size=1"];
}

// Level 12: within 1 MB of level 19 at a fiftieth of the compression time.
const NATIVE_ZSTD_LEVEL = 12;

function resolveNativeLibrary(target: BuildTarget, override?: string): string {
  if (override) {
    const path = resolve(override);
    if (!existsSync(path)) throw new Error(`Tarve native library does not exist: ${path}`);
    return path;
  }

  const config = targetConfig(target);
  const hostTarget = hostBuildTarget();
  if (hostTarget === target) {
    try { return nativePath(); }
    catch { /* Fall through to the staged release artifact. */ }
  }

  const candidates = [
    join(import.meta.dir, config.nativeName),
    resolve(import.meta.dir, "../../native", config.nativeDirectory, config.nativeName),
  ];
  const found = candidates.find(existsSync);
  if (found) return found;
  throw new Error(
    `Tarve native library missing for ${target}. Expected ${config.nativeName} in native/${config.nativeDirectory}. ` +
    "Use a Tarve package containing that target runtime or pass nativeLibrary explicitly.",
  );
}

/** Compile an ordinary Tarve app. No production entrypoint or app-side bridge setup is needed. */
export async function build(options: BuildOptions): Promise<string> {
  const trimmed = await withTrimmedNative(options);
  options = trimmed.options;
  const packHost = options.updateKey
    ? await (await import("./pack-build")).hostPackConfig(options, options.runtime ?? "bun", trimmed.features)
    : undefined;
  const requested = options.target ?? hostBuildTarget();
  if (requested && isBuildTarget(requested) && isMacTarget(requested) && options.runtime && options.runtime !== "bun") {
    throw new Error(`--runtime ${options.runtime} cannot build a macOS app yet; use --runtime bun.`);
  }
  if (options.runtime === "txiki") {
    const { buildTxiki } = await import("./txiki-build");
    return buildTxiki(options, packHost);
  }
  if (options.runtime === "node") {
    const { buildNode } = await import("./node-build");
    return buildNode(options, packHost);
  }
  const target = options.target ?? hostBuildTarget();
  if (!target) throw new Error(`Tarve executable distribution is not supported for ${process.platform}-${process.arch}. Pass an explicit supported target when cross-compiling.`);
  if (!isBuildTarget(target)) throw new TypeError(`Unsupported Tarve build target: ${String(target)}. Expected ${BUILD_TARGETS.join(" or ")}.`);
  const config = targetConfig(target);
  const entrypoint = resolve(options.entrypoint);
  // Plugins' native libraries for the target (package.json `tarve.native` of the app's plugins).
  const pluginPlan = pluginNativesForBuild(entrypoint, target);
  const packageMetadata = await Bun.file(resolve(import.meta.dir, "../../package.json")).json() as { version?: string };
  if (typeof packageMetadata.version !== "string" || packageMetadata.version.length === 0) {
    throw new Error("Tarve package version is missing.");
  }
  const { metadata, images, define } = buildMetadata(entrypoint, metadataOverrides(options));
  const name = metadata.name;
  const mac = config.platform === "darwin";
  const outfile = mac
    ? macAppPath(resolve(options.outfile ?? `dist/${name}`))
    : resolve(options.outfile ?? `dist/${name}${config.executableSuffix}`);
  const library = resolveNativeLibrary(target, options.nativeLibrary);
  const assetsModule = fileURLToPath(import.meta.resolve("#tarve/assets"));
  const repositorySource = existsSync(join(import.meta.dir, "src", "index.ts"));
  const expectedCompatibility = repositorySource
    ? await createNativeCompatibilityManifest(resolve(import.meta.dir, "../.."), packageMetadata.version)
    : await readNativeCompatibilityManifest(join(import.meta.dir, NATIVE_COMPATIBILITY_MANIFEST_NAME));
  const requireRuntimeManifest = target !== hostBuildTarget()
    || (!options.nativeLibrary && !repositorySource);
  if (requireRuntimeManifest) {
    await assertNativeRuntimeCompatible(library, target, expectedCompatibility);
  }
  const libraryBytes = await Bun.file(library).bytes();
  const libraryDigest = {
    sha256: new Bun.CryptoHasher("sha256").update(libraryBytes).digest("hex"),
    size: libraryBytes.byteLength,
  };
  // The DLL compresses to about a third; it is decompressed once, on first launch, into the asset cache.
  const packDirectory = mkdtempSync(join(tmpdir(), "tarve-native-"));
  const packedLibrary = join(packDirectory, `${config.nativeName}.zst`);
  // macOS: the dylib sits in Contents/Frameworks, signed with the bundle, instead of being
  // extracted at run time (the hardened runtime refuses unsigned libraries).
  const macExecutable = mac ? join(packDirectory, bundleExecutableName(name)) : undefined;
  if (!mac) writeFileSync(packedLibrary, Bun.zstdCompressSync(libraryBytes, { level: NATIVE_ZSTD_LEVEL }));
  const runtime: BunPlugin = {
    name: "tarve-native-runtime",
    setup(builder) {
      builder.onResolve({ filter: /^#tarve\/runtime$/ }, () => ({ path: "runtime", namespace: "tarve" }));
      builder.onLoad({ filter: /^runtime$/, namespace: "tarve" }, () => (mac ? {
        loader: "ts",
        contents: [
          `import { dirname, join } from "node:path";`,
          `export function nativePath() { return join(dirname(process.execPath), "..", "Frameworks", ${JSON.stringify(config.nativeName)}); }`,
          ...pluginNativeRuntimeLines(pluginPlan.embeds, "frameworks"),
        ].join("\n"),
      } : {
        loader: "ts",
        contents: [
          `import library from ${JSON.stringify(packedLibrary)} with { type: "file" };`,
          `import { materializeAsset } from ${JSON.stringify(assetsModule)};`,
          `const digest = ${JSON.stringify(libraryDigest)};`,
          `export function nativePath() { return materializeAsset(library, ${JSON.stringify(config.nativeName)}, digest, "zstd"); }`,
          ...pluginNativeRuntimeLines(pluginPlan.embeds, "embedded"),
        ].join("\n"),
      }));
    },
  };
  await mkdir(dirname(outfile), { recursive: true });
  if (!mac) assertWritable(outfile);
  // Bun reads the executable icon from a file.
  const iconDirectory = images && config.platform === "win32" ? mkdtempSync(join(tmpdir(), "tarve-icon-")) : undefined;
  const icoPath = iconDirectory ? join(iconDirectory, "app.ico") : undefined;
  if (icoPath) writeFileSync(icoPath, images!.ico);
  try {
    // esbuild bundles the app with keepNames (bun-prebundle.ts); Bun minifies and embeds the bundle.
    const bundle = await prebundleForBun({
      entry: packHost ? (await import("./pack-build")).writeHostEntry(packDirectory, entrypoint, packHost) : entrypoint,
      appEntrypoint: entrypoint, directory: packDirectory, define, compileJsx: options.compileJsx,
    });
    const result = await Bun.build({
      entrypoints: [bundle],
      target: "bun",
      plugins: [runtime],
      minify: true,
      compile: {
        target: config.bunTarget,
        outfile: macExecutable ?? outfile,
        autoloadDotenv: false,
        autoloadBunfig: false,
        ...(config.platform === "win32" ? {
          windows: {
            hideConsole: true,
            title: name,
            version: metadata.version ?? packageMetadata.version,
            description: metadata.description ?? `${name} — native Tarve application`,
            ...(metadata.publisher ? { publisher: metadata.publisher } : {}),
            ...(metadata.copyright ? { copyright: metadata.copyright } : {}),
            ...(icoPath ? { icon: icoPath } : {}),
          },
        } : {}),
      },
    });
    if (!result.success) throw new AggregateError(result.logs, "Could not compile the Tarve application");
      if (macExecutable) {
      writeMacAppBundle(outfile, {
        executable: new Uint8Array(readFileSync(macExecutable)), nativeLibrary: libraryBytes, metadata,
        icon: metadata.icon ? new Uint8Array(readFileSync(metadata.icon)) : undefined,
      });
      // Plugin dylibs sit beside the runtime and are signed with the bundle.
      for (const embed of pluginPlan.embeds) {
        if (embed.fileName === config.nativeName) throw new Error(`Plugin ${embed.plugin}: its library cannot be named ${config.nativeName}.`);
        copyFileSync(embed.path, join(outfile, "Contents", "Frameworks", embed.fileName));
      }
      adHocSign(outfile);
    }
  } finally {
    if (options.compileJsx) await (await import("./jsx-compile")).closeJsxCompiler();
    await rm(packDirectory, { recursive: true, force: true });
    if (iconDirectory) await rm(iconDirectory, { recursive: true, force: true });
  }
  if (config.platform === "linux" && (metadata.icon || metadata.appId)) writeLinuxDesktopEntry(outfile, metadata, images?.png);
  return outfile;
}

/**
 * Apple silicon only runs signed code: on a Mac, sign the fresh bundle ad hoc so it starts locally
 * (TARVE_MACOS_ADHOC_SIGN=0 skips it). Distribution signing is `tarve release --sign`. Elsewhere
 * there is no codesign: the bundle must be signed on a Mac before it runs.
 */
function adHocSign(app: string): void {
  if (process.platform !== "darwin" || process.env.TARVE_MACOS_ADHOC_SIGN === "0") return;
  const result = spawnSync("codesign", ["--force", "--deep", "--sign", "-", app], { stdio: "ignore" });
  if (result.error || result.status !== 0) console.warn(`Tarve: ad-hoc codesign of ${app} failed; sign it before running it on Apple silicon.`);
}

/** Bun reports only "Bundle failed" when the output is a running executable (Windows locks it). */
function assertWritable(outfile: string): void {
  if (!existsSync(outfile)) return;
  try {
    closeSync(openSync(outfile, "r+"));
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "EBUSY" || code === "EPERM" || code === "EACCES") {
      throw new Error(`Cannot write ${outfile}: the file is in use. Close the running app and build again.`);
    }
    throw error;
  }
}

/** The metadata fields of build options, as overrides of package.json `tarve`. */
export function metadataOverrides(options: BuildOptions) {
  return { name: options.name, version: options.version, description: options.description, publisher: options.publisher, copyright: options.copyright, icon: options.icon, appId: options.appId };
}
/**
 * Points `nativeLibrary` at a library with only the native features the app uses: compiled
 * from a Tarve checkout with Cargo, otherwise the smallest prebuilt variant that covers them.
 */
async function withTrimmedNative(options: BuildOptions): Promise<{ options: BuildOptions; features?: NativeFeature[] }> {
  if (options.nativeLibrary) return { options };
  const features = await import("./native-features");
  const requested = features.parseNativeFeatures(options.nativeFeatures ?? process.env.TARVE_NATIVE_FEATURES);
  if (requested === "all") return { options };
  const target = options.target ?? hostBuildTarget();
  if (!target || !isBuildTarget(target)) return { options };
  const platform = targetConfig(target).platform;
  let required: NativeFeature[];
  if (requested === "auto") {
    try {
      const report = await features.detectNativeFeatures(options.entrypoint, platform);
      required = report.features;
      const listed = required.map(feature => `${feature} (${report.reasons[feature]})`);
      console.log(`Native features: ${listed.length ? listed.join(", ") : "core only"}`);
    } catch (error) {
      console.warn(`Tarve: could not detect native features (${(error as Error).message}); using the full library.`);
      return { options };
    }
  } else {
    required = requested;
    console.log(`Native features: ${required.length ? required.join(", ") : "core only"}`);
  }
  // TARVE_NATIVE_COMPILE=0: use the prebuilt variants even in a checkout with Cargo.
  if (process.env.TARVE_NATIVE_COMPILE !== "0" && features.canTrimNative(target)) {
    return { options: { ...options, nativeLibrary: await features.buildTrimmedNative(target, required) }, features: required };
  }
  // Trimming is an optimization: any failure here builds with the full library.
  const variant = await prebuiltVariant(target, required).catch((error: Error) => {
    console.warn(`Tarve: no prebuilt native variant (${error.message}); using the full library.`);
    return undefined;
  });
  if (variant) {
    console.log(`Native library: prebuilt "${variant.name}" variant`);
    return { options: { ...options, nativeLibrary: variant.path }, features: variant.features };
  }
  return { options };
}

/**
 * The smallest prebuilt variant library covering `required`, checked against this Tarve version.
 * Runs before the runtime split, so under Node.js too: no Bun APIs here.
 */
async function prebuiltVariant(target: BuildTarget, required: readonly NativeFeature[]): Promise<{ name: string; path: string; features: NativeFeature[] } | undefined> {
  const { nativeVariantPath, pickNativeVariant, variantFeatures } = await import("./native-features");
  const config = targetConfig(target);
  const variant = pickNativeVariant(required, config.platform);
  if (!variant) return undefined;
  const here = import.meta.dirname;
  let full: string | undefined;
  if (target === hostBuildTarget()) {
    try { full = nativePath(); } catch { /* No full library to sit next to. */ }
  }
  const directories = [
    ...full ? [dirname(full)] : [],
    resolve(here, "../../native", config.nativeDirectory),
    resolve(here, "native", config.nativeDirectory),
  ];
  const path = directories.map(directory => nativeVariantPath(directory, variant.name, config.nativeName)).find(existsSync);
  if (!path) return undefined;
  const packageMetadata = JSON.parse(readFileSync(resolve(here, "../../package.json"), "utf8")) as { version: string };
  try {
    const expected = existsSync(join(here, "src/index.ts"))
      ? await createNativeCompatibilityManifest(resolve(here, "../.."), packageMetadata.version)
      : await readNativeCompatibilityManifest(join(here, NATIVE_COMPATIBILITY_MANIFEST_NAME));
    await assertNativeRuntimeCompatible(path, target, expected);
  } catch (error) {
    console.warn(`Tarve: prebuilt "${variant.name}" native variant is unusable (${(error as Error).message}); using the full library.`);
    return undefined;
  }
  return { name: variant.name, path, features: variantFeatures(variant, config.platform) };
}
