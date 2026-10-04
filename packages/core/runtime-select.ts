export type AppRuntime = "bun" | "node";

/**
 * The runtime a `tarve` command uses: an explicit --runtime, otherwise the one
 * that launched it — Bun itself, or bunx/`bun run` (which may run the CLI with
 * Node because of its shebang but identify themselves in npm_config_user_agent).
 */
export function selectRuntime(
  flag: string | undefined,
  versions: NodeJS.ProcessVersions = process.versions,
  userAgent: string | undefined = process.env.npm_config_user_agent,
): AppRuntime {
  if (flag !== undefined) {
    if (flag !== "bun" && flag !== "node") throw new Error(`Unsupported runtime: ${flag}. Expected bun or node.`);
    return flag;
  }
  // The package manager that ran the script decides first: `bun install` writes
  // .bin shims that always launch Bun, even for `npm run`.
  // Under that shim process.versions describes Bun, so read Node's version from the agent.
  const launcher = /^(?:npm|pnpm|yarn)\/.*?\bnode\/v(\S+)/.exec(userAgent ?? "");
  if (launcher && supportsNodeRuntime(launcher[1])) return "node";
  if (versions.bun || /^bun\//.test(userAgent ?? "")) return "bun";
  // Before Node 26.10 (no node:ffi) tarve was Bun-only: keep npx/npm run on Bun there.
  return supportsNodeRuntime(versions.node) ? "node" : "bun";
}

export function supportsNodeRuntime(version: string | undefined): boolean {
  const [major = 0, minor = 0] = (version ?? "").split(".").map(Number);
  return major > 26 || (major === 26 && minor >= 10);
}
