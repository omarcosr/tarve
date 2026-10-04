import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, writeFileSync, readFileSync } from "node:fs";
import { mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, relative, resolve } from "node:path";
import { nativePath } from "#tarve/runtime";
import { fileImportAttributes } from "./esbuild-file-imports";
import { hostBuildTarget, targetConfig } from "./targets";
import type { BuildOptions } from "./build";
import { NATIVE_COMPATIBILITY_MANIFEST_NAME, assertNativeRuntimeCompatible, readNativeCompatibilityManifest, createNativeCompatibilityManifest } from "./native-runtime";
import { assertNodeVersion, targetNodeExecutable } from "./node-target";

export interface NodeBuildOptions extends BuildOptions {
  /** Node.js 26.10+ executable used to build the SEA. Defaults to the installed Node. */
  nodeExecutable?: string;
}

/** Bundle a TSX app and its native runtime into a Node.js single executable. */
export async function buildNode(options: NodeBuildOptions): Promise<string> {
  const target = options.target ?? hostBuildTarget();
  if (!target) throw new Error(`Unsupported Node.js build host: ${process.platform}-${process.arch}`);
  const config = targetConfig(target);
  const node = options.nodeExecutable ?? (process.versions.bun ? Bun.which("node") ?? "node" : process.execPath);
  const version = execFileSync(node, ["--version"], { encoding: "utf8" }).trim();
  const match = /^v(\d+)\.(\d+)\./.exec(version);
  if (!match || Number(match[1]) < 26 || (Number(match[1]) === 26 && Number(match[2]) < 10)) {
    throw new Error(`Node.js 26.10+ is required for node:ffi inside a SEA (found ${version})`);
  }
  const outfile = resolve(options.outfile ?? `dist/${options.name ?? basename(options.entrypoint).replace(/\.[^.]+$/, "")}${config.executableSuffix}`);

  let executable: string | undefined;
  if (options.targetExecutable) {
    executable = resolve(options.targetExecutable);
    if (!existsSync(executable)) throw new Error(`Target Node.js executable is missing: ${executable}`);
    assertNodeVersion(executable, version.slice(1));
  }
  const library = resolve(options.nativeLibrary ?? (target === hostBuildTarget()
    ? nativePath()
    : join(import.meta.dirname, "../../native", config.nativeDirectory, config.nativeName)));
  if (!existsSync(library)) throw new Error(`Tarve native library missing: ${library}`);
  const temporary = mkdtempSync(join(tmpdir(), "tarve-node-build-"));
  try {
    const root = import.meta.dirname;
    const source = existsSync(join(root, "src/index.ts"));
    if (!options.nativeLibrary && (!source || target !== hostBuildTarget())) {
      const expected = source
        ? await createNativeCompatibilityManifest(resolve(root, "../.."), (JSON.parse(readFileSync(resolve(root, "../../package.json"), "utf8")) as { version: string }).version)
        : await readNativeCompatibilityManifest(join(root, NATIVE_COMPATIBILITY_MANIFEST_NAME));
      await assertNativeRuntimeCompatible(library, target, expected);
    }
    if (!executable && target !== hostBuildTarget()) {
      executable = await targetNodeExecutable(target, version.slice(1));
    }
    // Build-time tools load lazily and stay external, so an app that imports
    // @tarve/core/build (e.g. Studio) still starts inside a Node single executable.
    const { build: bundle } = await import("esbuild");
    const result = await bundle({
      entryPoints: [resolve(options.entrypoint)],
      outfile: join(temporary, "app.mjs"),
      bundle: true,
      platform: "node",
      format: "esm",
      target: "node26",
      jsx: "automatic",
      jsxImportSource: "@tarve/core",
      loader: { ".png": "file", ".jpg": "file", ".jpeg": "file", ".webp": "file", ".gif": "file", ".svg": "file" },
      metafile: true,
      external: ["esbuild"],
      plugins: [fileImportAttributes, {
        name: "tarve-node-runtime",
        setup(build) {
          if (source) {
            build.onResolve({ filter: /^@tarve\/core(?:\/(?:jsx-runtime|jsx-dev-runtime))?$/ }, args => {
              const entry = args.path.slice("@tarve/core".length) || "/index";
              return { path: join(root, "src", `${entry.slice(1)}.ts`) };
            });
          }
          build.onResolve({ filter: /^#tarve\/runtime$/ }, () => ({ path: "native-runtime", namespace: "tarve-node" }));
          build.onLoad({ filter: /.*/, namespace: "tarve-node" }, () => ({
            contents: `import { join } from "node:path"; export function nativePath() { return join(import.meta.dirname, ${JSON.stringify(config.nativeName)}); }`,
            loader: "js",
          }));
        },
      }],
    });
    const assets: Record<string, string> = { [config.nativeName]: seaPath(library) };
    for (const [path, output] of Object.entries(result.metafile.outputs)) {
      if (!output.entryPoint) assets[relative(temporary, resolve(path)).replaceAll("\\", "/")] = seaPath(resolve(path));
    }
    const sea = join(temporary, "sea.json");
    writeFileSync(sea, JSON.stringify({
      main: seaPath(join(temporary, "app.mjs")), mainFormat: "module", output: seaPath(outfile),
      ...(executable ? { executable: seaPath(executable) } : {}),
      useVfs: true, useCodeCache: false, useSnapshot: false, assets,
      execArgv: ["--disable-warning=ExperimentalWarning"], execArgvExtension: "env",
    }));
    await mkdir(dirname(outfile), { recursive: true });
    // Rebuild in place like `bun build --compile`; Node refuses an existing SEA output.
    await rm(outfile, { force: true });
    execFileSync(node, ["--build-sea", sea], { stdio: "pipe" });
    if (config.platform === "win32") {
      const name = options.name ?? basename(options.entrypoint).replace(/\.[^.]+$/, "");
      const tarveVersion = (JSON.parse(readFileSync(resolve(root, "../../package.json"), "utf8")) as { version: string }).version;
      (await import("./windows-executable")).brandWindowsExecutable(outfile, { name, version: options.version ?? tarveVersion, filename: basename(outfile) });
    }
    return outfile;
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
}

function seaPath(path: string): string {
  return path.replaceAll("\\", "/");
}
