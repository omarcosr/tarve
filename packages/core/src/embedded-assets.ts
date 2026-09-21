import { createHash, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";

const materialized = new Map<string, string>();

/** Native APIs cannot open Bun's virtual files. Resolve them once before sending the scene. */
export function nativeAssetPath(source: string): string {
  const path = isAbsolute(source) ? source : resolve(dirname(Bun.main), source);
  const normalized = path.replaceAll("\\", "/");
  if (normalized.startsWith("/$bunfs/") || /^[a-z]:\/~BUN\//i.test(normalized)) {
    return materializeAsset(path, basename(path));
  }
  return path;
}

/** Give native libraries a physical path for an asset embedded in a Bun executable. */
export function materializeAsset(source: string, filename: string): string {
  if (!filename || filename === "." || filename === ".." || basename(filename) !== filename) {
    throw new Error("An embedded asset filename must be a simple filename");
  }
  const key = `${source}\0${filename}`;
  const cached = materialized.get(key);
  if (cached) return cached;
  const bytes = readFileSync(source);
  const hash = createHash("sha256").update(bytes).digest("hex");
  const directory = join(tmpdir(), "tarve-assets", hash);
  const path = join(directory, filename);
  mkdirSync(directory, { recursive: true });
  if (!existsSync(path)) {
    // Publish only a complete file; simultaneous launches can reuse the same cache entry.
    const temporary = join(directory, `${filename}.${randomUUID()}.tmp`);
    try {
      writeFileSync(temporary, bytes, { flag: "wx" });
      try { renameSync(temporary, path); }
      catch (error) { if (!existsSync(path)) throw error; }
    } finally {
      rmSync(temporary, { force: true });
    }
  }
  const actual = createHash("sha256").update(readFileSync(path)).digest("hex");
  if (actual !== hash) throw new Error(`Embedded asset cache is corrupt. Remove this file and retry: ${path}`);
  materialized.set(key, path);
  return path;
}
