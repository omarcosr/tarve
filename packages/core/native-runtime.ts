import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { readFile, writeFile, glob } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { NATIVE_ABI_VERSION, PROTOCOL_VERSION } from "../protocol/src/index";
import { targetConfig, type BuildTarget } from "./targets";

export const NATIVE_RUNTIME_MANIFEST_NAME = "runtime.json";
export const NATIVE_COMPATIBILITY_MANIFEST_NAME = "native-runtime.json";
const NATIVE_RUNTIME_MANIFEST_SCHEMA = 1;

export interface NativeCompatibilityManifest {
  schemaVersion: 1;
  packageVersion: string;
  protocolVersion: number;
  nativeAbiVersion: number;
  sourceFingerprint: string;
}

export interface NativeRuntimeManifest extends NativeCompatibilityManifest {
  target: BuildTarget;
  nativeName: string;
  sha256: string;
}

async function sha256File(path: string): Promise<string> {
  return createHash("sha256").update(await readFile(path)).digest("hex");
}

async function addGlobFiles(
  files: string[],
  root: string,
  prefix: string,
  pattern: string,
): Promise<void> {
  const directory = join(root, "native", prefix);
  if (!existsSync(directory)) return;
  for await (const relative of glob(pattern, { cwd: directory })) {
    files.push(join(prefix, relative).replaceAll("\\", "/"));
  }
}

/** Fingerprint every source/config input that can change the native runtime binary. */
export async function nativeSourceFingerprint(root: string): Promise<string> {
  const native = join(root, "native");
  const files = ["Cargo.toml", "Cargo.lock"];
  await addGlobFiles(files, root, "src", "**/*.rs");
  await addGlobFiles(files, root, "vendor", "**/*.rs");
  await addGlobFiles(files, root, "vendor", "**/Cargo.toml");
  files.sort();

  const hash = createHash("sha256");
  for (const relative of files) {
    const path = join(native, ...relative.split("/"));
    if (!existsSync(path)) throw new Error(`Native source input is missing: ${path}`);
    hash.update(relative);
    hash.update("\0");
    // Windows and Linux release jobs use separate checkouts. Hash semantic text,
    // not checkout-specific CRLF/LF bytes, so the same commit has one fingerprint.
    hash.update((await readFile(path, "utf8")).replace(/\r\n?/g, "\n"));
    hash.update("\0");
  }
  return hash.digest("hex");
}

export async function createNativeCompatibilityManifest(
  root: string,
  packageVersion: string,
): Promise<NativeCompatibilityManifest> {
  const [rustProtocol, rustBridge] = await Promise.all([
    readFile(join(root, "native", "src", "protocol.rs"), "utf8"),
    readFile(join(root, "native", "src", "bridge.rs"), "utf8"),
  ]);
  const rustProtocolVersion = Number(rustProtocol.match(/pub const VERSION: u32 = (\d+);/)?.[1]);
  const rustAbiVersion = Number(rustBridge.match(/pub const ABI_VERSION: u32 = (\d+);/)?.[1]);
  if (rustProtocolVersion !== PROTOCOL_VERSION) {
    throw new Error(
      `Tarve protocol source mismatch: TypeScript=${PROTOCOL_VERSION}, Rust=${Number.isFinite(rustProtocolVersion) ? rustProtocolVersion : "invalid"}`,
    );
  }
  if (rustAbiVersion !== NATIVE_ABI_VERSION) {
    throw new Error(
      `Tarve native ABI source mismatch: TypeScript=${NATIVE_ABI_VERSION}, Rust=${Number.isFinite(rustAbiVersion) ? rustAbiVersion : "invalid"}`,
    );
  }
  return {
    schemaVersion: NATIVE_RUNTIME_MANIFEST_SCHEMA,
    packageVersion,
    protocolVersion: PROTOCOL_VERSION,
    nativeAbiVersion: NATIVE_ABI_VERSION,
    sourceFingerprint: await nativeSourceFingerprint(root),
  };
}

function validateCompatibilityShape(
  value: unknown,
  path: string,
): asserts value is NativeCompatibilityManifest {
  if (!value || typeof value !== "object") throw new Error(`Invalid Tarve native compatibility metadata: ${path}`);
  const manifest = value as Partial<NativeCompatibilityManifest>;
  if (manifest.schemaVersion !== NATIVE_RUNTIME_MANIFEST_SCHEMA
    || typeof manifest.packageVersion !== "string"
    || !Number.isSafeInteger(manifest.protocolVersion)
    || !Number.isSafeInteger(manifest.nativeAbiVersion)
    || typeof manifest.sourceFingerprint !== "string"
    || !/^[0-9a-f]{64}$/.test(manifest.sourceFingerprint)) {
    throw new Error(`Invalid Tarve native compatibility metadata: ${path}`);
  }
}

export async function readNativeCompatibilityManifest(path: string): Promise<NativeCompatibilityManifest> {
  if (!existsSync(path)) throw new Error(`Tarve native compatibility metadata is missing: ${path}`);
  let value: unknown;
  try {
    value = JSON.parse(await readFile(path, "utf8"));
  } catch (error) {
    throw new Error(
      `Could not read Tarve native compatibility metadata: ${path}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  validateCompatibilityShape(value, path);
  return value;
}

export async function writeNativeCompatibilityManifest(
  path: string,
  manifest: NativeCompatibilityManifest,
): Promise<void> {
  await writeFile(path, `${JSON.stringify(manifest, null, 2)}\n`);
}

export async function writeNativeRuntimeManifest(
  library: string,
  target: BuildTarget,
  compatibility: NativeCompatibilityManifest,
): Promise<string> {
  const config = targetConfig(target);
  if (basename(library) !== config.nativeName) {
    throw new Error(`Native runtime filename mismatch for ${target}: expected ${config.nativeName}, got ${basename(library)}`);
  }
  const path = join(dirname(library), NATIVE_RUNTIME_MANIFEST_NAME);
  const manifest: NativeRuntimeManifest = {
    ...compatibility,
    target,
    nativeName: config.nativeName,
    sha256: await sha256File(library),
  };
  await writeFile(path, `${JSON.stringify(manifest, null, 2)}\n`);
  return path;
}

export async function assertNativeRuntimeCompatible(
  library: string,
  target: BuildTarget,
  expected: NativeCompatibilityManifest,
): Promise<NativeRuntimeManifest> {
  const path = join(dirname(library), NATIVE_RUNTIME_MANIFEST_NAME);
  if (!existsSync(path)) {
    throw new Error(
      `Tarve native runtime metadata missing for ${target}: ${path}. `
      + "Rebuild/stage this target with `bun run package:native` on its native OS before cross-compiling.",
    );
  }
  let value: unknown;
  try {
    value = JSON.parse(await readFile(path, "utf8"));
  } catch (error) {
    throw new Error(
      `Could not read Tarve native runtime metadata for ${target}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  validateCompatibilityShape(value, path);
  const manifest = value as Partial<NativeRuntimeManifest>;
  const config = targetConfig(target);
  if (manifest.target !== target || manifest.nativeName !== config.nativeName || typeof manifest.sha256 !== "string") {
    throw new Error(`Invalid Tarve native runtime metadata for ${target}: ${path}`);
  }
  const stale = manifest.packageVersion !== expected.packageVersion
    || manifest.protocolVersion !== expected.protocolVersion
    || manifest.nativeAbiVersion !== expected.nativeAbiVersion
    || manifest.sourceFingerprint !== expected.sourceFingerprint;
  if (stale) {
    throw new Error(
      `Tarve native runtime for ${target} is stale or incompatible `
      + `(runtime protocol ${manifest.protocolVersion}, expected ${expected.protocolVersion}). `
      + "Rebuild it on its native OS with `bun run package:native` before cross-compiling.",
    );
  }
  const hash = await sha256File(library);
  if (manifest.sha256 !== hash) {
    throw new Error(
      `Tarve native runtime hash mismatch for ${target}: ${library}. `
      + "Rebuild/stage the runtime with `bun run package:native`.",
    );
  }
  return manifest as NativeRuntimeManifest;
}
