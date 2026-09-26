#!/usr/bin/env bun
import { parseArgs } from "node:util";
import { build } from "./build";

const { values, positionals } = parseArgs({
  args: process.argv.slice(2),
  allowPositionals: true,
  options: {
    outfile: { type: "string" },
    name: { type: "string" },
    version: { type: "string" },
    help: { type: "boolean", short: "h" },
  },
});
if (values.help || positionals.length === 0) {
  const defaultOutput = process.platform === "win32" ? "dist/App.exe" : "dist/App";
  console.log(`Usage: tarve build <app.tsx> [--outfile ${defaultOutput}] [--name App] [--version 1.0.0]`);
} else if (positionals[0] === "build" && positionals.length === 2) {
  console.log(await build({ entrypoint: positionals[1], ...values }));
} else {
  console.error("Expected: tarve build <app.tsx>. Use --help for options.");
  process.exitCode = 1;
}
