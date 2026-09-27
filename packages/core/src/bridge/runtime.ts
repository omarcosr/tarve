import { existsSync, readFileSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { hostBuildTarget, targetConfig } from "../../targets";

function developmentLibrary(directory: string): string | undefined {
  const manifest = join(directory, "current.json");
  if (!existsSync(manifest)) return undefined;
  const { library } = JSON.parse(readFileSync(manifest, "utf8"));
  if (typeof library !== "string" || basename(library) !== library) throw new Error("Invalid Tarve native build manifest");
  return join(directory, library);
}

/** File resolution for development and npm installs; the app compiler embeds the native library. */
export function nativePath(): string {
  const target = hostBuildTarget();
  if (!target) throw new Error(`Unsupported native platform: ${process.platform}-${process.arch}`);
  const config = targetConfig(target);
  const name = config.nativeName;

  if (process.env.TARVE_NATIVE) return process.env.TARVE_NATIVE;

  // Inside the repository, prefer the content-addressed debug build published
  // by `bun run build:native`. Installed packages do not contain these locations.
  for (const directory of [
    resolve(import.meta.dir, "../../../../native/bin"),
    resolve(import.meta.dir, "../../native/bin"),
  ]) {
    const path = developmentLibrary(directory);
    if (path && existsSync(path)) return path;
  }

  const installed = [
    join(import.meta.dir, name),
    resolve(import.meta.dir, "../../native", config.nativeDirectory, name),
  ];
  const found = installed.find((path): path is string => !!path && existsSync(path));
  if (found) return found;
  for (const directory of [resolve("native/bin")]) {
    const path = developmentLibrary(directory) ?? join(directory, name);
    if (existsSync(path)) return path;
  }
  throw new Error(`Tarve native library missing for ${process.platform}-${process.arch}. In the repository, run bun run build:native.`);
}
