import type { BunPlugin } from "bun";
import { mkdir } from "node:fs/promises";
import { basename, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { nativePath, workerPath } from "#tarve/runtime";

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
  if (process.platform !== "win32" || process.arch !== "x64") {
    throw new Error("Tarve executable distribution currently supports Windows x64.");
  }
  const entrypoint = resolve(options.entrypoint);
  const name = options.name ?? basename(entrypoint).replace(/\.[^.]+$/, "");
  const outfile = resolve(options.outfile ?? `dist/${name}.exe`);
  const library = resolve(options.nativeLibrary ?? nativePath());
  const assetsModule = fileURLToPath(import.meta.resolve("#tarve/assets"));
  const worker = await Bun.build({ entrypoints: [workerPath()], target: "bun", minify: true });
  if (!worker.success) throw new AggregateError(worker.logs, "Could not bundle the Tarve event Worker");
  const workerBytes = new Uint8Array(await worker.outputs[0].arrayBuffer());
  const runtime: BunPlugin = {
    name: "tarve-native-runtime",
    setup(builder) {
      builder.onResolve({ filter: /^#tarve\/runtime$/ }, () => ({ path: "runtime", namespace: "tarve" }));
      builder.onLoad({ filter: /^runtime$/, namespace: "tarve" }, () => ({
        loader: "ts",
        contents: [
          `import library from ${JSON.stringify(library)} with { type: "file" };`,
          'import worker from "tarve:worker" with { type: "file" };',
          `import { materializeAsset } from ${JSON.stringify(assetsModule)};`,
          'export function nativePath() { return materializeAsset(library, "tarve_native.dll"); }',
          'export function workerPath() { return materializeAsset(worker, "event-worker.js"); }',
        ].join("\n"),
      }));
      builder.onResolve({ filter: /^tarve:worker$/ }, () => ({ path: "event-worker.js", namespace: "tarve-worker" }));
      builder.onLoad({ filter: /.*/, namespace: "tarve-worker" }, () => ({ loader: "file", contents: workerBytes }));
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
      target: "bun-windows-x64",
      outfile,
      autoloadDotenv: false,
      autoloadBunfig: false,
      windows: { hideConsole: true, title: name, version: options.version ?? "0.1.0", description: `${name} — native Tarve application` },
    },
  });
  if (!result.success) throw new AggregateError(result.logs, "Could not compile the Tarve application");
  return outfile;
}
