#!/usr/bin/env node
import { spawn } from "node:child_process";
import { resolve } from "node:path";
import { parseArgs } from "node:util";
import { build } from "./build";
import { devNode, runNode } from "./node-dev";
import { selectRuntime } from "./runtime-select";
import { BUILD_TARGETS, hostBuildTarget, isBuildTarget, targetConfig, type BuildTarget } from "./targets";

const COMMANDS = ["run", "dev", "build"] as const;

function usage(target?: BuildTarget): string {
  const output = `dist/App${target ? targetConfig(target).executableSuffix : ""}`;
  return [
    "Usage: tarve <run|dev|build> <app.tsx> [options]",
    "",
    "  run    run the app",
    "  dev    run with hot reload into the same window",
    "  build  compile a standalone executable",
    "",
    "Options:",
    "  --runtime bun|node              defaults to the runtime that launched tarve",
    `  --target ${BUILD_TARGETS.join("|")}  build: target OS (cross-compiles)`,
    `  --outfile ${output}              build: output path`,
    "  --name App, --version 1.0.0     build: executable metadata",
    "  --target-executable path        build (node): target OS Node binary for offline cross-builds",
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
      target: { type: "string" }, runtime: { type: "string" },
      "target-executable": { type: "string" },
      help: { type: "boolean", short: "h" },
    },
  });
  const [command, entrypoint] = positionals;
  if (values.help || positionals.length === 0) {
    console.log(usage(values.target && isBuildTarget(values.target) ? values.target : hostBuildTarget()));
    return 0;
  }
  if (!COMMANDS.includes(command as typeof COMMANDS[number]) || !entrypoint || positionals.length !== 2) {
    throw new Error("Expected: tarve <run|dev|build> <app.tsx>. Use --help for options.");
  }
  if (values.target !== undefined && !isBuildTarget(values.target)) {
    throw new Error(`Unsupported target: ${values.target}. Expected ${BUILD_TARGETS.join(" or ")}.`);
  }
  const runtime = selectRuntime(values.runtime);
  // Bun apps need Bun: when bunx or `bun run` started this CLI under Node, hand over to Bun.
  if (runtime === "bun" && !process.versions.bun) {
    return forward("bun", [process.argv[1]!, ...process.argv.slice(2), "--runtime", "bun"]);
  }
  if (command === "build") {
    console.log(await build({
      entrypoint, outfile: values.outfile, name: values.name, version: values.version,
      target: values.target as BuildTarget | undefined,
      runtime,
      targetExecutable: values["target-executable"],
    }));
    return 0;
  }
  if (runtime === "node") {
    if (command === "dev") {
      await devNode(entrypoint);
      return 0;
    }
    return runNode(entrypoint);
  }
  const app = resolve(entrypoint);
  return command === "dev"
    ? forward(process.execPath, ["--hot", app], { ...process.env, TARVE_DEV: process.env.TARVE_DEV ?? "1" })
    : forward(process.execPath, [app]);
}

try {
  process.exitCode = await main();
} catch (error) {
  console.error(`error: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
}
