import { cp, mkdir, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join, resolve } from "node:path";

// Packs the published @tarve/core tarball from a clean staging directory so the
// consumer-facing package.json carries no repository scripts, workspaces or dev
// dependencies. Expects `bun run package` (or package:local) to have run.
const root = resolve(import.meta.dir, "..");
const dist = join(root, "dist");
const stage = join(dist, ".pack");

const PUBLISHED_FIELDS = [
  "name", "version", "description", "license", "keywords", "homepage", "repository", "bugs",
  "publishConfig", "bin", "files", "os", "cpu", "type", "imports", "exports", "engines",
] as const;

const manifest = await Bun.file(join(root, "package.json")).json() as Record<string, unknown> & { files: string[] };
const published = Object.fromEntries(
  PUBLISHED_FIELDS.filter(field => manifest[field] !== undefined).map(field => [field, manifest[field]]),
);

await rm(stage, { recursive: true, force: true });
await mkdir(stage, { recursive: true });
try {
  await writeFile(join(stage, "package.json"), `${JSON.stringify(published, null, 2)}\n`);
  for (const entry of manifest.files) {
    const source = join(root, entry);
    if (!existsSync(source)) throw new Error(`Packaged path is missing: ${entry}. Run \`bun run package\` first.`);
    await cp(source, join(stage, entry), { recursive: true });
  }
  const child = Bun.spawn([process.execPath, "pm", "pack", "--ignore-scripts", "--destination", dist], {
    cwd: stage, stdout: "inherit", stderr: "inherit",
  });
  if (await child.exited !== 0) throw new Error("bun pm pack failed");
} finally {
  await rm(stage, { recursive: true, force: true });
}
