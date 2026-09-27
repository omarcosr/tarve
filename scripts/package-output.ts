import { readdir, rm } from "node:fs/promises";
import { basename, join } from "node:path";

export interface PackageCleanupResult {
  removed: string[];
}

export async function cleanPackageOutputs(root: string, nativeTarget?: string): Promise<PackageCleanupResult> {
  const targets = [
    join(root, "dist", "npm"),
    join(root, "dist", "types"),
  ];
  if (nativeTarget) targets.push(join(root, "native", nativeTarget));
  const removed: string[] = [];

  for (const target of targets) {
    await rm(target, { recursive: true, force: true });
    removed.push(target);
  }

  const dist = join(root, "dist");
  try {
    for (const name of await readdir(dist)) {
      if (/^tarve-.*\.tgz$/i.test(name)) {
        const target = join(dist, name);
        await rm(target, { force: true });
        removed.push(target);
      }
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }

  return { removed: removed.map(path => basename(path)) };
}
