import { spawnSync } from "node:child_process";
import { createHash, createPrivateKey, createPublicKey, generateKeyPairSync, sign, verify } from "node:crypto";
import { copyFileSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, extname, join, resolve } from "node:path";
import { readMacAppBundle, zipMacApp } from "./macos-bundle";
import { notarizeMacApp, runCommand, signMacApp, type CommandRunner, type MacSignOptions } from "./macos-sign";
import { machOKind } from "./src/macho";
import { assertUpdateUrl, isValidPlatform, isValidVersion, looksExecutable, verifyUpdateManifest, type SignedUpdateManifest, type UpdateManifest } from "./src/updates";
import { PACK_EXTENSION, inspectPack } from "./src/pack";

export interface UpdateKeys {
  /** Base64 raw Ed25519 public key: pass to checkForUpdate. */
  publicKey: string;
  /** Base64 PKCS#8 private key: keep secret, give to tarve release. */
  privateKey: string;
}

export function generateUpdateKeys(): UpdateKeys {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const spki = publicKey.export({ format: "der", type: "spki" });
  return {
    publicKey: Buffer.from(spki.subarray(spki.length - 32)).toString("base64"),
    privateKey: Buffer.from(privateKey.export({ format: "der", type: "pkcs8" })).toString("base64"),
  };
}

/** The private key itself, or the contents of the file `value` names. */
export function loadUpdatePrivateKey(value: string): string {
  return existsSync(value) ? readFileSync(value, "utf8") : value;
}

export function privateKeyObject(privateKey: string) {
  try {
    return createPrivateKey({ key: Buffer.from(privateKey.trim(), "base64"), format: "der", type: "pkcs8" });
  } catch {
    throw new Error("Invalid update private key: expected the base64 PKCS#8 key written by tarve keygen");
  }
}

/** The base64 public key that belongs to `privateKey`. */
export function updatePublicKey(privateKey: string): string {
  const spki = createPublicKey(privateKeyObject(privateKey)).export({ format: "der", type: "spki" });
  return Buffer.from(spki.subarray(spki.length - 32)).toString("base64");
}

export function signUpdateManifest(manifest: UpdateManifest, privateKey: string): SignedUpdateManifest {
  const key = privateKeyObject(privateKey);
  if (key.asymmetricKeyType !== "ed25519") throw new Error("Update private key must be Ed25519 (tarve keygen)");
  const payload = JSON.stringify(manifest);
  return { payload, signature: sign(null, Buffer.from(payload, "utf8"), key).toString("base64") };
}

export interface ReleaseOptions {
  version: string;
  /** `platform=path` pairs, e.g. `win32-x64=dist/App.exe`. */
  artifacts: string[];
  /** App packs from `tarve pack`; each is listed under the platform and runtime its header names. */
  packs?: string[];
  /** Base64 PKCS#8 key, or a path to a file holding it. */
  privateKey: string;
  /** Public key the app ships with: release fails when the private key does not match it. */
  publicKey?: string;
  outDir?: string;
  /** Prefix for artifact URLs; relative to the manifest URL when omitted. */
  baseUrl?: string;
  name?: string;
  notes?: string;
  /**
   * Authenticode command run on each Windows artifact (the copy in `outDir`) before it is hashed, e.g.
   * `signtool sign /fd sha256 /tr http://timestamp.digicert.com /td sha256 {file}`. `{file}` is the quoted
   * path; without it the path is appended.
   */
  sign?: string;
  /**
   * macOS: sign each `darwin-*` .app artifact (codesign --deep --options runtime) and, when set,
   * notarize and staple it, before it is zipped and hashed. Only on a Mac (see macos-sign.ts).
   */
  macSign?: MacSignOptions;
  /** Runs codesign/xcrun; for tests. */
  macRunner?: CommandRunner;
}

/**
 * A `darwin-*` artifact as an update zip in `outDir`: a `.app` is copied, signed (and notarized)
 * when asked, then zipped; a ready zip or a bare Mach-O is copied as it is.
 */
function releaseMacArtifact(source: string, target: string, options: ReleaseOptions): void {
  if (!statSync(source).isDirectory()) {
    if (options.macSign) throw new Error(`Pass the .app bundle, not ${basename(source)}, to sign it: codesign seals the whole bundle.`);
    copyFileSync(source, target);
    return;
  }
  const staging = mkdtempSync(join(tmpdir(), "tarve-release-app-"));
  try {
    const app = join(staging, basename(source));
    cpSync(source, app, { recursive: true });
    const run = options.macRunner ?? runCommand;
    if (options.macSign) signMacApp(app, options.macSign, run);
    zipMacApp(app, target);
    if (options.macSign?.notarize) {
      notarizeMacApp(app, target, options.macSign.notarize, run);
      // Staple wrote the ticket into the bundle: zip it again so the download carries it.
      zipMacApp(app, target);
    }
  } finally {
    rmSync(staging, { recursive: true, force: true });
  }
}

/** Whether `source` is a valid `darwin-*` artifact: a .app bundle with a Mach-O executable, a zip, or a Mach-O file. */
function checkMacArtifact(source: string, platform: string): void {
  if (statSync(source).isDirectory()) {
    if (!/\.app$/i.test(source)) throw new Error(`${source} is a folder; a ${platform} artifact folder must be a .app bundle`);
    const { executable } = readMacAppBundle(source);
    if (!machOKind(readFileSync(executable).subarray(0, 4))) throw new Error(`${executable} is not a Mach-O executable`);
    return;
  }
  if (!looksExecutable(readFileSync(source).subarray(0, 4), platform)) throw new Error(`${source} is not a ${platform} executable or zipped .app`);
}

/** Runs `command` on `file` through the shell (see ReleaseOptions.sign); throws when it fails. */
export function signFile(command: string, file: string): void {
  const quoted = `"${file.replaceAll('"', '\\"')}"`;
  const line = command.includes("{file}") ? command.replaceAll("{file}", quoted) : `${command} ${quoted}`;
  const result = spawnSync(line, { shell: true, stdio: "inherit" });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`Signing ${basename(file)} failed (exit ${result.status}): ${line}`);
}

/** Copies the artifacts into `outDir` and writes the signed `latest.json` beside them. */
export function release(options: ReleaseOptions): string {
  if (!options.artifacts.length && !options.packs?.length) throw new Error("tarve release needs at least one --artifact platform=path or --pack App.tarve");
  if (!isValidVersion(options.version)) throw new Error(`Invalid --version ${options.version}: expected e.g. 1.2.3 or 1.2.3-beta.1`);
  if (options.baseUrl) assertUpdateUrl(options.baseUrl);
  const key = loadUpdatePrivateKey(options.privateKey);
  const publicKey = updatePublicKey(key);
  if (options.publicKey && options.publicKey.trim() !== publicKey) {
    throw new Error(`The private key does not match --public-key: apps built with ${options.publicKey.trim()} would reject this release`);
  }
  const entries = options.artifacts.map(pair => {
    const at = pair.indexOf("=");
    if (at <= 0) throw new Error(`Expected --artifact platform=path, got ${pair}`);
    const platform = pair.slice(0, at), source = resolve(pair.slice(at + 1));
    if (!isValidPlatform(platform)) throw new Error(`Invalid platform ${platform}, expected e.g. win32-x64`);
    const mac = platform.startsWith("darwin-");
    if (!existsSync(source) || !(statSync(source).isFile() || (mac && statSync(source).isDirectory()))) throw new Error(`Artifact not found: ${source}`);
    if (mac) {
      checkMacArtifact(source, platform);
      return { platform, source };
    }
    if (statSync(source).size === 0) throw new Error(`Artifact is empty: ${source}`);
    if (!looksExecutable(readFileSync(source).subarray(0, 4), platform)) throw new Error(`${source} is not a ${platform} executable`);
    return { platform, source };
  });
  const seen = new Set<string>();
  for (const { platform } of entries) {
    if (seen.has(platform)) throw new Error(`Platform ${platform} is listed twice`);
    seen.add(platform);
  }
  const outDir = resolve(options.outDir ?? "dist/updates");
  mkdirSync(outDir, { recursive: true });
  const url = (file: string) => options.baseUrl ? options.baseUrl.replace(/\/?$/, "/") + encodeURIComponent(file) : encodeURIComponent(file);
  const platforms: UpdateManifest["platforms"] = {};
  for (const { platform, source } of entries) {
    const stem = basename(source, extname(source));
    // A .app is released zipped: macOS updates replace the whole bundle.
    const extension = statSync(source).isDirectory() ? ".zip" : extname(source);
    const file = `${stem}-${options.version}-${platform}${extension}`;
    const target = join(outDir, file);
    if (resolve(target) === source) throw new Error(`Artifact ${source} is already in --out; build it elsewhere`);
    if (platform.startsWith("darwin-")) releaseMacArtifact(source, target, options);
    else copyFileSync(source, target);
    if (options.sign && platform.startsWith("win32-")) {
      const before = createHash("sha256").update(readFileSync(target)).digest("hex");
      signFile(options.sign, target);
      if (createHash("sha256").update(readFileSync(target)).digest("hex") === before) {
        throw new Error(`The sign command left ${file} unchanged: it was not signed`);
      }
    }
    const bytes = readFileSync(target);
    if (!looksExecutable(bytes.subarray(0, 4), platform)) throw new Error(`The sign command broke ${file}: it is no longer an executable`);
    platforms[platform] = {
      url: url(file),
      sha256: createHash("sha256").update(bytes).digest("hex"),
      size: bytes.length,
    };
  }
  const packs = releasePacks(options.packs ?? [], key, options, outDir, url);
  const manifest: UpdateManifest = {
    ...(options.name ? { name: options.name } : {}),
    version: options.version,
    ...(options.notes ? { notes: options.notes } : {}),
    pubDate: new Date().toISOString(),
    platforms,
    ...Object.keys(packs).length ? { packs } : {},
  };
  const signed = signUpdateManifest(manifest, key);
  verifyUpdateManifest(signed, publicKey);
  const path = join(outDir, "latest.json");
  writeFileSync(path, JSON.stringify(signed, null, 2) + "\n");
  return path;
}
/** Checks each pack (signed with `key`, built for this release) and copies it into `outDir`. */
function releasePacks(
  sources: readonly string[],
  key: string,
  options: ReleaseOptions,
  outDir: string,
  url: (file: string) => string,
): NonNullable<UpdateManifest["packs"]> {
  const packs: NonNullable<UpdateManifest["packs"]> = {};
  const publicKey = createPublicKey(privateKeyObject(key));
  let name: string | undefined;
  for (const source of sources) {
    const path = resolve(source);
    if (!existsSync(path) || !statSync(path).isFile()) throw new Error(`App pack not found: ${path}`);
    const bytes = new Uint8Array(readFileSync(path));
    const { header, signed, signature } = inspectPack((offset, length) => {
      if (offset + length > bytes.length) throw new Error(`App pack is truncated: ${path}`);
      return bytes.subarray(offset, offset + length);
    }, bytes.length);
    if (!verify(null, signed, publicKey, signature)) throw new Error(`${source} is not signed with this update key`);
    if (header.version !== options.version) throw new Error(`${source} holds version ${header.version}, not ${options.version}`);
    if (options.name && header.name !== options.name) throw new Error(`${source} belongs to ${header.name}, not ${options.name}`);
    if (name !== undefined && header.name !== name) throw new Error(`Packs of two apps in one release: ${name} and ${header.name}`);
    name = header.name;
    if (packs[header.platform]?.[header.runtime]) throw new Error(`Two packs for ${header.runtime} on ${header.platform}`);
    const file = `${header.name}-${header.version}-${header.platform}-${header.runtime}${PACK_EXTENSION}`;
    const target = join(outDir, file);
    if (resolve(target) !== path) copyFileSync(path, target);
    (packs[header.platform] ??= {})[header.runtime] = {
      url: url(file),
      sha256: createHash("sha256").update(bytes).digest("hex"),
      size: bytes.length,
      compat: header.requires.compat,
      features: header.requires.features,
    };
  }
  return packs;
}
