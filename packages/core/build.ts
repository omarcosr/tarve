import type { BunPlugin } from "bun";
import { existsSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { nativePath } from "#tarve/runtime";

export interface BuildOptions {
  entrypoint: string;
  outfile?: string;
  name?: string;
  version?: string;
  /** Override for building the repository against a freshly compiled release library. */
  nativeLibrary?: string;
}

/** Compile an ordinary Tarve app. No production entrypoint or app-side bridge setup is needed. */
export async function build(options: BuildOptions): Promise<string> {
  if (!(["win32", "linux"] as NodeJS.Platform[]).includes(process.platform) || process.arch !== "x64") {
    throw new Error(`Tarve executable distribution is not supported for ${process.platform}-${process.arch}.`);
  }
  const entrypoint = resolve(options.entrypoint);
  const packageMetadata = await Bun.file(resolve(import.meta.dir, "../../package.json")).json() as { version?: string };
  if (typeof packageMetadata.version !== "string" || packageMetadata.version.length === 0) {
    throw new Error("Tarve package version is missing.");
  }
  const name = options.name ?? basename(entrypoint).replace(/\.[^.]+$/, "");
  const executableSuffix = process.platform === "win32" ? ".exe" : "";
  const outfile = resolve(options.outfile ?? `dist/${name}${executableSuffix}`);
  const library = resolve(options.nativeLibrary ?? nativePath());
  const nativeName = process.platform === "win32" ? "tarve_native.dll" : "libtarve_native.so";
  const compileTarget = process.platform === "win32" ? "bun-windows-x64" : "bun-linux-x64";
  const assetsModule = fileURLToPath(import.meta.resolve("#tarve/assets"));
  const sourceDirectory = join(import.meta.dir, "src");
  const repositorySource = existsSync(join(sourceDirectory, "index.ts"));
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
          `export function nativePath() { return materializeAsset(library, ${JSON.stringify(nativeName)}); }`,
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
      target: compileTarget,
      outfile,
      autoloadDotenv: false,
      autoloadBunfig: false,
      ...(process.platform === "win32" ? {
        windows: { hideConsole: true, title: name, version: options.version ?? packageMetadata.version, description: `${name} — native Tarve application` },
      } : {}),
    },
  });
  if (!result.success) throw new AggregateError(result.logs, "Could not compile the Tarve application");
  return outfile;
}
