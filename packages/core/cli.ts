#!/usr/bin/env bun
import { parseArgs } from "node:util";
import { build } from "./build";
import { BUILD_TARGETS, hostBuildTarget, isBuildTarget, targetConfig, type BuildTarget } from "./targets";

async function main(): Promise<void> {
  try {
    const { values, positionals } = parseArgs({
      args: process.argv.slice(2),
      allowPositionals: true,
      options: {
        outfile: { type: "string" },
        name: { type: "string" },
        version: { type: "string" },
        target: { type: "string" },
        help: { type: "boolean", short: "h" },
      },
    });
    if (values.help || positionals.length === 0) {
      const defaultTarget = values.target && isBuildTarget(values.target) ? values.target : hostBuildTarget();
      const defaultOutput = `dist/App${defaultTarget ? targetConfig(defaultTarget).executableSuffix : ""}`;
      console.log(`Usage: tarve build <app.tsx> [--target ${BUILD_TARGETS.join("|")}] [--outfile ${defaultOutput}] [--name App] [--version 1.0.0]`);
    } else if (positionals[0] === "build" && positionals.length === 2) {
      if (values.target !== undefined && !isBuildTarget(values.target)) {
        throw new Error(`Unsupported target: ${values.target}. Expected ${BUILD_TARGETS.join(" or ")}.`);
      }
      console.log(await build({
        entrypoint: positionals[1],
        ...values,
        target: values.target as BuildTarget | undefined,
      }));
    } else {
      throw new Error("Expected: tarve build <app.tsx>. Use --help for options.");
    }
  } catch (error) {
    console.error(`error: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  }
}

await main();
