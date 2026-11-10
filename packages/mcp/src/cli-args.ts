import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { serveStdio } from "./server";
import { AppSession, type LaunchSpec } from "./session";
import { createTools } from "./tools";

export const VERSION = "0.10.0";

export const USAGE = `tarve-mcp: a Model Context Protocol server (stdio) that runs a Tarve app and lets an agent inspect, screenshot, drive and reload it.

Usage:
  tarve-mcp [options] <app.tsx>         start the app with \`tarve dev\` (hot reload)
  tarve-mcp [options] <dist/App.exe>    start a built app (\`tarve build\`, any runtime) as it is
  tarve-mcp [options] --exec <command...>  start the app with your own command (it must use @tarve/core)
                                        (\`-- <command...>\` too, where the runtime keeps \`--\`: Bun drops it)

Options:
  --run              \`tarve run\` instead of \`tarve dev\` (no hot reload)
  --runtime <name>   bun or node, passed to the tarve CLI
  --inspect          also open the visual inspector window
  --cwd <dir>        working directory of the app (default: the current one)
  --connect-timeout <ms>  how long the app may take to connect (default 60000)

MCP client config (Claude Desktop, Cursor, VS Code…):
  { "command": "bunx", "args": ["tarve-mcp", "src/app.tsx"] }`;

export interface McpArgs {
  entry?: string;
  command?: string[];
  mode: "dev" | "run";
  runtime?: string;
  inspect: boolean;
  cwd: string;
  connectTimeoutMs?: number;
  help: boolean;
}

export function parseArgs(argv: readonly string[], cwd = process.cwd()): McpArgs {
  const args: McpArgs = { mode: "dev", inspect: false, cwd, help: false };
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index]!;
    const value = (): string => {
      const next = argv[++index];
      if (next === undefined) throw new Error(`${arg} needs a value`);
      return next;
    };
    if (arg === "--" || arg === "--exec") { args.command = argv.slice(index + 1); break; }
    if (arg === "--help" || arg === "-h") args.help = true;
    else if (arg === "--run") args.mode = "run";
    else if (arg === "--dev") args.mode = "dev";
    else if (arg === "--inspect") args.inspect = true;
    else if (arg === "--runtime") args.runtime = value();
    else if (arg === "--cwd") args.cwd = resolve(cwd, value());
    else if (arg === "--connect-timeout") {
      const ms = Number(value());
      if (!Number.isFinite(ms) || ms <= 0) throw new Error("--connect-timeout needs a positive number of milliseconds");
      args.connectTimeoutMs = ms;
    } else if (arg.startsWith("-")) throw new Error(`Unknown option ${arg}`);
    else if (args.entry) throw new Error(`Unexpected argument ${arg}: give one app entry, or a command after --`);
    else args.entry = arg;
  }
  if (args.command && !args.command.length) throw new Error("Give the command after --exec");
  if (args.command && args.entry) throw new Error("Give an app entry or a command after --exec, not both");
  return args;
}

const readJson = (path: string): Record<string, unknown> | undefined => {
  try { return JSON.parse(readFileSync(path, "utf8")); } catch { return undefined; }
};

/**
 * How to run the tarve CLI the app's project uses, from `cwd` upwards: the installed
 * `node_modules/@tarve/core` CLI with this runtime, or, in the Tarve repository itself, its
 * source CLI, which runs on Bun like every repository script (`examples/node_modules/.bin/tarve`).
 * The app's own runtime is `--runtime`, whatever runs the CLI.
 */
export function findTarveCli(cwd: string): string[] | undefined {
  const binOf = (root: string, manifest: Record<string, unknown>): string | undefined => {
    const bin = manifest.bin;
    const path = typeof bin === "string" ? bin : bin && typeof bin === "object" ? (bin as Record<string, unknown>).tarve : undefined;
    return typeof path === "string" && existsSync(join(root, path)) ? join(root, path) : undefined;
  };
  for (let directory = resolve(cwd); ; directory = dirname(directory)) {
    const own = readJson(join(directory, "package.json"));
    if (own?.name === "@tarve/core") {
      const source = join(directory, "packages", "core", "cli.ts");
      if (existsSync(source)) return [process.versions.bun ? process.execPath : "bun", source];
      const built = binOf(directory, own);
      if (built) return [process.execPath, built];
    }
    const installed = join(directory, "node_modules", "@tarve", "core");
    const manifest = readJson(join(installed, "package.json"));
    const bin = manifest && binOf(installed, manifest);
    if (bin) return [process.execPath, bin];
    if (dirname(directory) === directory) return undefined;
  }
}

const SOURCE = /\.(?:[cm]?[jt]sx?|svelte)$/i;

export function resolveLaunch(args: McpArgs): LaunchSpec {
  const env: Record<string, string> = args.inspect ? { TARVE_INSPECTOR: "1" } : {};
  if (args.command) return { command: args.command[0]!, args: args.command.slice(1), cwd: args.cwd, env };
  if (!args.entry) throw new Error(`Give the app entry (tarve-mcp app.tsx) or a command after --exec\n\n${USAGE}`);
  const entry = resolve(args.cwd, args.entry);
  if (!existsSync(entry)) throw new Error(`${entry} does not exist`);
  // Not source: an executable \`tarve build\` made, which runs as it is.
  if (!SOURCE.test(entry)) return { command: entry, args: [], cwd: args.cwd, env };
  const cli = findTarveCli(args.cwd);
  if (!cli) throw new Error(`@tarve/core is not installed in ${args.cwd} or above: install it, or give the command after --exec`);
  return { command: cli[0]!, args: [...cli.slice(1), args.mode, entry, ...(args.runtime ? ["--runtime", args.runtime] : [])], cwd: args.cwd, env };
}

export const INSTRUCTIONS = `Drives a running Tarve desktop app (native window, not a browser).
Start with inspect_tree (or screenshot) to see the UI; target nodes by visible text or by the ids it shows.
click, hover, type_text, press_key, scroll and drag go through native hit testing and wait for the next frame.
Coordinates are window logical px. get_logs shows console output and errors; get_events the app's native events; get_metrics performance.
Source edits hot-reload in dev mode; call reload after a crash or a closed window.`;

/** Starts the app and serves MCP on stdio until stdin closes. */
export async function startServer(argv: readonly string[]): Promise<number> {
  const args = parseArgs(argv);
  if (args.help) {
    process.stderr.write(`${USAGE}\n`);
    return 0;
  }
  const session = new AppSession(resolveLaunch(args), { ...(args.connectTimeoutMs ? { connectTimeoutMs: args.connectTimeoutMs } : {}) });
  process.once("exit", () => session.killNow());
  const shutdown = () => { void session.dispose().finally(() => process.exit(0)); };
  process.once("SIGINT", shutdown);
  process.once("SIGTERM", shutdown);
  // The app opens while the client initializes; tools report a failed start.
  session.start().catch(error => process.stderr.write(`[tarve-mcp] ${error instanceof Error ? error.message : String(error)}\n`));
  await serveStdio(createTools(session), { name: "tarve", version: VERSION, instructions: INSTRUCTIONS });
  await session.dispose();
  return 0;
}
