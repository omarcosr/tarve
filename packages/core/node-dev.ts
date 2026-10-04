import { fork, type ChildProcess, spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { context, build } from "esbuild";
import { nativePath } from "#tarve/runtime";
import type { Plugin } from "esbuild";
import { fileImportAttributes } from "./esbuild-file-imports";

/**
 * The app bundle lives in a temp directory, so modules that locate files next to
 * themselves (`@tarve/core/build`: native library, compatibility manifest, esbuild)
 * stay external and load from the installed package by absolute URL.
 */
const installedBuildApi: Plugin = {
  name: "tarve-installed-build-api",
  setup(build) {
    build.onResolve({ filter: /^@tarve\/core\/build$/ }, () => ({ path: import.meta.resolve("@tarve/core/build"), external: true }));
  },
};

export async function devNode(entrypoint: string): Promise<void> {
  const directory = mkdtempSync(join(tmpdir(), "tarve-node-dev-"));
  const app = join(directory, "app.mjs");
  const bootstrap = join(directory, "bootstrap.mjs");
  writeFileSync(bootstrap, `
import { pathToFileURL } from "node:url";
const entry = pathToFileURL(process.argv[2]).href;
let version = 0;
async function load() {
  await import(entry + "?v=" + version++);
  process.send?.({ type: "loaded", version });
}
function showError(error) {
  console.error(error);
  globalThis[Symbol.for("tarve.devApp")]?.remount(() => { throw error; });
}
let queue = Promise.resolve().then(load).catch(error => { console.error(error); process.exit(1); });
process.on("message", message => {
  if (message === "reload") queue = queue.then(load).catch(showError);
  if (message?.type === "build-error") showError(new Error(message.error));
});
process.on("disconnect", () => process.exit(0));
`);
  let child: ChildProcess | undefined;
  let readyToReload = false;
  // The first build and the watcher's own initial build both precede any edit.
  let builds = 0;
  const compiler = await context({
    entryPoints: [resolve(entrypoint)], outfile: app,
    bundle: true, platform: "node", format: "esm", target: "node26",
    jsx: "automatic", jsxImportSource: "@tarve/core",
    loader: { ".png": "file", ".jpg": "file", ".jpeg": "file", ".webp": "file", ".gif": "file", ".svg": "file" },
    plugins: [installedBuildApi, fileImportAttributes, {
      name: "tarve-node-hot",
      setup(build) {
        build.onEnd(result => {
          if (++builds <= 2 || !readyToReload || !child?.connected) return;
          if (result.errors.length) {
            child.send({ type: "build-error", error: result.errors.map(error => error.text).join("\n") });
          } else {
            child.send("reload");
          }
        });
      },
    }],
  });
  try {
    await compiler.rebuild();
    await compiler.watch();
    child = fork(bootstrap, [app], {
      execPath: nodeExecutable(),
      stdio: ["inherit", "inherit", "inherit", "ipc"],
      execArgv: ["--disable-warning=ExperimentalWarning"],
      env: { ...process.env, TARVE_DEV: "1", TARVE_HOT: "1", TARVE_NATIVE: nativePath(), TARVE_ENTRY: resolve(entrypoint) },
    });
    child.on("message", message => {
      if (typeof message === "object" && message && "version" in message) {
        if (Number(message.version) === 1) readyToReload = true;
        console.log(Number(message.version) === 1 ? "tarve dev: ready" : "tarve dev: remounted");
      }
    });
    const running = child;
    let stopping = false;
    const stop = () => { stopping = true; running.kill(); };
    process.on("SIGINT", stop);
    process.on("SIGTERM", stop);
    try {
      const code = await new Promise<number>((resolve, reject) => {
        running.once("error", reject);
        running.once("exit", (code, signal) => resolve(code ?? (signal ? 1 : 0)));
      });
      if (code !== 0 && !stopping) throw new Error(`Node application exited with code ${code}`);
    } finally {
      process.off("SIGINT", stop);
      process.off("SIGTERM", stop);
    }
  } finally {
    if (child && !child.killed && child.exitCode === null) child.kill();
    await compiler.dispose();
    rmSync(directory, { recursive: true, force: true });
  }
}
/** The Node.js executable for Node apps, also when the CLI itself runs under Bun. */
export function nodeExecutable(): string {
  return process.versions.bun ? (Bun.which("node") ?? "node") : process.execPath;
}
export async function runNode(entrypoint: string): Promise<number> {
  const directory = mkdtempSync(join(tmpdir(), "tarve-node-run-"));
  try {
    const app = join(directory, "app.mjs");
    await build({
      entryPoints: [resolve(entrypoint)], outfile: app,
      bundle: true, platform: "node", format: "esm", target: "node26",
      jsx: "automatic", jsxImportSource: "@tarve/core",
      loader: { ".png": "file", ".jpg": "file", ".jpeg": "file", ".webp": "file", ".gif": "file", ".svg": "file" },
      plugins: [installedBuildApi, fileImportAttributes],
    });
    const result = spawnSync(nodeExecutable(), ["--disable-warning=ExperimentalWarning", app], {
      stdio: "inherit",
      env: { ...process.env, TARVE_NATIVE: nativePath(), TARVE_ENTRY: resolve(entrypoint) },
    });
    if (result.error) throw result.error;
    return result.status ?? 1;
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}
