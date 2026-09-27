import { existsSync } from "node:fs";
import { copyFile, mkdir, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { BUILD_TARGETS, hostBuildTarget, targetConfig } from "../packages/core/targets";
import { buildNative } from "./native";
import { cleanPackageOutputs } from "./package-output";

const root = resolve(import.meta.dir, "..");
const hostTarget = hostBuildTarget();
if (!hostTarget) throw new Error(`Tarve npm packaging is not supported for ${process.platform}-${process.arch}.`);
const hostConfig = targetConfig(hostTarget);
const { values } = parseArgs({
  args: process.argv.slice(2),
  options: {
    "native-only": { type: "boolean" },
    local: { type: "boolean" },
  },
});
const platformDirectory = hostConfig.nativeDirectory;
const nativeName = hostConfig.nativeName;
const platformOutput = join(root, "native", platformDirectory);
// Native compilation is intentionally host-native. Release automation builds each
// runtime on its own OS, then assembles one universal Tarve package containing both.
const library = await buildNative(true);
await rm(platformOutput, { recursive: true, force: true });
await mkdir(platformOutput, { recursive: true });
const packagedLibrary = join(platformOutput, nativeName);
await copyFile(library, packagedLibrary);

if (values["native-only"]) {
  console.log(`Tarve native ${platformDirectory} release runtime ready: ${packagedLibrary}`);
  process.exit(0);
}

if (!values.local) {
  const requiredRuntimes = BUILD_TARGETS.map(target => {
    const config = targetConfig(target);
    return join(root, "native", config.nativeDirectory, config.nativeName);
  });
  const missingRuntimes = requiredRuntimes.filter(path => !existsSync(path));
  if (missingRuntimes.length > 0) {
    throw new Error([
      "Tarve packages must contain both Windows x64 and Linux x64 native runtimes.",
      `Missing: ${missingRuntimes.join(", ")}`,
      "Build the missing runtime on its native OS with `bun run package:native`, then run `bun run package` again.",
    ].join("\n"));
  }
}

await cleanPackageOutputs(root);
const output = join(root, "dist/npm");
await mkdir(output, { recursive: true });
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
console.log(values.local
  ? `local package staging ready for ${hostTarget}.`
  : `npm package ready: JS, declarations, CLI, and native ${BUILD_TARGETS.join(" + ")} release runtimes.`);
