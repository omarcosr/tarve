#!/usr/bin/env node
import { startServer } from "./cli-args";

try {
  process.exitCode = await startServer(process.argv.slice(2));
} catch (error) {
  process.stderr.write(`tarve-mcp: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
}
