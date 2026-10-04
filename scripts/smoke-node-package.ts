import { strict as assert } from "node:assert";
import { copyFile, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { hostBuildTarget, targetConfig } from "../packages/core/targets";

const root = resolve(import.meta.dirname, "..");
const target = hostBuildTarget();
if (!target) throw new Error("Unsupported Node package smoke target");
const config = targetConfig(target);
const metadata = await Bun.file(join(root, "package.json")).json() as { version: string };
const tarball = process.env.TARVE_NODE_TARBALL ?? join(root, `dist/tarve-core-${metadata.version}.tgz`);
const directory = await mkdtemp(join(tmpdir(), "tarve-node-consumer-"));
const node = Bun.which("node") ?? "node";
const npm = process.platform === "win32" ? "npm.cmd" : "npm";

async function run(command: string[], timeoutMs = 60_000): Promise<void> {
  const env = { ...process.env };
  delete env.TARVE_NATIVE;
  // A Node-only consumer: the CLI must default to Node, not the Bun running this script.
  delete env.npm_config_user_agent;
  const child = Bun.spawn(command, { cwd: directory, env, stdout: "inherit", stderr: "inherit" });
  const timer = setTimeout(() => child.kill(), timeoutMs);
  try {
    assert.equal(await child.exited, 0, `Failed: ${command.join(" ")}`);
  } finally {
    clearTimeout(timer);
  }
}

try {
  await writeFile(join(directory, "package.json"), JSON.stringify({ name: "tarve-node-consumer", private: true, type: "module" }));
  await mkdir(join(directory, "assets"));
  await copyFile(join(root, "examples/node-smoke.tsx"), join(directory, "app.tsx"));
  await copyFile(join(root, "examples/assets/studio.png"), join(directory, "assets/studio.png"));
  await run([npm, "install", "--ignore-scripts", "--no-audit", "--no-fund", tarball], 240_000);
  const cli = join(directory, "node_modules/@tarve/core/dist/npm/cli.js");
  const app = join(directory, "app.tsx");
  await run([node, cli, "run", app]);
  const executable = join(directory, `NodeApp${config.executableSuffix}`);
  await run([node, cli, "build", app, "--outfile", executable]);
  await run([executable]);
  console.log("Tarve Node-only package smoke PASS");
} finally {
  await rm(directory, { recursive: true, force: true });
}
