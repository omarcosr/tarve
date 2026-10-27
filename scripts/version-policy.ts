import { readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";

export const SEMVER_PATTERN = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?$/;

export interface ProductVersionState {
  root: string;
  core: string;
  protocolPackage: string;
  reactIcons: string;
  headless: string;
  svelte: string;
  router: string;
  test: string;
  createTarve: string;
  bunCore: string;
  bunProtocol: string;
  bunReactIcons: string;
  bunHeadless: string;
  bunSvelte: string;
  bunRouter: string;
  bunTest: string;
  bunCreateTarve: string;
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

/** Every published manifest that carries the product version, with its ProductVersionState keys. */
const MANIFESTS = [
  { path: "packages/core", key: "core", lock: "bunCore" },
  { path: "packages/protocol", key: "protocolPackage", lock: "bunProtocol" },
  { path: "packages/react-icons", key: "reactIcons", lock: "bunReactIcons" },
  { path: "packages/headless", key: "headless", lock: "bunHeadless" },
  { path: "packages/svelte", key: "svelte", lock: "bunSvelte" },
  { path: "packages/router", key: "router", lock: "bunRouter" },
  { path: "packages/test", key: "test", lock: "bunTest" },
  { path: "packages/create-tarve", key: "createTarve", lock: "bunCreateTarve" },
] as const satisfies readonly { path: string; key: keyof ProductVersionState; lock: keyof ProductVersionState }[];

export async function readProductVersions(root: string): Promise<ProductVersionState> {
  const [rootPackage, bunLock, cargoToml, cargoLock, ...manifests] = await Promise.all([
    Bun.file(join(root, "package.json")).json() as Promise<{ version?: string }>,
    readFile(join(root, "bun.lock"), "utf8"),
    readFile(join(root, "native/Cargo.toml"), "utf8"),
    readFile(join(root, "native/Cargo.lock"), "utf8"),
    ...MANIFESTS.map(manifest => Bun.file(join(root, manifest.path, "package.json")).json() as Promise<{ version?: string }>),
  ]);
  const lock = cargoLock.match(/\[\[package\]\]\r?\nname = "tarve_native"\r?\nversion = "([^"]+)"/)?.[1];
  const state = {
    root: rootPackage.version ?? "",
    native: cargoPackageValue(cargoToml, "version") ?? "",
    cargoLock: lock ?? "",
  } as ProductVersionState;
  MANIFESTS.forEach((manifest, index) => {
    state[manifest.key] = manifests[index]!.version ?? "";
    state[manifest.lock] = bunWorkspaceVersion(bunLock, manifest.path) ?? "";
  });
  return state;
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
  for (const relative of ["package.json", ...MANIFESTS.map(manifest => `${manifest.path}/package.json`)]) {
    const path = join(root, relative);
    const manifest = await Bun.file(path).json() as Record<string, unknown>;
    manifest.version = version;
    // Published companions require the Tarve release they ship with.
    const peers = manifest.peerDependencies as Record<string, string> | undefined;
    for (const name of ["@tarve/core", "@tarve/headless"]) if (peers?.[name]) peers[name] = `^${version}`;
    await writeFile(path, `${JSON.stringify(manifest, null, 2)}\n`);
  }
  const bunLockPath = join(root, "bun.lock");
  let bunLock = await readFile(bunLockPath, "utf8");
  for (const manifest of MANIFESTS) bunLock = replaceBunWorkspaceVersion(bunLock, manifest.path, version);
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
