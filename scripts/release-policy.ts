import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { BUILD_TARGETS, type BuildTarget } from "../packages/core/targets";
import { assertVersionsSynchronized, readProductVersions } from "./version-policy";

export interface ReleasePolicyState {
  version: string;
  tag?: string;
  license: "Apache-2.0";
  distribution: "open-source";
  targets: BuildTarget[];
  protocolVersion: number;
  nativeAbiVersion: number;
}

function integerConstant(source: string, pattern: RegExp, label: string): number {
  const value = Number(source.match(pattern)?.[1]);
  if (!Number.isSafeInteger(value) || value <= 0) throw new Error(`${label} is missing or invalid`);
  return value;
}

function cargoPublishDisabled(source: string): boolean {
  let inPackage = false;
  for (const line of source.split(/\r?\n/)) {
    if (/^\[/.test(line)) {
      inPackage = line.trim() === "[package]";
      continue;
    }
    if (inPackage && /^publish\s*=/.test(line)) return /^publish\s*=\s*false\s*$/.test(line);
  }
  return false;
}

function cargoPackageLicense(source: string): string | undefined {
  let inPackage = false;
  for (const line of source.split(/\r?\n/)) {
    if (/^\[/.test(line)) {
      inPackage = line.trim() === "[package]";
      continue;
    }
    if (!inPackage) continue;
    const match = line.match(/^license\s*=\s*"([^"]+)"\s*$/);
    if (match) return match[1];
  }
  return undefined;
}

export async function assertReleasePolicy(root: string, tag?: string): Promise<ReleasePolicyState> {
  const version = assertVersionsSynchronized(await readProductVersions(root));
  const [rootPackage, corePackage, protocolPackage, reactIconsPackage, cargoToml, licenseText, tsProtocol, rustProtocol, rustBridge] = await Promise.all([
    Bun.file(join(root, "package.json")).json() as Promise<{ license?: string }>,
    Bun.file(join(root, "packages/core/package.json")).json() as Promise<{ license?: string; private?: boolean }>,
    Bun.file(join(root, "packages/protocol/package.json")).json() as Promise<{ license?: string; private?: boolean }>,
    Bun.file(join(root, "packages/react-icons/package.json")).json() as Promise<{ license?: string; private?: boolean }>,
    readFile(join(root, "native/Cargo.toml"), "utf8"),
    readFile(join(root, "LICENSE"), "utf8"),
    readFile(join(root, "packages/protocol/src/index.ts"), "utf8"),
    readFile(join(root, "native/src/protocol.rs"), "utf8"),
    readFile(join(root, "native/src/bridge.rs"), "utf8"),
  ]);
  if (rootPackage.license !== "Apache-2.0") {
    throw new Error(`Release policy requires package.json license=Apache-2.0; got ${rootPackage.license ?? "<missing>"}`);
  }
  for (const [name, manifest] of [["@tarve/core", corePackage], ["@tarve/protocol", protocolPackage]] as const) {
    if (manifest.private !== true || manifest.license !== rootPackage.license) {
      throw new Error(`${name} must remain private and inherit the root Apache-2.0 policy`);
    }
  }
  if (reactIconsPackage.private === true || reactIconsPackage.license !== rootPackage.license) {
    throw new Error("@tarve/react-icons must remain publishable and inherit the root Apache-2.0 policy");
  }
  if (cargoPackageLicense(cargoToml) !== rootPackage.license) {
    throw new Error("native/Cargo.toml must use license = \"Apache-2.0\"");
  }
  if (!cargoPublishDisabled(cargoToml)) throw new Error("native/Cargo.toml must set publish = false");
  if (!/Apache License\s+Version 2\.0, January 2004/.test(licenseText)) {
    throw new Error("LICENSE must contain the Apache License 2.0 text");
  }

  const tsProtocolVersion = integerConstant(tsProtocol, /export const PROTOCOL_VERSION = (\d+);/, "TypeScript protocol version");
  const rustProtocolVersion = integerConstant(rustProtocol, /pub const VERSION: u32 = (\d+);/, "Rust protocol version");
  if (tsProtocolVersion !== rustProtocolVersion) {
    throw new Error(`Protocol version mismatch: TypeScript=${tsProtocolVersion}, Rust=${rustProtocolVersion}`);
  }
  const tsAbiVersion = integerConstant(tsProtocol, /export const NATIVE_ABI_VERSION = (\d+);/, "TypeScript native ABI version");
  const rustAbiVersion = integerConstant(rustBridge, /pub const ABI_VERSION: u32 = (\d+);/, "Rust native ABI version");
  if (tsAbiVersion !== rustAbiVersion) {
    throw new Error(`Native ABI version mismatch: TypeScript=${tsAbiVersion}, Rust=${rustAbiVersion}`);
  }
  if (tsAbiVersion === tsProtocolVersion) {
    throw new Error("Native ABI and JSON protocol versions must use independent version sequences");
  }
  if (tag !== undefined && tag !== `v${version}`) {
    throw new Error(`Release tag mismatch: expected v${version}, got ${tag}`);
  }
  return {
    version,
    ...(tag === undefined ? {} : { tag }),
    license: "Apache-2.0",
    distribution: "open-source",
    targets: [...BUILD_TARGETS],
    protocolVersion: tsProtocolVersion,
    nativeAbiVersion: tsAbiVersion,
  };
}

if (import.meta.main) {
  const args = process.argv.slice(2).filter(argument => argument !== "--");
  const tagIndex = args.indexOf("--tag");
  const tag = tagIndex >= 0 ? args[tagIndex + 1] : process.env.GITHUB_REF_TYPE === "tag" ? process.env.GITHUB_REF_NAME : undefined;
  if (tagIndex >= 0 && !tag) throw new Error("--tag requires a value");
  const state = await assertReleasePolicy(resolve(import.meta.dir, ".."), tag);
  console.log(JSON.stringify({ result: "PASS", ...state }, null, 2));
}
