import { existsSync } from "node:fs";
import { join, resolve } from "node:path";

const root = resolve(import.meta.dir, "..");
const metadata = await Bun.file(join(root, "package.json")).json();
const tarball = join(root, "dist", `tarve-${metadata.version}.tgz`);

async function run(args: string[], cwd: string): Promise<void> {
  const child = Bun.spawn([process.execPath, ...args], { cwd, stdout: "inherit", stderr: "inherit" });
  if (await child.exited !== 0) throw new Error(`Failed: bun ${args.join(" ")}`);
}

if (!existsSync(tarball)) await run(["run", "pack"], root);
// Install the npm artifact without recording a repository-relative file dependency.
await run(["add", "--no-save", tarball], join(root, "examples"));
