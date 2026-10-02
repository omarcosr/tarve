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
  const iconsExtraction = join(extraction, "icons");
  await mkdir(iconsExtraction, { recursive: true });
  await run(["tar", "-xzf", icons, "-C", iconsExtraction]);
  const iconsManifest = await Bun.file(join(iconsExtraction, "package", "package.json")).json() as { name: string; version: string };
  if (iconsManifest.name !== "@tarve/react-icons" || iconsManifest.version !== policy.version) {
    throw new Error(`Packed icons package is ${iconsManifest.name}@${iconsManifest.version}, expected @tarve/react-icons@${policy.version}.`);
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
    ],
  };
  await writeFile(join(root, "dist/release-manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
  console.log(JSON.stringify({ result: "PASS", ...manifest }, null, 2));
} finally {
  await rm(extraction, { recursive: true, force: true });
}
