import { copyFile, mkdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import { buildNative } from "./native";
import { cleanPackageOutputs } from "./package-output";

const root = resolve(import.meta.dir, "..");
if (!(["win32", "linux"] as NodeJS.Platform[]).includes(process.platform) || process.arch !== "x64") {
  throw new Error(`Tarve npm packaging is not supported for ${process.platform}-${process.arch}.`);
}
const platformDirectory = `${process.platform}-${process.arch}`;
const nativeName = process.platform === "win32" ? "tarve_native.dll" : "libtarve_native.so";
// Rebuild only the current host's staged native artifact. Keep artifacts for
// other supported hosts intact so Windows and Linux can coexist in one package
// staging tree when release automation supplies both builds.
await cleanPackageOutputs(root, platformDirectory);
const library = await buildNative(true);
const output = join(root, "dist/npm");
await mkdir(output, { recursive: true });
await mkdir(join(root, "native", platformDirectory), { recursive: true });
const entries = [
  ["packages/core/src/index.ts", "index.js"],
  ["packages/core/src/jsx-runtime.ts", "jsx-runtime.js"],
  ["packages/core/src/jsx-dev-runtime.ts", "jsx-dev-runtime.js"],
  ["packages/core/src/bridge/runtime.ts", "runtime.js"],
  ["packages/core/src/embedded-assets.ts", "embedded-assets.js"],
  ["packages/core/build.ts", "build.js"],
  ["packages/core/cli.ts", "cli.js"],
  ["packages/protocol/src/index.ts", "protocol.js"],
];
const results = await Promise.all(entries.map(([entry, naming]) => Bun.build({
  entrypoints: [join(root, entry)], outdir: output, naming, target: "bun",
  external: ["#tarve/runtime", "#tarve/assets"],
})));
for (const result of results) {
  if (!result.success) throw new AggregateError(result.logs, "Package bundle failed");
}
const types = Bun.spawn([process.execPath, join(root, "node_modules/typescript/bin/tsc"), "-p", "tsconfig.package.json"], { cwd: root, stdout: "inherit", stderr: "inherit" });
if (await types.exited !== 0) throw new Error("Package declaration generation failed");
await copyFile(join(root, "packages/core/src/assets.d.ts"), join(root, "dist/types/core/src/assets.d.ts"));
const packagedLibrary = join(root, "native", platformDirectory, nativeName);
await copyFile(library, packagedLibrary);
console.log(`npm package ready: JS, declarations, CLI, and native ${process.platform}-${process.arch} release library.`);
