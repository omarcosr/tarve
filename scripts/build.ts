import { mkdir, copyFile, readFile, rename, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { createHash, randomUUID } from "node:crypto";
import { basename, parse, resolve, join } from "node:path";
import { build } from "../packages/core/build";
import { parseArgs } from "node:util";
import { buildNative } from "./native";

const root = resolve(import.meta.dir, "..");
const { values } = parseArgs({ args: process.argv.slice(2), options: {
  exe: { type: "boolean" }, release: { type: "boolean" },
  entry: { type: "string" },
  outfile: { type: "string" },
} });
const executable = values.exe;
const release = !!(executable || values.release);
const entrypoint = values.entry ? resolve(process.cwd(), values.entry) : join(root, "examples/basic.tsx");
const outfile = values.outfile ? resolve(process.cwd(), values.outfile) : join(root, "dist/Tarve.exe");
if (executable && (process.platform !== "win32" || process.arch !== "x64")) {
  throw new Error("The production executable currently targets Windows x64. Build it on Windows x64.");
}
const prebuiltNative = process.env.TARVE_PREBUILT_NATIVE?.trim();
const nativeArtifact = prebuiltNative ? resolve(prebuiltNative) : await buildNative(release);
if (prebuiltNative && (!release || !existsSync(nativeArtifact))) {
  throw new Error("TARVE_PREBUILT_NATIVE must point to an existing release native library.");
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
  await writeFile(temporary, JSON.stringify({ library }));
  await rename(temporary, join(directory, "current.json"));
} else if (executable) {
  await mkdir(join(root, "dist"), { recursive: true });
  const metadata = await Bun.file(join(root, "package.json")).json();
  const result = await build({ entrypoint, outfile, name: parse(outfile).name, version: metadata.version, nativeLibrary: nativeArtifact });
  console.log(`Standalone Windows executable: ${result}`);
} else {
  await mkdir(join(root, "dist/assets"), { recursive: true });
  for (const [entry, naming] of [["examples/basic.tsx", "basic.js"]]) {
    const result = await Bun.build({ entrypoints: [join(root, entry)], outdir: join(root, "dist"), naming, target: "bun", minify: false });
    if (!result.success) { console.error(result.logs); process.exit(1); }
  }
  await copyFile(nativeArtifact, join(root, "dist", name));
}
console.log(`Tarve native ${release ? "release" : "debug"} build ready.`);
