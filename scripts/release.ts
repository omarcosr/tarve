import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { nativeRelativePath } from "../packages/core/targets";
import { verifyHeadlessPack } from "../packages/headless/scripts/verify-pack";
import { assertReleasePolicy } from "./release-policy";

// Builds the npm release tarball from the staged Windows and Linux runtimes and
// verifies it. Tarve ships a framework, not an application: Authenticode signing
// belongs to the applications built with `tarve build`, not to this package.
const root = resolve(import.meta.dir, "..");
const windowsNativeRelative = nativeRelativePath("windows-x64");
const linuxNativeRelative = nativeRelativePath("linux-x64");
const fromRoot = (path: string) => join(root, ...path.split("/"));

async function run(args: string[], cwd = root): Promise<void> {
  const child = Bun.spawn(args, { cwd, stdout: "inherit", stderr: "inherit" });
  const code = await child.exited;
  if (code !== 0) throw new Error(`Release command failed (${code}): ${args.join(" ")}`);
}

async function sha256(path: string): Promise<string> {
  return createHash("sha256").update(await readFile(path)).digest("hex");
}

const args = process.argv.slice(2).filter(argument => argument !== "--");
const tagIndex = args.indexOf("--tag");
const tag = tagIndex >= 0 ? args[tagIndex + 1] : process.env.TARVE_RELEASE_TAG ?? (process.env.GITHUB_REF_TYPE === "tag" ? process.env.GITHUB_REF_NAME : undefined);
if (!tag) throw new Error("A release tag is required via --tag, TARVE_RELEASE_TAG, or a GitHub tag ref.");
const policy = await assertReleasePolicy(root, tag);

const bun = Bun.which("bun") ?? "bun";
await run([bun, "run", "package"]);
await run([bun, "run", "pack"]);
// @tarve/react-icons ships TypeScript sources as-is (Bun-only, like @tarve/core).
const iconsName = `tarve-react-icons-${policy.version}.tgz`;
await run([bun, "pm", "pack", "--ignore-scripts", "--destination", join(root, "dist")], join(root, "packages/react-icons"));
const icons = join(root, "dist", iconsName);
// @tarve/headless ships the WebAssembly runtime, built here from the tagged sources.
await run([bun, "run", "build:wasm"]);
const headlessName = `tarve-headless-${policy.version}.tgz`;
await run([bun, "pm", "pack", "--ignore-scripts", "--destination", join(root, "dist")], join(root, "packages/headless"));
const headless = join(root, "dist", headlessName);
await verifyHeadlessPack(headless);

// @tarve/svelte ships TypeScript sources as-is, like @tarve/react-icons.
const svelteName = `tarve-svelte-${policy.version}.tgz`;
await run([bun, "pm", "pack", "--ignore-scripts", "--destination", join(root, "dist")], join(root, "packages/svelte"));
const svelte = join(root, "dist", svelteName);

// @tarve/router, @tarve/test and create-tarve ship their sources as-is too; the docs
// tell users to install them, so every release publishes them with @tarve/core.
const extras = [
  { name: "@tarve/router", dir: "packages/router", file: `tarve-router-${policy.version}.tgz`, peers: ["@tarve/core"] },
  { name: "@tarve/test", dir: "packages/test", file: `tarve-test-${policy.version}.tgz`, peers: ["@tarve/core", "@tarve/headless"] },
  { name: "create-tarve", dir: "packages/create-tarve", file: `create-tarve-${policy.version}.tgz`, peers: [] },
] as const;
for (const extra of extras) {
  await run([bun, "pm", "pack", "--ignore-scripts", "--destination", join(root, "dist")], join(root, extra.dir));
}

const library = fromRoot(windowsNativeRelative);
const linuxLibrary = fromRoot(linuxNativeRelative);
// bun pm pack names scoped packages <scope>-<name>-<version>.tgz.
const tarballName = `tarve-core-${policy.version}.tgz`;
const tarball = join(root, "dist", tarballName);

const extraction = await mkdtemp(join(tmpdir(), "tarve-release-verify-"));
try {
  await run(["tar", "-xzf", tarball, "-C", extraction]);
  for (const [relative, staged] of [[windowsNativeRelative, library], [linuxNativeRelative, linuxLibrary]] as const) {
    const packed = join(extraction, "package", ...relative.split("/"));
    if (await sha256(packed) !== await sha256(staged)) {
      throw new Error(`Packed native runtime ${relative} does not match the staged release artifact.`);
    }
  }
  const packedManifest = await Bun.file(join(extraction, "package", "package.json")).json() as { version: string };
  if (packedManifest.version !== policy.version) {
    throw new Error(`Packed version ${packedManifest.version} does not match ${policy.version}.`);
  }
  for (const [file, name] of [[icons, "@tarve/react-icons"], [svelte, "@tarve/svelte"]] as const) {
    const directory = join(extraction, name.replace("@tarve/", ""));
    await mkdir(directory, { recursive: true });
    await run(["tar", "-xzf", file, "-C", directory]);
    const packed = await Bun.file(join(directory, "package", "package.json")).json() as { name: string; version: string; peerDependencies?: Record<string, string> };
    if (packed.name !== name || packed.version !== policy.version || packed.peerDependencies?.["@tarve/core"] !== `^${policy.version}`) {
      throw new Error(`Packed ${name} is ${packed.name}@${packed.version} (peer @tarve/core ${packed.peerDependencies?.["@tarve/core"]}), expected ${name}@${policy.version} with ^${policy.version}.`);
    }
  }
  for (const extra of extras) {
    const directory = join(extraction, extra.name.replace(/^@tarve\//, "tarve-"));
    await mkdir(directory, { recursive: true });
    await run(["tar", "-xzf", join(root, "dist", extra.file), "-C", directory]);
    const packed = await Bun.file(join(directory, "package", "package.json")).json() as { name: string; version: string; peerDependencies?: Record<string, string> };
    const badPeer = extra.peers.find(peer => packed.peerDependencies?.[peer] !== `^${policy.version}`);
    if (packed.name !== extra.name || packed.version !== policy.version || badPeer) {
      throw new Error(`Packed ${extra.name} is ${packed.name}@${packed.version}${badPeer ? ` (peer ${badPeer} ${packed.peerDependencies?.[badPeer]})` : ""}, expected ${extra.name}@${policy.version}.`);
    }
  }
  const manifest = {
    product: "@tarve/core",
    version: policy.version,
    tag,
    targets: policy.targets,
    license: policy.license,
    distribution: policy.distribution,
    protocolVersion: policy.protocolVersion,
    nativeAbiVersion: policy.nativeAbiVersion,
    commit: process.env.GITHUB_SHA ?? null,
    artifacts: [
      { file: windowsNativeRelative, sha256: await sha256(library) },
      { file: linuxNativeRelative, sha256: await sha256(linuxLibrary) },
      { file: tarballName, sha256: await sha256(tarball) },
      { file: iconsName, sha256: await sha256(icons) },
      { file: headlessName, sha256: await sha256(headless) },
      { file: svelteName, sha256: await sha256(svelte) },
      ...await Promise.all(extras.map(async extra => ({ file: extra.file, sha256: await sha256(join(root, "dist", extra.file)) }))),
    ],
  };
  await writeFile(join(root, "dist/release-manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
  console.log(JSON.stringify({ result: "PASS", ...manifest }, null, 2));
} finally {
  await rm(extraction, { recursive: true, force: true });
}
