import { existsSync } from "node:fs";
import { chmod, copyFile, cp, mkdir, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";

const root = resolve(import.meta.dir, "..");

async function run(args: string[], cwd: string): Promise<void> {
  const child = Bun.spawn([process.execPath, ...args], { cwd, stdout: "inherit", stderr: "inherit" });
  if (await child.exited !== 0) throw new Error(`Failed: bun ${args.join(" ")}`);
}

// Rebuild the package staging tree before wiring examples to it. During repository
// development the product version commonly stays unchanged, so reusing a tarball or
// node_modules entry can otherwise leave the examples on an older CLI/runtime.
await run(["run", "package:local"], root);
const examples = join(root, "examples");
const modules = join(examples, "node_modules");
const packageLink = join(modules, "tarve");
const bin = join(modules, ".bin");
await mkdir(bin, { recursive: true });
await rm(packageLink, { recursive: true, force: true });
await mkdir(packageLink, { recursive: true });
const metadata = await Bun.file(join(root, "package.json")).json() as { files?: string[] };
if (!Array.isArray(metadata.files)) throw new Error("package.json files list is required to stage examples");
await copyFile(join(root, "package.json"), join(packageLink, "package.json"));
for (const entry of metadata.files) {
  const source = join(root, entry);
  if (!existsSync(source)) continue;
  await cp(source, join(packageLink, entry), { recursive: true });
}

// The repository is commonly shared between Windows and WSL, so the examples must
// remain runnable from either host after setup runs on either one. Keep both launchers
// instead of publishing only the shim for the host that happened to run setup.
for (const name of ["tarve", "tarve.exe", "tarve.bunx", "tarve.cmd"]) {
  await rm(join(bin, name), { force: true });
}
const launcher = join(bin, "tarve");
await writeFile(launcher, '#!/usr/bin/env bun\nimport "../tarve/dist/npm/cli.js";\n');
await writeFile(join(bin, "tarve.cmd"), '@echo off\r\nbun "%~dp0\\..\\tarve\\dist\\npm\\cli.js" %*\r\n');
if (process.platform !== "win32") await chmod(launcher, 0o755);
