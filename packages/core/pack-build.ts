import { createHash, hkdfSync, sign } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { mkdir, rm } from "node:fs/promises";
import { builtinModules } from "node:module";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { Plugin } from "esbuild";
import type { BuildOptions } from "./build";
import { frameworkPlugins } from "./framework-plugins";
import { NATIVE_FEATURES, detectNativeFeatures, parseNativeFeatures, type NativeFeature } from "./native-features";
import { NATIVE_COMPATIBILITY_MANIFEST_NAME, createNativeCompatibilityManifest, readNativeCompatibilityManifest } from "./native-runtime";
import { buildMetadata, resolveAppMetadata } from "./package-metadata";
import { pluginNativesForBuild } from "./plugins-build";
import { hostBuildTarget, isBuildTarget, targetConfig, type BuildTarget } from "./targets";
import { PACK_EXTENSION, encodePack, importPackContentKey, type PackSource } from "./src/pack";
import type { PackHostConfig } from "./src/pack-host";
import { isValidVersion } from "./src/version";
import { loadUpdatePrivateKey, privateKeyObject, updatePublicKey } from "./updates-build";

export type PackRuntime = "bun" | "node" | "txiki";

export interface PackOptions extends BuildOptions {
  /** Update private key (base64 or a file holding it): signs the pack and derives its encryption key. */
  updateKey: string;
}

/** The app's code inside a pack. */
const ENTRY = "app.js";
/** txiki.js modules an executable lends its packs; other `tjs:` imports fail the pack build. */
const TXIKI_HOST_MODULES = ["tjs:ffi", "tjs:hashing", "tjs:path"];
const ASSET = /\.(?:png|jpe?g|webp|gif|svg|ico|ttf|otf|woff2?)$/i;
const CORE = /^(?:@tarve\/core(?:-internal)?|tarve)(?:\/(?:jsx-runtime|jsx-dev-runtime))?$/;
const HOST = "__tarvePackHost";
/** `import.meta` inside a pack: the pack is a function body, the executable's module stands in. */
const META_DEFINE = {
  "import.meta": `${HOST}.meta`,
  "import.meta.url": `${HOST}.url`,
  "import.meta.dirname": `${HOST}.dirname`,
  "import.meta.dir": `${HOST}.dirname`,
  "import.meta.require": `${HOST}.require`,
};

interface PackKeys {
  publicKey: string;
  /** Base64 AES-256 key, derived from the private key and the app name. */
  contentKey: string;
  sign(bytes: Uint8Array): Uint8Array;
}

function packKeys(updateKey: string, name: string): PackKeys {
  const text = loadUpdatePrivateKey(updateKey);
  const key = privateKeyObject(text);
  if (key.asymmetricKeyType !== "ed25519") throw new Error("Update private key must be Ed25519 (tarve keygen)");
  const seed = Buffer.from(key.export({ format: "jwk" }).d!, "base64url");
  return {
    publicKey: updatePublicKey(text),
    contentKey: Buffer.from(hkdfSync("sha256", seed, "tarve-pack-v1", `content-key:${name}`, 32)).toString("base64"),
    sign: bytes => new Uint8Array(sign(null, bytes, key)),
  };
}

function resolveTarget(target: BuildTarget | undefined): BuildTarget {
  const resolved = target ?? hostBuildTarget();
  if (!resolved || !isBuildTarget(resolved)) throw new Error(`Unsupported app pack target: ${String(resolved ?? `${process.platform}-${process.arch}`)}`);
  return resolved;
}

function platformOf(target: BuildTarget): string {
  const config = targetConfig(target);
  return `${config.platform}-${config.arch}`;
}

function sourceCheckout(): boolean {
  return existsSync(join(import.meta.dirname, "src/index.ts"));
}

/**
 * Everything a pack's code binds to in its executable, hashed: Tarve's native ABI (package
 * version, protocol, ABI, native source), the runtime, the target and the plugins' libraries.
 */
async function packCompat(entrypoint: string, target: BuildTarget, runtime: PackRuntime): Promise<string> {
  const root = import.meta.dirname;
  const native = sourceCheckout()
    ? await createNativeCompatibilityManifest(resolve(root, "../.."), (JSON.parse(readFileSync(resolve(root, "../../package.json"), "utf8")) as { version: string }).version)
    : await readNativeCompatibilityManifest(join(root, NATIVE_COMPATIBILITY_MANIFEST_NAME));
  const plugins = pluginNativesForBuild(entrypoint, target).embeds.map(embed => `${embed.plugin}/${embed.fileName}/${embed.sha256}`).sort();
  return createHash("sha256").update(JSON.stringify({
    packageVersion: native.packageVersion,
    protocolVersion: native.protocolVersion,
    nativeAbiVersion: native.nativeAbiVersion,
    sourceFingerprint: native.sourceFingerprint,
    runtime,
    target,
    plugins,
  })).digest("hex");
}

function appIdentity(options: BuildOptions, command: string): { name: string; appId?: string; version: string } {
  const metadata = resolveAppMetadata(options.entrypoint, {
    name: options.name, version: options.version, description: options.description, publisher: options.publisher,
    copyright: options.copyright, appId: options.appId,
  });
  if (!metadata.version || !isValidVersion(metadata.version)) {
    throw new Error(`${command} needs a version (--version 1.2.0 or package.json "version"): packs only replace older apps.`);
  }
  return { name: metadata.name, ...(metadata.appId ? { appId: metadata.appId } : {}), version: metadata.version };
}

/**
 * What `tarve build --packs` bakes into the executable: the keys, and what it offers packs.
 * `features` are the native subsystems of its library; undefined means the full library.
 */
export async function hostPackConfig(options: BuildOptions, runtime: PackRuntime, features: readonly NativeFeature[] | undefined): Promise<PackHostConfig> {
  if (!options.updateKey) throw new Error("App packs need the update private key (tarve keygen).");
  const target = resolveTarget(options.target);
  const app = appIdentity(options, "tarve build --packs");
  const keys = packKeys(options.updateKey, app.name);
  return {
    ...app,
    runtime,
    platform: platformOf(target),
    publicKey: keys.publicKey,
    contentKey: keys.contentKey,
    compat: await packCompat(options.entrypoint, target, runtime),
    features: [...features ?? NATIVE_FEATURES],
  };
}

/**
 * The executable's entry module: it runs the newest installed pack, else the embedded app.
 * Packs reach the executable's builtin modules through it (on txiki.js, the `tjs:` modules).
 */
export function writeHostEntry(directory: string, entrypoint: string, config: PackHostConfig): string {
  const lines = [
    `import { bootPack } from ${JSON.stringify(fileURLToPath(import.meta.resolve("#tarve/pack-host")))};`,
    `import * as runtime from "#tarve/runtime";`,
  ];
  let require: string;
  if (config.runtime === "txiki") {
    TXIKI_HOST_MODULES.forEach((id, index) => lines.push(`import * as m${index} from ${JSON.stringify(id)};`));
    // A pack imports each through a CommonJS stub, whose default import is the whole object:
    // the module's default export merged with its named ones serves both kinds of import.
    lines.push(`const lend = module => ({ ...module, ...typeof module.default === "object" ? module.default : {} });`);
    lines.push(`const modules = { ${TXIKI_HOST_MODULES.map((id, index) => `${JSON.stringify(id)}: lend(m${index})`).join(", ")} };`);
    require = "id => { if (Object.hasOwn(modules, id)) return modules[id]; throw new Error(`This executable does not provide ${id} to app packs`); }";
  } else {
    require = "id => { const module = process.getBuiltinModule(id); if (!module) throw new Error(`No builtin module ${id}`); return module; }";
  }
  lines.push(
    `if (!await bootPack(${JSON.stringify(config)}, { runtime, require: ${require}, dirname: import.meta.dirname, url: import.meta.url })) {`,
    `  await import(${JSON.stringify(resolve(entrypoint))});`,
    `}`,
  );
  const path = join(directory, "tarve-pack-host.ts");
  writeFileSync(path, lines.join("\n"));
  return path;
}

async function packFeatures(options: BuildOptions, target: BuildTarget): Promise<string[]> {
  const requested = parseNativeFeatures(options.nativeFeatures ?? process.env.TARVE_NATIVE_FEATURES);
  if (requested === "all") return [...NATIVE_FEATURES];
  if (requested === "auto") return (await detectNativeFeatures(options.entrypoint, targetConfig(target).platform)).features;
  return [...requested];
}

/** Bun and Node.js packs: builtins come from the executable, files are stored in the pack. */
async function bundleForRuntime(options: BuildOptions, runtime: "bun" | "node", define: Record<string, string>, temporary: string): Promise<{ code: string; assets: PackSource[] }> {
  const root = import.meta.dirname;
  const source = sourceCheckout();
  const assets: PackSource[] = [];
  const plugin: Plugin = {
    name: "tarve-pack",
    setup(build) {
      if (source) {
        build.onResolve({ filter: CORE }, args => {
          const entry = args.path.replace(/^(?:@tarve\/core(?:-internal)?|tarve)/, "") || "/index";
          return { path: join(root, "src", `${entry.slice(1)}.ts`) };
        });
      }
      build.onResolve({ filter: /^#tarve\/runtime$/ }, () => ({ path: "#tarve/runtime", namespace: "tarve-pack-host" }));
      build.onResolve({ filter: /^(?:node:|bun:|bun$|[a-z_]+(?:\/[a-z_]+)?$)/ }, args => {
        const builtin = args.path.startsWith("node:") || args.path.startsWith("bun:") || args.path === "bun" || builtinModules.includes(args.path);
        return builtin ? { path: args.path, namespace: "tarve-pack-host" } : undefined;
      });
      build.onLoad({ filter: /.*/, namespace: "tarve-pack-host" }, args => ({
        contents: args.path === "#tarve/runtime" ? `module.exports = ${HOST}.runtime;` : `module.exports = ${HOST}.require(${JSON.stringify(args.path)});`,
        loader: "js",
      }));
      if (options.compileJsx) {
        build.onLoad({ filter: /\.[jt]sx$/ }, async args => {
          if (/[\\/]node_modules[\\/]/.test(args.path) || args.path.startsWith(join(root, "src"))) return undefined;
          const { compileJsx } = await import("./jsx-compile");
          return { contents: (await compileJsx(readFileSync(args.path, "utf8"))).code, loader: args.path.endsWith(".jsx") ? "jsx" : "tsx", resolveDir: dirname(args.path) };
        });
      }
      build.onResolve({ filter: /.*/ }, args => {
        const type = args.with?.type ?? (ASSET.test(args.path) && args.kind === "import-statement" ? "file" : undefined);
        if (type !== "file" && type !== "text") return undefined;
        return { path: resolve(dirname(args.importer), args.path), namespace: `tarve-pack-${type}` };
      });
      build.onLoad({ filter: /.*/, namespace: "tarve-pack-text" }, args => ({ contents: readFileSync(args.path, "utf8"), loader: "text" }));
      // The executable extracts each file before the pack runs, as txiki.js executables do.
      build.onLoad({ filter: /.*/, namespace: "tarve-pack-file" }, args => {
        const data = readFileSync(args.path);
        const name = `${createHash("sha256").update(data).digest("hex").slice(0, 12)}-${basename(args.path)}`;
        if (!assets.some(asset => asset.path === name)) assets.push({ path: name, data });
        return { contents: `export default globalThis.__tarveAssets[${JSON.stringify(name)}];`, loader: "js" };
      });
    },
  };
  const entry = join(temporary, "pack-entry.ts");
  writeFileSync(entry, `import ${JSON.stringify(resolve(options.entrypoint))};`);
  const outfile = join(temporary, ENTRY);
  const { build: esbuild } = await import("esbuild");
  await esbuild({
    entryPoints: [entry],
    outfile,
    bundle: true,
    format: "esm",
    platform: "node",
    target: runtime === "node" ? "node26" : "esnext",
    conditions: runtime === "bun" ? ["bun"] : [],
    jsx: "automatic",
    jsxImportSource: "@tarve/core",
    // TARVE_PACK_DEBUG=1: readable code in the pack, for stack traces.
    minify: !process.env.TARVE_PACK_DEBUG,
    // Function.name stays what the source says (component names in the inspector, errors).
    keepNames: true,
    logLevel: "silent",
    define: { ...define, ...META_DEFINE, "process.env.NODE_ENV": JSON.stringify("production") },
    // Build-time tools load lazily (Studio imports @tarve/core/build), as in Node.js executables.
    external: ["esbuild"],
    plugins: [plugin, ...await frameworkPlugins(options.entrypoint)],
  });
  return { code: readFileSync(outfile, "utf8"), assets };
}

/** txiki.js packs: the same bundle as a txiki.js executable, minus the prelude its executable already ran. */
async function bundleForTxiki(options: BuildOptions, target: BuildTarget, define: Record<string, string>, temporary: string): Promise<{ code: string; assets: PackSource[] }> {
  const { NODE_SHIMS, bundleQuickJs } = await import("./txiki-build");
  const root = import.meta.dirname;
  const config = targetConfig(target);
  const stub = (name: string, contents: string) => {
    const path = join(temporary, `${name}.cjs`);
    writeFileSync(path, contents);
    return path;
  };
  const { bundle, assets } = await bundleQuickJs(options, {
    label: "txiki.js",
    runtimeModule: stub("runtime", `module.exports = ${HOST}.runtime;`),
    shims: Object.fromEntries(Object.entries(NODE_SHIMS).map(([name, file]) => [name, join(root, "txiki/shims", `${file}.ts`)])),
    tjs: Object.fromEntries(TXIKI_HOST_MODULES.map(id => [id, stub(id.replace(":", "-"), `module.exports = ${HOST}.require(${JSON.stringify(id)});`)])),
    define: {
      ...define,
      ...META_DEFINE,
      "import.meta.dirname": "globalThis.__tarveDirname",
      TARVE_TXIKI_PLATFORM: JSON.stringify(config.platform),
      TARVE_TXIKI_NATIVE_NAME: JSON.stringify(config.nativeName),
    },
  }, temporary);
  return { code: readFileSync(bundle, "utf8"), assets: assets.map(asset => ({ path: asset.name, data: asset.data })) };
}

/**
 * Builds `<name>-<version>-<platform>-<runtime>.tarve`: the app's code and files, signed and
 * encrypted, for executables built with `tarve build --packs` of the same Tarve version and runtime.
 */
export async function buildPack(options: PackOptions): Promise<string> {
  const runtime: PackRuntime = options.runtime ?? "bun";
  const target = resolveTarget(options.target);
  const app = appIdentity(options, "tarve pack");
  const platform = platformOf(target);
  const keys = packKeys(options.updateKey, app.name);
  const { define } = buildMetadata(options.entrypoint, {
    name: options.name, version: options.version, description: options.description, publisher: options.publisher,
    copyright: options.copyright, icon: options.icon, appId: options.appId,
  });
  const outfile = resolve(options.outfile ?? `dist/${app.name}-${app.version}-${platform}-${runtime}${PACK_EXTENSION}`);
  const temporary = mkdtempSync(join(tmpdir(), "tarve-pack-"));
  try {
    const [{ code, assets }, compat, features] = await Promise.all([
      runtime === "txiki" ? bundleForTxiki(options, target, define, temporary) : bundleForRuntime(options, runtime, define, temporary),
      packCompat(options.entrypoint, target, runtime),
      packFeatures(options, target),
    ]);
    const bytes = await encodePack({
      name: app.name,
      version: app.version,
      runtime,
      platform,
      requires: { compat, features },
      entry: ENTRY,
      files: [{ path: ENTRY, data: new TextEncoder().encode(code) }, ...assets],
      contentKey: await importPackContentKey(keys.contentKey),
      sign: keys.sign,
    });
    await mkdir(dirname(outfile), { recursive: true });
    writeFileSync(outfile, bytes);
    return outfile;
  } finally {
    if (options.compileJsx) await (await import("./jsx-compile")).closeJsxCompiler();
    await rm(temporary, { recursive: true, force: true });
  }
}
