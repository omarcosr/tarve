import { spawn } from "node:child_process";
import { closeSync, existsSync, mkdirSync, openSync, readdirSync, readSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { basename, join } from "node:path";
import { PACK_EXTENSION, importPackContentKey, importPackPublicKey, openPack, packCompatible, readPackFile, type PackHeader, type PackReader } from "./pack";
import { compareVersions, isValidVersion } from "./version";

/** What `tarve build --packs` bakes into the executable. */
export interface PackHostConfig {
  name: string;
  appId?: string;
  /** Version of the app embedded in the executable. */
  version: string;
  runtime: string;
  platform: string;
  /** Base64 raw Ed25519 key packs must be signed with. */
  publicKey: string;
  /** Base64 AES-256 key the packs' files are encrypted with. */
  contentKey: string;
  compat: string;
  features: string[];
}

/** The executable's side of a pack: its #tarve/runtime, its builtin modules and its location. */
export interface PackHostBindings {
  runtime: object;
  require(id: string): unknown;
  dirname: string;
  url: string;
}

/** What the running executable accepts, published for checkForUpdate and installUpdate. */
export interface PackHost extends Omit<PackHostConfig, "contentKey"> {
  /** Where installed packs live. */
  directory: string;
  /** Version of the pack running now; undefined when the embedded app runs. */
  active?: string;
}

/** A pack that started, then crashed within this time, is rolled back on the next launch. */
const CONFIRM_MS = 3000;
const HOST = Symbol.for("tarve.packHost");
const AsyncFunction = (async () => {}).constructor as new (...args: string[]) => (host: unknown) => Promise<void>;

export function packHost(): PackHost | undefined {
  return (globalThis as Record<symbol, PackHost | undefined>)[HOST];
}

/** Per-user folder for packs: always writable, even when the executable sits in a read-only folder. */
export function packDirectory(config: Pick<PackHostConfig, "name" | "appId" | "publicKey">): string {
  if (process.env.TARVE_PACK_DIRECTORY) return process.env.TARVE_PACK_DIRECTORY;
  const id = (config.appId ?? config.name).replace(/[<>:"/\\|?*\x00-\x1f]/g, "_");
  const base = process.platform === "win32"
    ? process.env.LOCALAPPDATA ?? join(homedir(), "AppData", "Local")
    : process.platform === "darwin"
      ? join(homedir(), "Library", "Application Support")
      : process.env.XDG_DATA_HOME ?? join(homedir(), ".local", "share");
  // Apps that share a name but not a key keep apart.
  return join(base, id, "packs", config.publicKey.replace(/[^A-Za-z0-9]/g, "").slice(0, 16));
}

export function packFile(directory: string, version: string): string {
  return join(directory, `${version}${PACK_EXTENSION}`);
}

/** `<version>.bad`: a pack that failed to start; `<version>.boot`: a pack starting for the first time. */
export function packMarker(directory: string, version: string, kind: "bad" | "boot"): string {
  return join(directory, `${version}.${kind}`);
}

/** Installed pack versions, newest first. */
export function installedPacks(directory: string): string[] {
  let names: string[];
  try {
    names = readdirSync(directory);
  } catch {
    return [];
  }
  return names
    .filter(name => name.endsWith(PACK_EXTENSION))
    .map(name => name.slice(0, -PACK_EXTENSION.length))
    .filter(isValidVersion)
    .sort((a, b) => compareVersions(b, a));
}

function remove(path: string): void {
  try { rmSync(path, { force: true }); } catch {}
}

function reject(directory: string, version: string, reason: string): void {
  console.error(`Tarve: app pack ${version} rejected: ${reason}`);
  try { writeFileSync(packMarker(directory, version, "bad"), reason); } catch {}
  remove(packMarker(directory, version, "boot"));
  remove(packFile(directory, version));
}

/** The message and stack of `error` (QuickJS stacks leave the message out). */
function describe(error: unknown): string {
  if (!(error instanceof Error)) return String(error);
  return error.stack?.includes(error.message) ? error.stack : `${error.message}\n${error.stack ?? ""}`;
}

function sizeOf(path: string): number | undefined {
  try { return statSync(path).size; } catch { return undefined; }
}

export function openPackFile(path: string): { read: PackReader; size: number; close(): void } {
  const size = statSync(path).size;
  const fd = openSync(path, "r");
  return {
    size,
    read(offset, length) {
      const bytes = new Uint8Array(length);
      for (let done = 0; done < length;) {
        const count = readSync(fd, bytes, done, length - done, offset + done);
        if (!count) throw new Error(`App pack is truncated: ${path}`);
        done += count;
      }
      return bytes;
    },
    close: () => closeSync(fd),
  };
}

/** Why `header` cannot run in this executable, or undefined when it can. */
export function packMismatch(header: PackHeader, host: Omit<PackHostConfig, "contentKey" | "publicKey">): string | undefined {
  if (header.name !== host.name) return `it belongs to ${header.name}, not ${host.name}`;
  if (header.runtime !== host.runtime || header.platform !== host.platform) {
    return `it targets ${header.runtime} on ${header.platform}, this executable is ${host.runtime} on ${host.platform}`;
  }
  if (!packCompatible(header.requires, host.compat, host.features)) {
    return "it needs a newer executable (another Tarve version, native features or plugin libraries)";
  }
  return undefined;
}

interface PreparedPack {
  header: PackHeader;
  code: string;
  assets: Record<string, string>;
}

/** Verifies the pack, decrypts its code and puts its assets in the shared asset cache. */
async function prepare(path: string, version: string, config: PackHostConfig): Promise<PreparedPack> {
  const file = openPackFile(path);
  try {
    const pack = await openPack(file.read, file.size, await importPackPublicKey(config.publicKey));
    const { header } = pack;
    if (header.version !== version) throw new Error(`it holds version ${header.version}`);
    const mismatch = packMismatch(header, config);
    if (mismatch) throw new Error(mismatch);
    const key = await importPackContentKey(config.contentKey);
    const code = new TextDecoder().decode(await readPackFile(pack, file.read, key, header.entry));
    const assets: Record<string, string> = {};
    for (const [name, entry] of Object.entries(header.files)) {
      if (name === header.entry) continue;
      const directory = join(tmpdir(), "tarve-assets", entry.sha256);
      const target = join(directory, basename(name));
      if (sizeOf(target) !== entry.length) {
        const bytes = await readPackFile(pack, file.read, key, name);
        mkdirSync(directory, { recursive: true });
        const temporary = `${target}.${crypto.randomUUID()}.tmp`;
        writeFileSync(temporary, bytes);
        try {
          renameSync(temporary, target);
        } catch (error) {
          remove(temporary);
          if (sizeOf(target) !== entry.length) throw error;
        }
      }
      assets[name] = target;
    }
    return { header, code, assets };
  } finally {
    file.close();
  }
}

function restart(): never {
  spawn(process.execPath, process.argv.slice(2), { detached: true, stdio: "ignore" }).unref();
  return process.exit(1);
}

/**
 * Runs the newest installed pack this executable can run and resolves true, or resolves false
 * so the executable runs the app it embeds. A pack is verified on every launch: its signature,
 * the hash of each file it reads, its version (newer than the embedded app) and its fit with
 * this executable. One that throws or crashes before it settles is marked bad, and the app
 * restarts on the pack before it or the embedded app.
 */
export async function bootPack(config: PackHostConfig, bindings: PackHostBindings): Promise<boolean> {
  const { contentKey: _, ...published } = config;
  const directory = packDirectory(config);
  const host: PackHost = { ...published, directory };
  (globalThis as Record<symbol, PackHost>)[HOST] = host;
  if (process.env.TARVE_PACKS === "0" || !existsSync(directory)) return false;
  for (const version of installedPacks(directory)) {
    const path = packFile(directory, version);
    if (compareVersions(version, config.version) <= 0 || existsSync(packMarker(directory, version, "bad"))) {
      remove(path);
      continue;
    }
    const boot = packMarker(directory, version, "boot");
    if (existsSync(boot)) {
      reject(directory, version, "it stopped while starting");
      continue;
    }
    let prepared: PreparedPack;
    try {
      prepared = await prepare(path, version, config);
    } catch (error) {
      console.error(`Tarve: app pack ${version} skipped: ${error instanceof Error ? error.message : String(error)}`);
      remove(path);
      continue;
    }
    writeFileSync(boot, "");
    host.active = version;
    let settled = false;
    const confirm = () => {
      if (settled) return;
      settled = true;
      remove(boot);
      for (const older of installedPacks(directory)) {
        if (compareVersions(older, version) < 0) remove(packFile(directory, older));
      }
    };
    const timer = setTimeout(confirm, CONFIRM_MS) as { unref?(): void };
    timer.unref?.();
    const globals = globalThis as { __tarveAssets?: Record<string, string> };
    globals.__tarveAssets = { ...globals.__tarveAssets, ...prepared.assets };
    const run = new AsyncFunction("__tarvePackHost", `"use strict";${prepared.code}\n//# sourceURL=tarve-pack:///${encodeURIComponent(config.name)}/${version}/${prepared.header.entry}`);
    try {
      await run({ ...bindings, meta: { url: bindings.url, dirname: bindings.dirname, main: true } });
    } catch (error) {
      if (settled) throw error;
      settled = true;
      reject(directory, version, describe(error));
      restart();
    }
    confirm();
    return true;
  }
  return false;
}
