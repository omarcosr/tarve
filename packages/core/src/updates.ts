import { createHash, createPublicKey, verify } from "node:crypto";
import { spawn } from "node:child_process";
import { accessSync, chmodSync, closeSync, constants, copyFileSync, createWriteStream, existsSync, openSync, readSync, renameSync, rmSync, statSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { runtimeAppMetadata } from "./app-metadata";

/** One downloadable build of a release, keyed by `<platform>-<arch>` (e.g. `win32-x64`). */
export interface UpdateArtifact {
  url: string;
  sha256: string;
  size: number;
}

/** What `tarve release` signs: the release and one artifact per platform. */
export interface UpdateManifest {
  name?: string;
  version: string;
  notes?: string;
  pubDate: string;
  platforms: Record<string, UpdateArtifact>;
}

/** The file served at the update URL: the manifest as signed text plus its Ed25519 signature (base64). */
export interface SignedUpdateManifest {
  payload: string;
  signature: string;
}

export interface Update extends UpdateArtifact {
  version: string;
  currentVersion: string;
  notes?: string;
  pubDate: string;
  platform: string;
}

export interface CheckForUpdateOptions {
  /** URL of the signed manifest (`latest.json`). HTTPS, or HTTP on localhost. */
  url: string;
  /** Ed25519 public key from `tarve keygen` (base64, 32 bytes). */
  publicKey: string;
  /** Defaults to the version baked in by `tarve build`. */
  currentVersion?: string;
  /** Defaults to `${process.platform}-${process.arch}`. */
  platform?: string;
  /** Reject a manifest released under another name; defaults to the app name baked in by `tarve build`. */
  name?: string;
  /** Accept plain HTTP from hosts other than localhost (the manifest is still signed). */
  allowInsecure?: boolean;
  fetch?: typeof fetch;
  signal?: AbortSignal;
}

export interface DownloadUpdateOptions {
  onProgress?: (received: number, total: number) => void;
  /** Where to write the download; defaults to next to the executable, so install is a rename. */
  path?: string;
  allowInsecure?: boolean;
  fetch?: typeof fetch;
  signal?: AbortSignal;
}

export interface InstallUpdateOptions {
  /** Executable to replace; defaults to `process.execPath`. */
  executable?: string;
  /** Start the new version and exit this process (default true). */
  restart?: boolean;
  args?: string[];
}

const SPKI_ED25519 = Buffer.from("302a300506032b6570032100", "hex");
const MAX_MANIFEST_BYTES = 1 << 20;
const VERSION = /^v?\d+(\.\d+){0,3}(-[0-9A-Za-z-]+(\.[0-9A-Za-z-]+)*)?(\+[0-9A-Za-z-]+(\.[0-9A-Za-z-]+)*)?$/;
const PLATFORM = /^[a-z0-9]+-[a-z0-9]+$/;

export function updatePlatform(): string {
  return `${process.platform}-${process.arch}`;
}

/** `1.2.3`, `v1.2`, `1.0.0-beta.1+build.5`. */
export function isValidVersion(version: string): boolean {
  return typeof version === "string" && version.length <= 128 && VERSION.test(version);
}

/** `win32-x64` style: the OS (as in `process.platform`) and the architecture. */
export function isValidPlatform(platform: string): boolean {
  return PLATFORM.test(platform);
}

function isLoopback(host: string): boolean {
  return host === "localhost" || host === "[::1]" || /^127\.\d+\.\d+\.\d+$/.test(host);
}

/** Throws unless `url` is HTTPS, or HTTP on localhost (or `allowInsecure`). */
export function assertUpdateUrl(url: string, allowInsecure = false): URL {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new TypeError(`Invalid update URL: ${url}`);
  }
  if (parsed.protocol === "https:") return parsed;
  if (parsed.protocol === "http:" && (allowInsecure || isLoopback(parsed.hostname))) return parsed;
  throw new Error(`Update URL must use HTTPS: ${url}`);
}

function invalid(reason: string): never {
  throw new TypeError(`Invalid update manifest: ${reason}`);
}

/** Checks the shape of a parsed manifest; throws a TypeError naming the bad field. */
export function validateUpdateManifest(value: unknown): UpdateManifest {
  if (!value || typeof value !== "object" || Array.isArray(value)) invalid("not an object");
  const m = value as Record<string, unknown>;
  if (typeof m.version !== "string" || !isValidVersion(m.version)) invalid("version");
  if (typeof m.pubDate !== "string" || Number.isNaN(Date.parse(m.pubDate))) invalid("pubDate");
  if (m.name !== undefined && (typeof m.name !== "string" || !m.name)) invalid("name");
  if (m.notes !== undefined && typeof m.notes !== "string") invalid("notes");
  if (!m.platforms || typeof m.platforms !== "object" || Array.isArray(m.platforms)) invalid("platforms");
  for (const [platform, artifact] of Object.entries(m.platforms as Record<string, unknown>)) {
    if (!isValidPlatform(platform)) invalid(`platform ${platform}`);
    const a = artifact as Record<string, unknown> | null;
    if (!a || typeof a !== "object") invalid(`platforms.${platform}`);
    if (typeof a.url !== "string" || !a.url) invalid(`platforms.${platform}.url`);
    if (typeof a.sha256 !== "string" || !/^[0-9a-f]{64}$/i.test(a.sha256)) invalid(`platforms.${platform}.sha256`);
    if (typeof a.size !== "number" || !Number.isSafeInteger(a.size) || a.size <= 0) invalid(`platforms.${platform}.size`);
  }
  return value as UpdateManifest;
}

/** Verifies `signed` against `publicKey` and returns the manifest; throws on a bad signature or shape. */
export function verifyUpdateManifest(signed: SignedUpdateManifest, publicKey: string): UpdateManifest {
  if (typeof signed?.payload !== "string" || typeof signed.signature !== "string") invalid("expected { payload, signature }");
  if (Buffer.byteLength(signed.payload) > MAX_MANIFEST_BYTES) invalid("too large");
  const raw = Buffer.from(publicKey.trim(), "base64");
  if (raw.length !== 32) throw new TypeError("Update public key must be 32 bytes of base64 (tarve keygen)");
  const signature = Buffer.from(signed.signature, "base64");
  const key = createPublicKey({ key: Buffer.concat([SPKI_ED25519, raw]), format: "der", type: "spki" });
  if (signature.length !== 64 || !verify(null, Buffer.from(signed.payload, "utf8"), key, signature)) {
    throw new Error("Update manifest signature is invalid");
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(signed.payload);
  } catch {
    invalid("payload is not JSON");
  }
  return validateUpdateManifest(parsed);
}

/** Semver-ish comparison: numeric core, a pre-release sorts before its release. */
export function compareVersions(a: string, b: string): number {
  const parse = (v: string) => {
    const [core = "", pre] = v.trim().replace(/^v/, "").split("+")[0]!.split(/-(.*)/s);
    return { core: core.split(".").map(n => Number.parseInt(n, 10) || 0), pre };
  };
  const x = parse(a), y = parse(b);
  for (let i = 0; i < Math.max(x.core.length, y.core.length); i++) {
    const d = (x.core[i] ?? 0) - (y.core[i] ?? 0);
    if (d) return Math.sign(d);
  }
  if (x.pre === y.pre) return 0;
  if (x.pre === undefined) return 1;
  if (y.pre === undefined) return -1;
  const xp = x.pre.split("."), yp = y.pre.split(".");
  for (let i = 0; i < Math.max(xp.length, yp.length); i++) {
    const l = xp[i], r = yp[i];
    if (l === undefined) return -1;
    if (r === undefined) return 1;
    const ln = /^\d+$/.test(l), rn = /^\d+$/.test(r);
    const d = ln && rn ? Number(l) - Number(r) : ln ? -1 : rn ? 1 : l < r ? -1 : l > r ? 1 : 0;
    if (d) return Math.sign(d);
  }
  return 0;
}

/** Fetches and verifies the manifest; resolves the newer release for this platform, or null. */
export async function checkForUpdate(options: CheckForUpdateOptions): Promise<Update | null> {
  cleanupUpdate();
  const metadata = runtimeAppMetadata();
  const currentVersion = options.currentVersion ?? metadata.version;
  if (!currentVersion) throw new Error("checkForUpdate needs currentVersion (or a version set at tarve build)");
  if (!isValidVersion(currentVersion)) throw new TypeError(`Invalid current version: ${currentVersion}`);
  assertUpdateUrl(options.url, options.allowInsecure);
  const response = await (options.fetch ?? fetch)(options.url, { signal: options.signal, headers: { accept: "application/json" } });
  if (!response.ok) throw new Error(`Update check failed: HTTP ${response.status}`);
  const text = await response.text();
  if (text.length > MAX_MANIFEST_BYTES * 2) invalid("too large");
  let signed: SignedUpdateManifest;
  try {
    signed = JSON.parse(text) as SignedUpdateManifest;
  } catch {
    invalid("not JSON");
  }
  const manifest = verifyUpdateManifest(signed, options.publicKey);
  const name = options.name ?? metadata.name;
  if (manifest.name && name && manifest.name !== name) throw new Error(`Update manifest is for ${manifest.name}, not ${name}`);
  if (compareVersions(manifest.version, currentVersion) <= 0) return null;
  const platform = options.platform ?? updatePlatform();
  const artifact = manifest.platforms[platform];
  if (!artifact) return null;
  const url = new URL(artifact.url, response.url || options.url).href;
  assertUpdateUrl(url, options.allowInsecure);
  return { ...artifact, url, version: manifest.version, currentVersion, notes: manifest.notes, pubDate: manifest.pubDate, platform };
}

/** Bytes every executable for `platform` starts with; undefined when Tarve does not know the format. */
export function executableMagic(platform: string): Uint8Array | undefined {
  if (platform.startsWith("win32-")) return Uint8Array.of(0x4d, 0x5a);
  if (platform.startsWith("linux-")) return Uint8Array.of(0x7f, 0x45, 0x4c, 0x46);
  return undefined;
}

/** Whether `bytes` (the start of a file) looks like an executable for `platform`. */
export function looksExecutable(bytes: Uint8Array, platform: string): boolean {
  const magic = executableMagic(platform);
  return !magic || (bytes.length >= magic.length && magic.every((byte, i) => bytes[i] === byte));
}

function head(path: string, length: number): Uint8Array {
  const fd = openSync(path, "r");
  try {
    const bytes = new Uint8Array(length);
    return bytes.subarray(0, readSync(fd, bytes, 0, length, 0));
  } finally {
    closeSync(fd);
  }
}

/** Downloads the update, checking its size, SHA-256 and executable format; resolves the file path. */
export async function downloadUpdate(update: Update, options: DownloadUpdateOptions = {}): Promise<string> {
  if (!Number.isSafeInteger(update.size) || update.size <= 0 || !/^[0-9a-f]{64}$/i.test(update.sha256)) {
    throw new TypeError("Invalid update: size and sha256 come from checkForUpdate");
  }
  assertUpdateUrl(update.url, options.allowInsecure);
  const path = options.path ?? join(dirname(process.execPath), `.${basename(process.execPath)}.${update.version}.download`);
  const response = await (options.fetch ?? fetch)(update.url, { signal: options.signal });
  if (!response.ok || !response.body) throw new Error(`Update download failed: HTTP ${response.status}`);
  const length = response.headers.get("content-length");
  if (length !== null && !response.headers.get("content-encoding") && Number(length) !== update.size) {
    await response.body.cancel();
    throw new Error(`Update download is ${length} bytes, the manifest says ${update.size}`);
  }
  const hash = createHash("sha256");
  const out = createWriteStream(path, { mode: 0o755 });
  let received = 0;
  try {
    const reader = response.body.getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      received += value.byteLength;
      if (received > update.size) {
        await reader.cancel();
        throw new Error("Update download is larger than the manifest says");
      }
      hash.update(value);
      if (!out.write(value)) await new Promise(resolve => out.once("drain", resolve));
      options.onProgress?.(received, update.size);
    }
    await new Promise<void>((resolve, reject) => out.end((error?: Error | null) => error ? reject(error) : resolve()));
    if (received !== update.size) throw new Error("Update download is incomplete");
    if (hash.digest("hex") !== update.sha256.toLowerCase()) throw new Error("Update download failed its SHA-256 check");
    if (!looksExecutable(head(path, 4), update.platform)) throw new Error(`Update download is not a ${update.platform} executable`);
  } catch (error) {
    out.destroy();
    rmSync(path, { force: true });
    throw error;
  }
  return path;
}

const RUNTIMES = /^(bun|node|tjs|txiki)(\.exe)?$/i;

/** Whether this process can replace its own executable (a built app in a writable folder). */
export function canInstallUpdate(executable = process.execPath): boolean {
  if (RUNTIMES.test(basename(executable))) return false;
  try {
    accessSync(dirname(executable), constants.W_OK);
    accessSync(executable, constants.W_OK);
    return true;
  } catch {
    return false;
  }
}

/** Renames, or copies then renames when `from` is on another drive. */
function move(from: string, to: string): void {
  try {
    renameSync(from, to);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EXDEV") throw error;
    const staged = `${to}.${process.pid}.staged`;
    copyFileSync(from, staged);
    renameSync(staged, to);
    rmSync(from, { force: true });
  }
}

/**
 * Swaps the executable for `file` (Windows keeps the running one as `<exe>.old`,
 * removed on the next check) and, by default, starts the new version and exits.
 */
export function installUpdate(file: string, options: InstallUpdateOptions = {}): void {
  const executable = options.executable ?? process.execPath;
  if (RUNTIMES.test(basename(executable))) throw new Error("installUpdate only works in an executable built with tarve build");
  if (!existsSync(file) || !statSync(file).isFile() || statSync(file).size === 0) throw new Error(`Update file not found or empty: ${file}`);
  if (!looksExecutable(head(file, 4), updatePlatform())) throw new Error(`${file} is not an executable for ${updatePlatform()}`);
  if (!canInstallUpdate(executable)) throw new Error(`Cannot write ${executable}: update it with the installer or package manager that installed it`);
  const old = executable + ".old";
  rmSync(old, { force: true });
  if (process.platform === "win32") {
    renameSync(executable, old);
    try {
      move(file, executable);
    } catch (error) {
      renameSync(old, executable);
      throw error;
    }
  } else {
    move(file, executable);
    chmodSync(executable, 0o755);
  }
  if (options.restart === false) return;
  spawn(executable, options.args ?? process.argv.slice(2), { detached: true, stdio: "ignore" }).unref();
  process.exit(0);
}

/** Removes what a finished update left behind (`<exe>.old`). Safe to call at any time. */
export function cleanupUpdate(executable = process.execPath): void {
  const old = executable + ".old";
  try {
    if (existsSync(old) && statSync(old).isFile()) rmSync(old, { force: true });
  } catch {}
}
