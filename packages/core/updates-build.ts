import { spawnSync } from "node:child_process";
import { createHash, createPrivateKey, createPublicKey, generateKeyPairSync, sign } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { basename, extname, join, resolve } from "node:path";
import { assertUpdateUrl, isValidPlatform, isValidVersion, looksExecutable, verifyUpdateManifest, type SignedUpdateManifest, type UpdateManifest } from "./src/updates";

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

function privateKeyObject(privateKey: string) {
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
  if (!options.artifacts.length) throw new Error("tarve release needs at least one --artifact platform=path");
  if (!isValidVersion(options.version)) throw new Error(`Invalid --version ${options.version}: expected e.g. 1.2.3 or 1.2.3-beta.1`);
  if (options.baseUrl) assertUpdateUrl(options.baseUrl);
  const key = existsSync(options.privateKey) ? readFileSync(options.privateKey, "utf8") : options.privateKey;
  const publicKey = updatePublicKey(key);
  if (options.publicKey && options.publicKey.trim() !== publicKey) {
    throw new Error(`The private key does not match --public-key: apps built with ${options.publicKey.trim()} would reject this release`);
  }
  const entries = options.artifacts.map(pair => {
    const at = pair.indexOf("=");
    if (at <= 0) throw new Error(`Expected --artifact platform=path, got ${pair}`);
    const platform = pair.slice(0, at), source = resolve(pair.slice(at + 1));
    if (!isValidPlatform(platform)) throw new Error(`Invalid platform ${platform}, expected e.g. win32-x64`);
    if (!existsSync(source) || !statSync(source).isFile()) throw new Error(`Artifact not found: ${source}`);
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
  const platforms: UpdateManifest["platforms"] = {};
  for (const { platform, source } of entries) {
    const stem = basename(source, extname(source));
    const file = `${stem}-${options.version}-${platform}${extname(source)}`;
    const target = join(outDir, file);
    if (resolve(target) === source) throw new Error(`Artifact ${source} is already in --out; build it elsewhere`);
    copyFileSync(source, target);
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
      url: options.baseUrl ? options.baseUrl.replace(/\/?$/, "/") + encodeURIComponent(file) : encodeURIComponent(file),
      sha256: createHash("sha256").update(bytes).digest("hex"),
      size: bytes.length,
    };
  }
  const manifest: UpdateManifest = {
    ...(options.name ? { name: options.name } : {}),
    version: options.version,
    ...(options.notes ? { notes: options.notes } : {}),
    pubDate: new Date().toISOString(),
    platforms,
  };
  const signed = signUpdateManifest(manifest, key);
  verifyUpdateManifest(signed, publicKey);
  const path = join(outDir, "latest.json");
  writeFileSync(path, JSON.stringify(signed, null, 2) + "\n");
  return path;
}
