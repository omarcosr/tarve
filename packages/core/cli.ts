#!/usr/bin/env node
import { spawn } from "node:child_process";
import { resolve } from "node:path";
import { parseArgs } from "node:util";
import { resolveAppMetadata, runtimeMetadata } from "./package-metadata";
import { build, smolExecArgv } from "./build";
import { devNode, runNode } from "./node-dev";
import { selectRuntime } from "./runtime-select";
import { frameworkPreloads } from "./framework-plugins";
import { generateUpdateKeys, release } from "./updates-build";
import { BUILD_TARGETS, hostBuildTarget, isBuildTarget, targetConfig, type BuildTarget } from "./targets";
import { existsSync, writeFileSync } from "node:fs";

const COMMANDS = ["run", "dev", "build"] as const;
const KEY_FILE = "tarve-update.key";

function usage(target?: BuildTarget): string {
  const output = `dist/App${target ? targetConfig(target).executableSuffix : ""}`;
  return [
    "Usage: tarve <run|dev|build> <app.tsx> [options]",
    "       tarve keygen",
    "       tarve release --version 1.2.0 --artifact win32-x64=dist/App.exe [...]",
    "",
    "  run      run the app",
    "  dev      run with hot reload into the same window",
    "  build    compile a standalone executable",
    `  keygen   create an update signing key pair (writes ${KEY_FILE}, prints the public key)`,
    "  release  copy built executables to --out and write the signed latest.json",
    "",
    "Options:",
    "  --runtime bun|node|txiki        defaults to the runtime that launched tarve; txiki: build only",
    `  --target ${BUILD_TARGETS.join("|")}  build: target OS (cross-compiles)`,
    `  --outfile ${output}              build: output path`,
    "  --compile-jsx                   build: compile JSX into reusable templates (needs typescript 7)",
    "  --smol                          smaller JS heap, collected more often (bun, node)",
    "  --name App, --version 1.0.0     app metadata (executable, window, app identity)",
    "  --icon icon.png                 app icon: .png (square, 256 px+) or .ico",
    "  --app-id Acme.App               Windows AppUserModelID / Linux app id",
    "  --description, --publisher, --copyright  build: executable details",
    "                                  each defaults to the \"tarve\" field of package.json",
    "  --target-executable path        build (node): target OS Node binary for offline cross-builds",
    "  --artifact platform=path        release: repeatable, platform is <os>-<arch> (win32-x64, linux-x64)",
    `  --key ${KEY_FILE}          release: private key file or base64 (default: TARVE_UPDATE_PRIVATE_KEY, then ./${KEY_FILE})`,
    "  --public-key base64             release: verify the signed manifest before writing it",
    "  --out dist/updates              release: output directory; keygen: where the key goes",
    "  --base-url https://host/path/   release: artifact URL prefix (default: relative to latest.json)",
    "  --notes text                    release: release notes",
    "  --sign \"signtool sign … {file}\"  release: Authenticode command per Windows artifact, before hashing",
    "                                  (default: TARVE_SIGN_COMMAND)",
  ].join("\n");
}

/** Run a child process with inherited stdio and resolve with its exit code. */
function forward(command: string, args: string[], env: NodeJS.ProcessEnv = process.env): Promise<number> {
  return new Promise((resolveCode, reject) => {
    const child = spawn(command, args, { stdio: "inherit", env });
    const stop = () => child.kill();
    process.on("SIGINT", stop);
    process.on("SIGTERM", stop);
    child.once("error", error => {
      reject((error as NodeJS.ErrnoException).code === "ENOENT"
        ? new Error(command === "bun"
          ? "Bun was not found. Install Bun, or run with Node.js 26.10+ and --runtime node."
          : `${command} was not found. Install it or choose the other runtime with --runtime.`)
        : error);
    });
    child.once("exit", (code, signal) => {
      process.off("SIGINT", stop);
      process.off("SIGTERM", stop);
      resolveCode(code ?? (signal ? 1 : 0));
    });
  });
}

async function main(): Promise<number> {
  const { values, positionals } = parseArgs({
    args: process.argv.slice(2),
    allowPositionals: true,
    options: {
      outfile: { type: "string" }, name: { type: "string" }, version: { type: "string" },
      icon: { type: "string" }, "app-id": { type: "string" }, description: { type: "string" },
      publisher: { type: "string" }, copyright: { type: "string" },
      target: { type: "string" }, runtime: { type: "string" }, "compile-jsx": { type: "boolean" }, smol: { type: "boolean" },
      "target-executable": { type: "string" },
      artifact: { type: "string", multiple: true }, key: { type: "string" }, "public-key": { type: "string" },
      out: { type: "string" }, "base-url": { type: "string" }, notes: { type: "string" }, sign: { type: "string" },
      help: { type: "boolean", short: "h" },
    },
  });
  const [command, entrypoint] = positionals;
  if (values.help || positionals.length === 0) {
    console.log(usage(values.target && isBuildTarget(values.target) ? values.target : hostBuildTarget()));
    return 0;
  }
  if (command === "keygen") return keygen(values.out);
  if (command === "release") {
    if (!values.version) throw new Error("tarve release needs --version.");
    const privateKey = values.key ?? process.env.TARVE_UPDATE_PRIVATE_KEY ?? (existsSync(KEY_FILE) ? KEY_FILE : undefined);
    if (!privateKey) throw new Error(`tarve release needs --key, TARVE_UPDATE_PRIVATE_KEY or ./${KEY_FILE} (tarve keygen).`);
    console.log(release({
      version: values.version, artifacts: values.artifact ?? [], privateKey, publicKey: values["public-key"],
      outDir: values.out, baseUrl: values["base-url"], name: values.name, notes: values.notes,
      sign: values.sign ?? process.env.TARVE_SIGN_COMMAND,
    }));
    return 0;
  }
  if (!COMMANDS.includes(command as typeof COMMANDS[number]) || !entrypoint || positionals.length !== 2) {
    throw new Error("Expected: tarve <run|dev|build> <app.tsx>. Use --help for options.");
  }
  if (values.target !== undefined && !isBuildTarget(values.target)) {
    throw new Error(`Unsupported target: ${values.target}. Expected ${BUILD_TARGETS.join(" or ")}.`);
  }
  // txiki.js only runs compiled executables: there is no `tarve run|dev` on it.
  const txiki = values.runtime === "txiki";
  if (txiki && command !== "build") throw new Error("--runtime txiki is only supported by tarve build.");
  const runtime = txiki ? "txiki" : selectRuntime(values.runtime);
  // Bun apps need Bun: when bunx or `bun run` started this CLI under Node, hand over to Bun.
  if (runtime === "bun" && !process.versions.bun) {
    return forward("bun", [process.argv[1]!, ...process.argv.slice(2), "--runtime", "bun"]);
  }
  if (command === "build") {
    console.log(await build({
      entrypoint, outfile: values.outfile, name: values.name, version: values.version,
      icon: values.icon, appId: values["app-id"], description: values.description,
      publisher: values.publisher, copyright: values.copyright,
      target: values.target as BuildTarget | undefined,
      runtime,
      compileJsx: values["compile-jsx"],
      smol: values.smol,
      targetExecutable: values["target-executable"],
    }));
    return 0;
  }
  // The app reads its name, id and icon from here (a built executable has them baked in).
  const metadata = resolveAppMetadata(entrypoint, { name: values.name, icon: values.icon, appId: values["app-id"] });
  process.env.TARVE_APP_METADATA = runtimeMetadata(metadata, metadata.icon);
  if (runtime === "node") {
    if (command === "dev") {
      await devNode(entrypoint, values.smol ? smolExecArgv("node") : []);
      return 0;
    }
    return runNode(entrypoint, values.smol ? smolExecArgv("node") : []);
  }
  const app = resolve(entrypoint);
  const smol = values.smol ? smolExecArgv("bun") : [];
  return command === "dev"
    ? forward(process.execPath, [...smol, ...frameworkPreloads(app), "--hot", app], { ...process.env, TARVE_DEV: process.env.TARVE_DEV ?? "1" })
    : forward(process.execPath, [...smol, ...frameworkPreloads(app), app]);
}

try {
  process.exitCode = await main();
} catch (error) {
  console.error(`error: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
}
function keygen(outDir = "."): number {
  const path = resolve(outDir, KEY_FILE);
  if (existsSync(path)) throw new Error(`${path} already exists; delete it to replace the key (installed apps reject updates signed with a new one).`);
  const keys = generateUpdateKeys();
  writeFileSync(path, keys.privateKey + "\n", { mode: 0o600 });
  console.log(`private key: ${path} (keep it secret and out of git)`);
  console.log(`public key:  ${keys.publicKey}`);
  return 0;
}
