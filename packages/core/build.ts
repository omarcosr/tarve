import type { BunPlugin } from "bun";
import { existsSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { nativePath } from "#tarve/runtime";
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
  name?: string;
  version?: string;
  target?: BuildTarget;
  /** Override for building the repository against a freshly compiled release library. */
  nativeLibrary?: string;
  runtime?: "bun" | "node";
  /** Node.js binary for the target OS; required for cross-compiling a Node SEA. */
  targetExecutable?: string;
}

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
  const name = options.name ?? basename(entrypoint).replace(/\.[^.]+$/, "");
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
  const runtime: BunPlugin = {
    name: "tarve-native-runtime",
    setup(builder) {
      if (repositorySource) {
        builder.onResolve({ filter: /^tarve$/ }, () => ({ path: join(sourceDirectory, "index.ts") }));
        builder.onResolve({ filter: /^tarve\/jsx-runtime$/ }, () => ({ path: join(sourceDirectory, "jsx-runtime.ts") }));
        builder.onResolve({ filter: /^tarve\/jsx-dev-runtime$/ }, () => ({ path: join(sourceDirectory, "jsx-dev-runtime.ts") }));
      }
      builder.onResolve({ filter: /^#tarve\/runtime$/ }, () => ({ path: "runtime", namespace: "tarve" }));
      builder.onLoad({ filter: /^runtime$/, namespace: "tarve" }, () => ({
        loader: "ts",
        contents: [
          `import library from ${JSON.stringify(library)} with { type: "file" };`,
          `import { materializeAsset } from ${JSON.stringify(assetsModule)};`,
          `const digest = ${JSON.stringify(libraryDigest)};`,
          `export function nativePath() { return materializeAsset(library, ${JSON.stringify(config.nativeName)}, digest); }`,
        ].join("\n"),
      }));
    },
  };
  await mkdir(dirname(outfile), { recursive: true });
  const result = await Bun.build({
    entrypoints: [entrypoint],
    target: "bun",
    plugins: [runtime],
    define: { "process.env.NODE_ENV": JSON.stringify("production") },
    minify: true,
    compile: {
      target: config.bunTarget,
      outfile,
      autoloadDotenv: false,
      autoloadBunfig: false,
      ...(config.platform === "win32" ? {
        windows: { hideConsole: true, title: name, version: options.version ?? packageMetadata.version, description: `${name} — native Tarve application` },
      } : {}),
    },
  });
  if (!result.success) throw new AggregateError(result.logs, "Could not compile the Tarve application");
  return outfile;
}
