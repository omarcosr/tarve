import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { mkdir, rm } from "node:fs/promises";
import { builtinModules } from "node:module";
import { tmpdir } from "node:os";
import { basename, dirname, join, relative, resolve } from "node:path";
import { gzipSync } from "node:zlib";
import type { Plugin } from "esbuild";
import { nativePath } from "#tarve/runtime";
import { metadataOverrides, type BuildOptions } from "./build";
import { buildMetadata, writeLinuxDesktopEntry } from "./package-metadata";
import { hostBuildTarget, targetConfig } from "./targets";

export interface TxikiBuildOptions extends BuildOptions {
  /** txiki.js (tjs) used to compile the bundle. Defaults to TARVE_TXIKI, then `tjs` on PATH. */
  txikiExecutable?: string;
}

/** Trailer `tjs compile` appends: "tx1k1.js" and the u32 LE offset of its payload. */
const TXIKI_MAGIC = "tx1k1.js";
const BLOB_MAGIC = "TARVEBLB";
/** node:* modules with a txiki.js implementation, and the shim file of each. */
const NODE_SHIMS: Record<string, string> = {
  fs: "fs", "fs/promises": "fs-promises", path: "path", os: "os", crypto: "crypto", net: "net", module: "module", zlib: "zlib",
  events: "events", child_process: "child-process", "timers/promises": "timers-promises",
};
const ASSET = /\.(?:png|jpe?g|webp|gif|svg|ico|ttf|otf|woff2?)$/i;
/** Prefix of the string each unavailable() call site carries; one in the bundle fails the build. */
const UNAVAILABLE = "tarve-txiki-unavailable:";

interface EmbeddedFile { name: string; data: Uint8Array; gzip: boolean }

function findTxiki(explicit?: string): string {
  const candidate = explicit ?? process.env.TARVE_TXIKI ?? (process.versions.bun ? Bun.which("tjs") : undefined) ?? "tjs";
  try {
    execFileSync(candidate, ["--version"], { stdio: "pipe" });
  } catch {
    throw new Error(`txiki.js was not found (${candidate}). Install it (winget install Saghul.TxikiJS) or set TARVE_TXIKI.`);
  }
  return candidate;
}

/** The executable `tjs` copies for `tjs compile` is itself: the path behind a shim or link. */
function txikiBinary(tjs: string): string {
  return execFileSync(tjs, ["eval", "console.log(tjs.exePath)"], { encoding: "utf8" }).trim();
}

/**
 * Bundle a TSX app for txiki.js (QuickJS-ng + libuv) and fuse it, with the native
 * runtime and assets, into one executable: no Bun or Node.js at run time.
 *
 * Layout: [txiki.js][files][index JSON][u32 index length][u32 0]["TARVEBLB"][tjs payload]["tx1k1.js"][u32 payload offset]
 */
export async function buildTxiki(options: TxikiBuildOptions): Promise<string> {
  const target = options.target ?? hostBuildTarget();
  if (!target) throw new Error(`Unsupported txiki.js build host: ${process.platform}-${process.arch}`);
  const config = targetConfig(target);
  const tjs = findTxiki(options.txikiExecutable);
  const host = txikiBinary(tjs);
  const base = options.targetExecutable ? resolve(options.targetExecutable) : host;
  if (target !== hostBuildTarget() && !options.targetExecutable) {
    throw new Error(`Cross-compiling for ${target} needs targetExecutable: the txiki.js ${execFileSync(tjs, ["--version"], { encoding: "utf8" }).trim()} binary for that platform.`);
  }
  if (!existsSync(base)) throw new Error(`txiki.js executable is missing: ${base}`);
  const { metadata, images, define } = buildMetadata(options.entrypoint, metadataOverrides(options));
  const outfile = resolve(options.outfile ?? `dist/${metadata.name}${config.executableSuffix}`);
  const library = resolve(options.nativeLibrary ?? (target === hostBuildTarget()
    ? nativePath()
    : join(import.meta.dirname, "../../native", config.nativeDirectory, config.nativeName)));
  if (!existsSync(library)) throw new Error(`Tarve native library missing: ${library}`);

  const temporary = mkdtempSync(join(tmpdir(), "tarve-txiki-build-"));
  try {
    const root = import.meta.dirname;
    const source = existsSync(join(root, "src/index.ts"));
    const assets: EmbeddedFile[] = [];
    // node:* names the app imports that no shim provides, found by a first bundle attempt.
    const missing = new Map<string, Set<string>>();
    const importers = new Map<string, Set<string>>();
    const runtime: Plugin = {
      name: "tarve-txiki-runtime",
      setup(build) {
        build.onResolve({ filter: /^tjs:/ }, args => ({ path: args.path, external: true }));
        build.onResolve({ filter: /^(?:node:)?[a-z_]+(?:\/[a-z_]+)?$/ }, args => {
          const name = args.path.replace(/^node:/, "");
          // Bundled packages (the npm build of @tarve/core) import builtins without "node:".
          if (!NODE_SHIMS[name] && !args.path.startsWith("node:") && !builtinModules.includes(name)) return undefined;
          if (!importers.has(name)) importers.set(name, new Set());
          importers.get(name)!.add(args.importer);
          return { path: name, namespace: "tarve-node", sideEffects: false };
        });
        build.onResolve({ filter: /^#tarve\/runtime$/ }, () => ({ path: join(root, "txiki/runtime.ts") }));
        if (source) {
          build.onResolve({ filter: /^(?:@tarve\/core(?:-internal)?|tarve)(?:\/(?:jsx-runtime|jsx-dev-runtime))?$/ }, args => {
            const entry = args.path.replace(/^(?:@tarve\/core(?:-internal)?|tarve)/, "") || "/index";
            return { path: join(root, "src", `${entry.slice(1)}.ts`) };
          });
        }
        build.onResolve({ filter: /.*/ }, args => {
          const type = args.with?.type ?? (ASSET.test(args.path) && args.kind === "import-statement" ? "file" : undefined);
          if (type !== "file" && type !== "text") return undefined;
          return { path: resolve(dirname(args.importer), args.path), namespace: `tarve-${type}` };
        });
        // node:<name>: the shim's exports plus an unavailable() placeholder per name it lacks.
        // Tooling the app never reaches (test-renderer, visual-testing) tree-shakes away with them.
        build.onLoad({ filter: /.*/, namespace: "tarve-node" }, args => {
          const shim = NODE_SHIMS[args.path] && JSON.stringify(join(root, "txiki/shims", `${NODE_SHIMS[args.path]}.ts`));
          const placeholder = (api: string) => `/* @__PURE__ */ unavailable(${JSON.stringify(`${UNAVAILABLE}node:${api}`)})`;
          return {
            contents: [
              `import { unavailable } from ${JSON.stringify(join(root, "txiki/unavailable.ts"))};`,
              ...shim ? [`export * from ${shim};`, `export { default } from ${shim};`] : [`export default ${placeholder(args.path)};`],
              ...[...missing.get(args.path) ?? []].map(name => `export const ${name} = ${placeholder(`${args.path}.${name}`)};`),
            ].join("\n"),
            loader: "js",
            resolveDir: root,
          };
        });
        if (options.compileJsx) {
          build.onLoad({ filter: /\.[jt]sx$/ }, async args => {
            if (/[\\/]node_modules[\\/]/.test(args.path) || args.path.startsWith(join(root, "src"))) return undefined;
            const { compileJsx } = await import("./jsx-compile");
            return { contents: (await compileJsx(readFileSync(args.path, "utf8"))).code, loader: args.path.endsWith(".jsx") ? "jsx" : "tsx", resolveDir: dirname(args.path) };
          });
        }
        build.onLoad({ filter: /.*/, namespace: "tarve-text" }, args => ({ contents: readFileSync(args.path, "utf8"), loader: "text" }));
        build.onLoad({ filter: /.*/, namespace: "tarve-file" }, args => {
          const data = readFileSync(args.path);
          const name = `${createHash("sha256").update(data).digest("hex").slice(0, 12)}-${basename(args.path)}`;
          if (!assets.some(asset => asset.name === name)) assets.push({ name, data, gzip: false });
          // The prelude extracts every embedded file before app modules evaluate.
          return { contents: `export default globalThis.__tarveAssets[${JSON.stringify(name)}];`, loader: "js" };
        });
      },
    };
    const entry = join(temporary, "entry.ts");
    writeFileSync(entry, [
      `import ${JSON.stringify(join(root, "txiki/prelude.ts"))};`,
      `import ${JSON.stringify(resolve(options.entrypoint))};`,
    ].join("\n"));
    const bundle = join(temporary, "app.js");
    const { build: esbuild } = await import("esbuild");
    const bundleApp = () => esbuild({
      entryPoints: [entry],
      outfile: bundle,
      bundle: true,
      platform: "neutral",
      mainFields: ["module", "main"],
      format: "esm",
      target: "es2023",
      minify: !process.env.TARVE_TXIKI_DEBUG,
      jsx: "automatic",
      jsxImportSource: "@tarve/core",
      logLevel: "silent",
      define: {
        ...define,
        "process.env.NODE_ENV": JSON.stringify("production"),
        "import.meta.dirname": "globalThis.__tarveDirname",
        TARVE_TXIKI_PLATFORM: JSON.stringify(config.platform),
        TARVE_TXIKI_NATIVE_NAME: JSON.stringify(config.nativeName),
      },
      plugins: [runtime],
      metafile: !!process.env.TARVE_TXIKI_DEBUG,
    });
    // A name a shim lacks is a build error; record it, then bundle again with a placeholder for it.
    for (let attempt = 0; ; attempt++) {
      try {
        const result = await bundleApp();
        if (process.env.TARVE_TXIKI_DEBUG) writeFileSync(`${process.env.TARVE_TXIKI_DEBUG}.meta.json`, JSON.stringify(result.metafile));
        break;
      } catch (error) {
        const errors = (error as { errors?: { text: string }[] }).errors ?? [];
        const lacking = errors.map(({ text }) => /^No matching export in "tarve-node:([^"]+)" for import "([^"]+)"$/.exec(text));
        if (!lacking.length || lacking.some(match => !match) || attempt > 3) throw error;
        for (const match of lacking) {
          if (!missing.has(match![1]!)) missing.set(match![1]!, new Set());
          missing.get(match![1]!)!.add(match![2]!);
        }
      }
    }
    assertAvailable(readFileSync(bundle, "utf8"), importers);

    // TARVE_TXIKI_DEBUG=<file>: keep a readable bundle there (and <file>.meta.json, the esbuild metafile);
    // `tjs run <file>` gives real stack lines.
    if (process.env.TARVE_TXIKI_DEBUG) writeFileSync(process.env.TARVE_TXIKI_DEBUG, readFileSync(bundle));
    const compiled = join(temporary, `compiled${config.executableSuffix}`);
    execFileSync(tjs, ["compile", bundle, compiled], { stdio: "pipe" });
    const payload = txikiPayload(readFileSync(compiled), readFileSync(host).byteLength);

    const executable = join(temporary, `base${config.executableSuffix}`);
    writeFileSync(executable, readFileSync(base));
    if (config.platform === "win32") {
      const tarveVersion = (JSON.parse(readFileSync(resolve(root, "../../package.json"), "utf8")) as { version: string }).version;
      (await import("./windows-executable")).brandWindowsExecutable(executable, {
        name: metadata.name,
        version: metadata.version ?? tarveVersion,
        filename: basename(outfile),
        description: metadata.description,
        publisher: metadata.publisher,
        copyright: metadata.copyright,
        ico: images?.ico,
      });
    }
    const files: EmbeddedFile[] = [{ name: config.nativeName, data: readFileSync(library), gzip: true }, ...assets];
    await mkdir(dirname(outfile), { recursive: true });
    await rm(outfile, { force: true });
    writeFileSync(outfile, fuse(readFileSync(executable), files, payload));
    if (config.platform !== "win32") chmodSync(outfile, 0o755);
    if (config.platform === "linux" && (metadata.icon || metadata.appId)) writeLinuxDesktopEntry(outfile, metadata, images?.png);
    return outfile;
  } finally {
    if (options.compileJsx) await (await import("./jsx-compile")).closeJsxCompiler();
    await rm(temporary, { recursive: true, force: true });
  }
}

/** Fails the build when a placeholder for a missing Node API survived tree shaking: the app would throw at run time. */
export function assertAvailable(bundle: string, importers: ReadonlyMap<string, ReadonlySet<string>> = new Map()): void {
  const apis = [...new Set([...bundle.matchAll(new RegExp(`${UNAVAILABLE}node:([\\w/.-]+)`, "g"))].map(match => match[1]!))].sort();
  // The Bun global: a use counts unless a typeof Bun check precedes it closely (`typeof Bun<"u"&&Bun.main`).
  const bun = [...new Set([...bundle.matchAll(/(?<![\w$.])Bun\.([A-Za-z_$][\w$]*)/g)]
    .filter(match => !bundle.slice(Math.max(0, match.index! - 400), match.index).includes("typeof Bun"))
    .map(match => `Bun.${match[1]}`))].sort();
  if (!apis.length && !bun.length) return;
  const lines = apis.map(api => {
    const [module, name] = api.split(".") as [string, string | undefined];
    // Narrow to files that mention the name; esbuild reports imports per module, not per name.
    const users = [...importers.get(module) ?? []]
      .filter(file => !name || !existsSync(file) || new RegExp(`\\b${name}\\b`).test(readFileSync(file, "utf8")))
      .map(file => relative(process.cwd(), file).replaceAll("\\", "/"));
    return `  node:${api}${users.length ? `  (imported by ${users.slice(0, 3).join(", ")}${users.length > 3 ? ", …" : ""})` : ""}`;
  });
  throw new Error([
    "This app reaches APIs the txiki.js runtime does not provide:",
    ...lines,
    ...bun.map(api => `  ${api}  (the Bun global; guard it with typeof Bun !== "undefined")`),
    "Remove those calls from code the app can run, or build with --runtime bun or --runtime node.",
  ].join("\n"));
}

/** The bytecode `tjs compile` appended to its own binary, without the trailer. */
export function txikiPayload(compiled: Uint8Array, hostSize: number): Uint8Array {
  const trailer = compiled.subarray(compiled.length - 12);
  const offset = new DataView(trailer.buffer, trailer.byteOffset, 12).getUint32(8, true);
  if (new TextDecoder().decode(trailer.subarray(0, 8)) !== TXIKI_MAGIC || offset !== hostSize) {
    throw new Error("Unrecognized `tjs compile` output; this txiki.js version is not supported.");
  }
  return compiled.subarray(offset, compiled.length - 12);
}

export function fuse(executable: Uint8Array, files: readonly EmbeddedFile[], payload: Uint8Array): Uint8Array {
  const parts: Uint8Array[] = [executable];
  const index: object[] = [];
  let offset = executable.length;
  for (const file of files) {
    const stored = file.gzip ? gzipSync(file.data, { level: 9 }) : file.data;
    index.push({ name: file.name, offset, length: stored.length, size: file.data.length, sha256: createHash("sha256").update(file.data).digest("hex"), gzip: file.gzip });
    parts.push(stored);
    offset += stored.length;
  }
  const json = new TextEncoder().encode(JSON.stringify(index));
  const header = new Uint8Array(16);
  new DataView(header.buffer).setUint32(0, json.length, true);
  header.set(new TextEncoder().encode(BLOB_MAGIC), 8);
  parts.push(json, header);
  const payloadOffset = offset + json.length + header.length;
  const trailer = new Uint8Array(12);
  trailer.set(new TextEncoder().encode(TXIKI_MAGIC));
  new DataView(trailer.buffer).setUint32(8, payloadOffset, true);
  parts.push(payload, trailer);
  const out = new Uint8Array(parts.reduce((size, part) => size + part.length, 0));
  let position = 0;
  for (const part of parts) {
    out.set(part, position);
    position += part.length;
  }
  return out;
}
