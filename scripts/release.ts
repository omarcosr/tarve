import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { assertSigningEnvironment, signWindowsFiles, signingRequested, verifyWindowsSignatures } from "./authenticode";
import { assertReleasePolicy } from "./release-policy";

const root = resolve(import.meta.dir, "..");

async function run(args: string[], env: NodeJS.ProcessEnv = process.env): Promise<void> {
  const child = Bun.spawn(args, { cwd: root, env, stdout: "inherit", stderr: "inherit" });
  const code = await child.exited;
  if (code !== 0) throw new Error(`Release command failed (${code}): ${args.join(" ")}`);
}

async function sha256(path: string): Promise<string> {
  return createHash("sha256").update(await readFile(path)).digest("hex");
}

if (process.platform !== "win32" || process.arch !== "x64") {
  throw new Error("Signed Tarve releases must be built on Windows x64.");
}
if (!signingRequested()) {
  throw new Error("TARVE_AUTHENTICODE_SIGN=1 is required for release:build.");
}
assertSigningEnvironment();

const args = process.argv.slice(2).filter(argument => argument !== "--");
const tagIndex = args.indexOf("--tag");
const tag = tagIndex >= 0 ? args[tagIndex + 1] : process.env.TARVE_RELEASE_TAG ?? (process.env.GITHUB_REF_TYPE === "tag" ? process.env.GITHUB_REF_NAME : undefined);
if (!tag) throw new Error("A release tag is required via --tag, TARVE_RELEASE_TAG, or a GitHub tag ref.");
const policy = await assertReleasePolicy(root, tag);

const bun = Bun.which("bun") ?? "bun";
const unsignedEnv = { ...process.env };
for (const name of [
  "TARVE_AUTHENTICODE_SIGN",
  "TARVE_AUTHENTICODE_PFX_BASE64",
  "TARVE_AUTHENTICODE_PFX_PATH",
  "TARVE_AUTHENTICODE_PFX_PASSWORD",
  "TARVE_AUTHENTICODE_TIMESTAMP_URL",
]) delete unsignedEnv[name];

await run([bun, "run", "package"], unsignedEnv);

const executable = join(root, "dist/Tarve.exe");
const library = join(root, "native/win32-x64/tarve_native.dll");
const releaseLibrary = join(root, "native/target/release/tarve_native.dll");
const tarball = join(root, "dist", `tarve-${policy.version}.tgz`);
await signWindowsFiles([releaseLibrary, library]);
await run([bun, "run", "build:exe"], { ...unsignedEnv, TARVE_PREBUILT_NATIVE: releaseLibrary });
await signWindowsFiles([executable]);
await run([bun, "run", "pack"], { ...unsignedEnv, TARVE_SKIP_PREPACK: "1" });

const directSignatures = await verifyWindowsSignatures([executable, library, releaseLibrary], true);

const extraction = await mkdtemp(join(tmpdir(), "tarve-release-verify-"));
try {
  await run(["tar", "-xzf", tarball, "-C", extraction]);
  const packedLibrary = join(extraction, "package/native/win32-x64/tarve_native.dll");
  const packedSignatures = await verifyWindowsSignatures([packedLibrary], true);
  const manifest = {
    product: "tarve",
    version: policy.version,
    tag,
    target: policy.target,
    license: policy.license,
    distribution: policy.distribution,
    protocolVersion: policy.protocolVersion,
    nativeAbiVersion: policy.nativeAbiVersion,
    commit: process.env.GITHUB_SHA ?? null,
    artifacts: [
      { file: "Tarve.exe", sha256: await sha256(executable) },
      { file: "native/win32-x64/tarve_native.dll", sha256: await sha256(library) },
      { file: `tarve-${policy.version}.tgz`, sha256: await sha256(tarball) },
    ],
    signatures: [...directSignatures, ...packedSignatures].map(signature => ({
      file: signature.path.endsWith("Tarve.exe")
        ? "Tarve.exe"
        : signature.path.includes("release-verify-")
          ? "package/native/win32-x64/tarve_native.dll"
          : signature.path.includes("target")
            ? "embedded-native/tarve_native.dll"
            : "native/win32-x64/tarve_native.dll",
      status: signature.status,
      signerSubject: signature.signerSubject,
      thumbprint: signature.thumbprint,
      timestampSubject: signature.timestampSubject ?? null,
    })),
  };
  await writeFile(join(root, "dist/release-manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
  console.log(JSON.stringify({ result: "PASS", ...manifest }, null, 2));
} finally {
  await rm(extraction, { recursive: true, force: true });
}
