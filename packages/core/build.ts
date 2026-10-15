import type { BunPlugin } from "bun";
import { existsSync, mkdtempSync, writeFileSync } from "node:fs";
import { mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { nativePath } from "#tarve/runtime";
import { buildMetadata, writeLinuxDesktopEntry } from "./package-metadata";
import { frameworkPlugins } from "./framework-plugins";
import { BUILD_TARGETS, hostBuildTarget, isBuildTarget, targetConfig, type BuildTarget } from "./targets";
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
  target?: BuildTarget;
  /** Override for building the repository against a freshly compiled release library. */
  nativeLibrary?: string;
  /** "txiki": a txiki.js (QuickJS-ng) executable, no Bun or Node.js at run time. */
  runtime?: "bun" | "node" | "txiki";
  /** Experimental: compile JSX into reusable templates at build time (packages/core/jsx-compile.ts). Bun and txiki.js builds. */
  compileJsx?: boolean;
  /** Runtime binary for the target OS (Node.js or txiki.js); required when cross-compiling a Node SEA or txiki.js app. */
  targetExecutable?: string;
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
  if (options.runtime === "txiki") {
    const { buildTxiki } = await import("./txiki-build");
    return buildTxiki(options);
  }
  if (options.runtime === "node") {
    const { buildNode } = await import("./node-build");
    return buildNode(options);
  }
  const target = options.target ?? hostBuildTarget();
  if (!target) throw new Error(`Tarve executable distribution is not supported for ${process.platform}-${process.arch}. Pass an explicit supported target when cross-compiling.`);
  if (!isBuildTarget(target)) throw new TypeError(`Unsupported Tarve build target: ${String(target)}. Expected ${BUILD_TARGETS.join(" or ")}.`);
  const config = targetConfig(target);
  const entrypoint = resolve(options.entrypoint);
  const packageMetadata = await Bun.file(resolve(import.meta.dir, "../../package.json")).json() as { version?: string };
  if (typeof packageMetadata.version !== "string" || packageMetadata.version.length === 0) {
    throw new Error("Tarve package version is missing.");
  }
  const { metadata, images, define } = buildMetadata(entrypoint, metadataOverrides(options));
  const name = metadata.name;
  const outfile = resolve(options.outfile ?? `dist/${name}${config.executableSuffix}`);
  const library = resolveNativeLibrary(target, options.nativeLibrary);
  const assetsModule = fileURLToPath(import.meta.resolve("#tarve/assets"));
  const sourceDirectory = join(import.meta.dir, "src");
  const repositorySource = existsSync(join(sourceDirectory, "index.ts"));
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
  writeFileSync(packedLibrary, Bun.zstdCompressSync(libraryBytes, { level: NATIVE_ZSTD_LEVEL }));
  const runtime: BunPlugin = {
    name: "tarve-native-runtime",
    setup(builder) {
      if (repositorySource) {
        builder.onResolve({ filter: /^tarve$/ }, () => ({ path: join(sourceDirectory, "index.ts") }));
        builder.onResolve({ filter: /^tarve\/jsx-runtime$/ }, () => ({ path: join(sourceDirectory, "jsx-runtime.ts") }));
        builder.onResolve({ filter: /^tarve\/jsx-dev-runtime$/ }, () => ({ path: join(sourceDirectory, "jsx-dev-runtime.ts") }));
      }
      if (options.compileJsx) {
        builder.onLoad({ filter: /\.[jt]sx$/ }, async args => {
          if (/[\\/]node_modules[\\/]/.test(args.path) || args.path.startsWith(join(import.meta.dir, "src"))) return undefined;
          const { compileJsx } = await import("./jsx-compile");
          return { contents: (await compileJsx(await Bun.file(args.path).text())).code, loader: args.path.endsWith(".jsx") ? "jsx" : "tsx" };
        });
      }
      builder.onResolve({ filter: /^#tarve\/runtime$/ }, () => ({ path: "runtime", namespace: "tarve" }));
      builder.onLoad({ filter: /^runtime$/, namespace: "tarve" }, () => ({
        loader: "ts",
        contents: [
          `import library from ${JSON.stringify(packedLibrary)} with { type: "file" };`,
          `import { materializeAsset } from ${JSON.stringify(assetsModule)};`,
          `const digest = ${JSON.stringify(libraryDigest)};`,
          `export function nativePath() { return materializeAsset(library, ${JSON.stringify(config.nativeName)}, digest, "zstd"); }`,
        ].join("\n"),
      }));
    },
  };
  await mkdir(dirname(outfile), { recursive: true });
  // Bun reads the executable icon from a file.
  const iconDirectory = images && config.platform === "win32" ? mkdtempSync(join(tmpdir(), "tarve-icon-")) : undefined;
  const icoPath = iconDirectory ? join(iconDirectory, "app.ico") : undefined;
  if (icoPath) writeFileSync(icoPath, images!.ico);
  try {
    const result = await Bun.build({
      entrypoints: [entrypoint],
      target: "bun",
      plugins: [runtime, ...await frameworkPlugins<BunPlugin>(entrypoint)],
      define: { "process.env.NODE_ENV": JSON.stringify("production"), ...define },
      minify: true,
      compile: {
        target: config.bunTarget,
        outfile,
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
  } finally {
    if (options.compileJsx) await (await import("./jsx-compile")).closeJsxCompiler();
    await rm(packDirectory, { recursive: true, force: true });
    if (iconDirectory) await rm(iconDirectory, { recursive: true, force: true });
  }
  if (config.platform === "linux" && (metadata.icon || metadata.appId)) writeLinuxDesktopEntry(outfile, metadata, images?.png);
  return outfile;
}

/** The metadata fields of build options, as overrides of package.json `tarve`. */
export function metadataOverrides(options: BuildOptions) {
  return { name: options.name, version: options.version, description: options.description, publisher: options.publisher, copyright: options.copyright, icon: options.icon, appId: options.appId };
}
