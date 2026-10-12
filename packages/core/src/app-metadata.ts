import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { nativeAssetPath } from "./embedded-assets";
import { encodeIco, isIco, pngSize } from "./png";

/** Set by `tarve run`/`tarve dev` (env) or baked into a `tarve build` executable (define). */
export interface RuntimeAppMetadata {
  name?: string;
  appId?: string;
  /** Path (run/dev) or data URL (built executables) of the app icon. */
  icon?: string;
}

let cached: RuntimeAppMetadata | undefined;

export function runtimeAppMetadata(): RuntimeAppMetadata {
  if (cached) return cached;
  const raw = typeof process === "undefined" ? undefined : process.env.TARVE_APP_METADATA;
  try {
    cached = raw ? JSON.parse(raw) as RuntimeAppMetadata : {};
  } catch {
    cached = {};
  }
  return cached;
}

/** The bytes of an icon given as a path (including embedded `with { type: "file" }` imports) or a data URL. */
export function iconBytes(icon: string): Uint8Array {
  if (icon.startsWith("data:")) {
    const comma = icon.indexOf(",");
    if (comma < 0) throw new TypeError("Invalid icon data URL");
    return new Uint8Array(Buffer.from(icon.slice(comma + 1), icon.slice(0, comma).endsWith(";base64") ? "base64" : "utf8"));
  }
  return new Uint8Array(readFileSync(nativeAssetPath(icon)));
}

/**
 * An .ico on disk for the Windows shell (app identity shortcut, IconUri): the
 * icon itself when it already is one, else a PNG wrapped as a one-entry .ico in
 * a per-user cache, so it outlives temporary directories.
 */
export function iconFileForShell(icon: string): string | undefined {
  if (!icon.startsWith("data:") && icon.toLowerCase().endsWith(".ico")) return resolve(nativeAssetPath(icon));
  const bytes = iconBytes(icon);
  if (isIco(bytes)) return writeCached(bytes);
  const size = pngSize(bytes);
  if (!size) return undefined;
  return writeCached(encodeIco([{ size: Math.min(256, Math.max(size.width, size.height)), png: bytes }]));
}

function writeCached(ico: Uint8Array): string {
  const base = process.env.LOCALAPPDATA ?? (homedir() ? join(homedir(), ".cache") : tmpdir());
  const directory = join(base, "tarve", "icons");
  const path = join(directory, createHash("sha256").update(ico).digest("hex").slice(0, 32) + ".ico");
  if (!existsSync(path)) {
    mkdirSync(directory, { recursive: true });
    writeFileSync(path, ico);
  }
  return path;
}
