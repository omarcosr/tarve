import { mkdir, copyFile, readFile, rename, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { createHash, randomUUID } from "node:crypto";
import { basename, dirname, parse, resolve, join } from "node:path";
import { build } from "../packages/core/build";
import { BUILD_TARGETS, hostBuildTarget, isBuildTarget, targetConfig, type BuildTarget } from "../packages/core/targets";
import { parseArgs } from "node:util";
import { buildNative } from "./native";

const root = resolve(import.meta.dir, "..");
const { values } = parseArgs({ args: process.argv.slice(2), options: {
  exe: { type: "boolean" }, release: { type: "boolean" },
  entry: { type: "string" },
  outfile: { type: "string" },
  target: { type: "string" },
} });
const executable = values.exe;
const release = !!(executable || values.release);
if (values.target !== undefined && !isBuildTarget(values.target)) {
  throw new Error(`Unsupported target: ${values.target}. Expected ${BUILD_TARGETS.join(" or ")}.`);
}
const hostTarget = hostBuildTarget();
const target = (values.target as BuildTarget | undefined) ?? hostTarget;
if (executable && !target) throw new Error(`Production executables are not supported for ${process.platform}-${process.arch} without an explicit --target.`);
if (values.target && !executable) throw new Error("--target is only supported with --exe in the repository build script.");
if (executable && !values.entry) throw new Error("--entry is required with --exe.");
if (values.entry && !executable) throw new Error("--entry is only supported with --exe.");
const executableSuffix = target ? targetConfig(target).executableSuffix : "";
const outfile = values.outfile ? resolve(process.cwd(), values.outfile) : join(root, `dist/Tarve${executableSuffix}`);
const prebuiltNative = process.env.TARVE_PREBUILT_NATIVE?.trim();
const crossConfig = target && hostTarget && target !== hostTarget ? targetConfig(target) : undefined;
const crossNative = crossConfig ? join(root, "native", crossConfig.nativeDirectory, crossConfig.nativeName) : undefined;
const nativeArtifact = prebuiltNative
  ? resolve(prebuiltNative)
  : crossNative
    ? crossNative
    : await buildNative(release);
if (prebuiltNative && (!release || !existsSync(nativeArtifact))) {
  throw new Error("TARVE_PREBUILT_NATIVE must point to an existing release native library.");
}
if (crossNative && !existsSync(nativeArtifact)) {
  throw new Error(`Cross-compilation runtime missing for ${target}: ${nativeArtifact}. Build/stage that target runtime first.`);
}
const name = basename(nativeArtifact);
if (!release) {
  const directory = join(root, "native/bin");
  await mkdir(directory, { recursive: true });
  // An open Windows app locks its DLL. Publish each build under a new content-based name.
  const hash = createHash("sha256").update(await readFile(nativeArtifact)).digest("hex").slice(0, 20);
  const library = `${parse(name).name}-${hash}${parse(name).ext}`;
  if (!existsSync(join(directory, library))) await copyFile(nativeArtifact, join(directory, library));
  const temporary = join(directory, `${randomUUID()}.json`);
  await writeFile(temporary, JSON.stringify({ target: hostTarget, library }));
  await rename(temporary, join(directory, "current.json"));
} else if (executable) {
  await mkdir(join(root, "dist"), { recursive: true });
  const metadata = await Bun.file(join(root, "package.json")).json();
  const result = await build({ entrypoint: resolve(process.cwd(), values.entry!), outfile, name: parse(outfile).name, version: metadata.version, nativeLibrary: nativeArtifact, target });
  console.log(`Standalone ${target} executable: ${result}`);
} else {
  const output = values.outfile ? resolve(process.cwd(), values.outfile) : join(root, "dist", name);
  await mkdir(dirname(output), { recursive: true });
  await copyFile(nativeArtifact, output);
}
console.log(`Tarve native ${release ? "release" : "debug"} build ready.`);
