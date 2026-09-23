import { existsSync, readFileSync } from "node:fs";
import { basename, join, resolve } from "node:path";

function developmentLibrary(directory: string): string | undefined {
  const manifest = join(directory, "current.json");
  if (!existsSync(manifest)) return undefined;
  const { library } = JSON.parse(readFileSync(manifest, "utf8"));
  if (typeof library !== "string" || basename(library) !== library) throw new Error("Invalid Tarve native build manifest");
  return join(directory, library);
}

/** File resolution for development and npm installs; the app compiler embeds the native library. */
export function nativePath(): string {
  const names: Record<string, string> = {
    win32: "tarve_native.dll",
    darwin: "libtarve_native.dylib",
    linux: "libtarve_native.so",
  };
  const name = names[process.platform];
  if (!name) throw new Error(`Unsupported native platform: ${process.platform}`);
  const installed = [
    process.env.TARVE_NATIVE,
    join(import.meta.dir, name),
    resolve(import.meta.dir, "../../native", `${process.platform}-${process.arch}`, name),
  ];
  const found = installed.find((path): path is string => !!path && existsSync(path));
  if (found) return found;
  for (const directory of [resolve(import.meta.dir, "../../../../native/bin"), resolve("native/bin")]) {
    const path = developmentLibrary(directory) ?? join(directory, name);
    if (existsSync(path)) return path;
  }
  throw new Error(`Tarve native library missing for ${process.platform}-${process.arch}. In the repository, run bun run build:native.`);
}
