import { readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";

export const SEMVER_PATTERN = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?$/;

export interface ProductVersionState {
  root: string;
  core: string;
  protocolPackage: string;
  reactIcons: string;
  headless: string;
  bunCore: string;
  bunProtocol: string;
  bunReactIcons: string;
  bunHeadless: string;
  native: string;
  cargoLock: string;
}

function cargoPackageValue(source: string, key: string): string | undefined {
  let inPackage = false;
  for (const line of source.split(/\r?\n/)) {
    if (/^\[/.test(line)) {
      inPackage = line.trim() === "[package]";
      continue;
    }
    if (!inPackage) continue;
    const match = line.match(new RegExp(`^${key}\\s*=\\s*"([^"]+)"\\s*$`));
    if (match) return match[1];
  }
  return undefined;
}

function replaceCargoPackageValue(source: string, key: string, value: string): string {
  const eol = source.includes("\r\n") ? "\r\n" : "\n";
  const lines = source.split(/\r?\n/);
  let inPackage = false;
  let replaced = false;
  const next = lines.map(line => {
    if (/^\[/.test(line)) {
      inPackage = line.trim() === "[package]";
      return line;
    }
    if (inPackage && new RegExp(`^${key}\\s*=`).test(line)) {
      replaced = true;
      return `${key} = "${value}"`;
    }
    return line;
  });
  if (!replaced) throw new Error(`Cargo package field ${key} is missing`);
  return next.join(eol);
}

function replaceCargoLockVersion(source: string, version: string): string {
  const pattern = /(\[\[package\]\]\r?\nname = "tarve_native"\r?\nversion = ")[^"]+(")/;
  if (!pattern.test(source)) throw new Error("tarve_native package entry is missing from native/Cargo.lock");
  return source.replace(pattern, `$1${version}$2`);
}

function bunWorkspaceVersion(source: string, workspace: string): string | undefined {
  const marker = '"' + workspace + '"';
  const start = source.indexOf(marker);
  if (start < 0) return undefined;
  return source.slice(start).match(/"version"\s*:\s*"([^"]+)"/)?.[1];
}

function replaceBunWorkspaceVersion(source: string, workspace: string, version: string): string {
  const marker = '"' + workspace + '"';
  const start = source.indexOf(marker);
  if (start < 0) throw new Error(workspace + " is missing from bun.lock");
  const head = source.slice(0, start);
  const tail = source.slice(start);
  const pattern = /("version"\s*:\s*")[^"]+(")/;
  if (!pattern.test(tail)) throw new Error(workspace + " version is missing from bun.lock");
  return head + tail.replace(pattern, `$1${version}$2`);
}

export function assertValidSemver(version: string): void {
  if (!SEMVER_PATTERN.test(version)) throw new Error(`Invalid SemVer: ${version}`);
}

export async function readProductVersions(root: string): Promise<ProductVersionState> {
  const [rootPackage, corePackage, protocolPackage, reactIconsPackage, headlessPackage, bunLock, cargoToml, cargoLock] = await Promise.all([
    Bun.file(join(root, "package.json")).json() as Promise<{ version?: string }>,
    Bun.file(join(root, "packages/core/package.json")).json() as Promise<{ version?: string }>,
    Bun.file(join(root, "packages/protocol/package.json")).json() as Promise<{ version?: string }>,
    Bun.file(join(root, "packages/react-icons/package.json")).json() as Promise<{ version?: string }>,
    Bun.file(join(root, "packages/headless/package.json")).json() as Promise<{ version?: string }>,
    readFile(join(root, "bun.lock"), "utf8"),
    readFile(join(root, "native/Cargo.toml"), "utf8"),
    readFile(join(root, "native/Cargo.lock"), "utf8"),
  ]);
  const lock = cargoLock.match(/\[\[package\]\]\r?\nname = "tarve_native"\r?\nversion = "([^"]+)"/)?.[1];
  return {
    root: rootPackage.version ?? "",
    core: corePackage.version ?? "",
    protocolPackage: protocolPackage.version ?? "",
    reactIcons: reactIconsPackage.version ?? "",
    headless: headlessPackage.version ?? "",
    bunCore: bunWorkspaceVersion(bunLock, "packages/core") ?? "",
    bunProtocol: bunWorkspaceVersion(bunLock, "packages/protocol") ?? "",
    bunReactIcons: bunWorkspaceVersion(bunLock, "packages/react-icons") ?? "",
    bunHeadless: bunWorkspaceVersion(bunLock, "packages/headless") ?? "",
    native: cargoPackageValue(cargoToml, "version") ?? "",
    cargoLock: lock ?? "",
  };
}

export function assertVersionsSynchronized(state: ProductVersionState): string {
  assertValidSemver(state.root);
  const mismatches = Object.entries(state).filter(([, value]) => value !== state.root);
  if (mismatches.length) {
    throw new Error(
      `Product version drift: root=${state.root}; ${mismatches.map(([name, value]) => `${name}=${value || "<missing>"}`).join("; ")}`,
    );
  }
  return state.root;
}

export async function setProductVersion(root: string, version: string): Promise<void> {
  assertValidSemver(version);
  for (const relative of ["package.json", "packages/core/package.json", "packages/protocol/package.json", "packages/react-icons/package.json", "packages/headless/package.json"]) {
    const path = join(root, relative);
    const manifest = await Bun.file(path).json() as Record<string, unknown>;
    manifest.version = version;
    await writeFile(path, `${JSON.stringify(manifest, null, 2)}\n`);
  }
  const bunLockPath = join(root, "bun.lock");
  let bunLock = await readFile(bunLockPath, "utf8");
  bunLock = replaceBunWorkspaceVersion(bunLock, "packages/core", version);
  bunLock = replaceBunWorkspaceVersion(bunLock, "packages/protocol", version);
  bunLock = replaceBunWorkspaceVersion(bunLock, "packages/react-icons", version);
  bunLock = replaceBunWorkspaceVersion(bunLock, "packages/headless", version);
  await writeFile(bunLockPath, bunLock);
  const cargoTomlPath = join(root, "native/Cargo.toml");
  await writeFile(cargoTomlPath, replaceCargoPackageValue(await readFile(cargoTomlPath, "utf8"), "version", version));
  const cargoLockPath = join(root, "native/Cargo.lock");
  await writeFile(cargoLockPath, replaceCargoLockVersion(await readFile(cargoLockPath, "utf8"), version));
  assertVersionsSynchronized(await readProductVersions(root));
}

if (import.meta.main) {
  const root = resolve(import.meta.dir, "..");
  const args = process.argv.slice(2).filter(argument => argument !== "--");
  const setIndex = args.indexOf("--set");
  if (setIndex >= 0) {
    const version = args[setIndex + 1];
    if (!version) throw new Error("Usage: bun scripts/version-policy.ts --set <semver>");
    await setProductVersion(root, version);
  }
  const state = await readProductVersions(root);
  const version = assertVersionsSynchronized(state);
  console.log(JSON.stringify({ result: "PASS", version, manifests: state }, null, 2));
}
