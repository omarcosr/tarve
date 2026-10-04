import { expect, test } from "bun:test";
import { spawn } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { hostBuildTarget, targetConfig } from "./targets";
import { nativePath } from "./src/bridge/runtime";

const root = resolve(import.meta.dirname, "../..");
const node = Bun.which("node");
const version = node ? Bun.spawnSync([node, "--version"]).stdout.toString().trim() : "";
const supported = /^v(?:2[7-9]|[3-9]\d)\.|^v26\.(?:1\d|[2-9]\d)\./.test(version);

async function stagedPackage(directory: string): Promise<void> {
  const entries = [
    ["packages/core/src/index.ts", "index.js"],
    ["packages/core/src/jsx-runtime.ts", "jsx-runtime.js"],
    ["packages/core/src/bridge/runtime.ts", "runtime.js"],
    ["packages/core/src/embedded-assets.ts", "embedded-assets.js"],
    ["packages/core/cli.ts", "cli.js"],
  ];
  for (const [entry, naming] of entries) {
    const result = await Bun.build({
      entrypoints: [join(root, entry)], outdir: join(directory, "dist/npm"), naming,
      target: entry.endsWith("cli.ts") ? "node" : "bun",
      external: ["#tarve/runtime", "#tarve/assets", "esbuild", "resedit"],
    });
    if (!result.success) throw new AggregateError(result.logs, `Could not stage ${entry}`);
  }
  const target = hostBuildTarget();
  if (!target) throw new Error("Unsupported native target");
  const config = targetConfig(target);
  const native = join(directory, "native", config.nativeDirectory);
  mkdirSync(native, { recursive: true });
  copyFileSync(nativePath(), join(native, config.nativeName));
  writeFileSync(join(directory, "package.json"), JSON.stringify({
    name: "@tarve/core", type: "module",
    exports: { ".": "./dist/npm/index.js", "./jsx-runtime": "./dist/npm/jsx-runtime.js" },
    imports: { "#tarve/runtime": "./dist/npm/runtime.js", "#tarve/assets": "./dist/npm/embedded-assets.js" },
  }));
}

function source(version: string): string {
  return `import { render, Window, Text } from "@tarve/core";
const before = globalThis[Symbol.for("tarve.devApp")];
await render(() => <Window><Text>${version}</Text></Window>, { headless: true, renderer: "cpu" });
if (before && before !== globalThis[Symbol.for("tarve.devApp")]) throw new Error("Window recreated");
console.log("render:${version}:" + process.pid);`;
}

test.skipIf(!supported)("Node dev remounts the same window and process on TSX edits", async () => {
  const work = join(root, "work");
  mkdirSync(work, { recursive: true });
  const directory = mkdtempSync(join(work, "node-dev-"));
  let child: ReturnType<typeof spawn> | undefined;
  try {
    await stagedPackage(directory);
    const entry = join(directory, "dev.tsx");
    writeFileSync(entry, source("v1"));
    child = spawn(node!, [join(directory, "dist/npm/cli.js"), "dev", entry], {
      cwd: directory, stdio: ["ignore", "pipe", "pipe"],
      // `bun test` advertises Bun in the user agent; the CLI started with node must pick Node.
      env: { ...process.env, npm_config_user_agent: undefined },
    });
    let output = "";
    let errors = "";
    child.stdout!.on("data", chunk => { output += chunk.toString(); });
    child.stderr!.on("data", chunk => { errors += chunk.toString(); });
    const waitFor = async (text: string) => {
      const deadline = Date.now() + 15000;
      while (!output.includes(text) && Date.now() < deadline) {
        if (child?.exitCode !== null) break;
        await Bun.sleep(25);
      }
      expect(output, errors).toContain(text);
    };
    await waitFor("tarve dev: ready");
    const pid = /render:v1:(\d+)/.exec(output)?.[1];
    expect(pid).toBeDefined();
    await Bun.sleep(500);
    expect(output).not.toContain("tarve dev: remounted");
    expect(output.match(/render:v1:/g)).toHaveLength(1);
    writeFileSync(entry, source("v2"));
    await waitFor(`render:v2:${pid}`);
    await waitFor("tarve dev: remounted");
    writeFileSync(entry, "const broken = <Window");
    const deadline = Date.now() + 15000;
    while (!errors.includes("[ERROR]") && Date.now() < deadline) await Bun.sleep(25);
    expect(errors).toContain("[ERROR]");
    expect(child.exitCode).toBeNull();
    writeFileSync(entry, source("v3"));
    await waitFor(`render:v3:${pid}`);
    writeFileSync(entry, "throw new Error('runtime-reload-failure');");
    const runtimeDeadline = Date.now() + 15000;
    while (!errors.includes("runtime-reload-failure") && Date.now() < runtimeDeadline) await Bun.sleep(25);
    expect(errors).toContain("runtime-reload-failure");
    expect(child.exitCode).toBeNull();
    writeFileSync(entry, source("v4"));
    await waitFor(`render:v4:${pid}`);
    expect(output.match(/tarve dev: ready/g)).toHaveLength(1);
  } finally {
    if (child && child.exitCode === null) {
      child.kill();
      await new Promise<void>(resolve => child!.once("exit", () => resolve()));
    }
    rmSync(directory, { recursive: true, force: true });
  }
}, 60000);
