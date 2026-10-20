import { chmod, mkdir, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";

const root = resolve(import.meta.dir, "..");

async function run(args: string[], cwd: string): Promise<void> {
  const child = Bun.spawn([process.execPath, ...args], { cwd, stdout: "inherit", stderr: "inherit" });
  if (await child.exited !== 0) throw new Error(`Failed: bun ${args.join(" ")}`);
}

// Examples run the repository's source: examples/tsconfig.json maps @tarve/* to packages/*,
// and the native runtime comes from native/bin (bun run build:native) or TARVE_NATIVE.
// No package copy is staged, so nothing can lag behind the checkout.
const examples = join(root, "examples");
await run(["install", "--frozen-lockfile"], examples);
const modules = join(examples, "node_modules");
// @tarve/svelte's peer dependency installs the published @tarve/core: remove it so an
// import the path mapping misses fails loudly instead of loading an older release.
await rm(join(modules, "@tarve", "core"), { recursive: true, force: true });

// The repository is commonly shared between Windows and WSL, so the examples must
// remain runnable from either host after setup runs on either one. Keep both launchers.
const bin = join(modules, ".bin");
await mkdir(bin, { recursive: true });
for (const name of ["tarve", "tarve.exe", "tarve.bunx", "tarve.cmd"]) {
  await rm(join(bin, name), { force: true });
}
const launcher = join(bin, "tarve");
await writeFile(launcher, '#!/usr/bin/env bun\nimport "../../../packages/core/cli.ts";\n');
await writeFile(join(bin, "tarve.cmd"), '@echo off\r\nbun "%~dp0\\..\\..\\..\\packages\\core\\cli.ts" %*\r\n');
if (process.platform !== "win32") await chmod(launcher, 0o755);
