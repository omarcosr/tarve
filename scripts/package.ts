import { existsSync } from "node:fs";
import { cp, copyFile, mkdir, rm } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { PACKAGED_TARGETS, hostBuildTarget, targetConfig } from "../packages/core/targets";
import {
  NATIVE_COMPATIBILITY_MANIFEST_NAME,
  assertNativeRuntimeCompatible,
  createNativeCompatibilityManifest,
  writeNativeCompatibilityManifest,
  writeNativeRuntimeManifest,
} from "../packages/core/native-runtime";
import { buildNative } from "./native";
import { NATIVE_VARIANTS, nativeVariantPath, variantFeatures } from "../packages/core/native-features";
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
    // Skip the trimmed libraries `tarve build` picks for apps that use fewer native features.
    "no-variants": { type: "boolean" },
    // With --native-only: build only these parts, comma separated: "full" (the full library) and
    // variant names (core, rich…). CI builds the parts in parallel jobs and merges their outputs.
    parts: { type: "string" },
    // Package the host runtime a previous `package:native` staged (a CI job of its own) instead of
    // building it again. Still fail-closed: it must exist and match this checkout's compatibility,
    // and so must every variant of every packaged target (unless --no-variants).
    prebuilt: { type: "boolean" },
  },
});
const prebuilt = values.prebuilt === true || process.env.TARVE_NATIVE_PREBUILT === "1";
const ALL_PARTS = ["full", ...NATIVE_VARIANTS.map(variant => variant.name)];
const parts = values.parts === undefined
  ? (values["no-variants"] ? ["full"] : ALL_PARTS)
  : [...new Set(values.parts.split(",").map(part => part.trim()).filter(Boolean))];
if (values.parts !== undefined) {
  if (!values["native-only"]) throw new Error("--parts builds pieces of a runtime: use it with --native-only.");
  const unknown = parts.filter(part => !ALL_PARTS.includes(part));
  if (unknown.length || !parts.length) throw new Error(`Unknown --parts ${unknown.join(", ") || "(none)"}. Expected a list of ${ALL_PARTS.join(", ")}.`);
}
const platformDirectory = hostConfig.nativeDirectory;
const nativeName = hostConfig.nativeName;
const platformOutput = join(root, "native", platformDirectory);
const packageMetadata = await Bun.file(join(root, "package.json")).json() as { version?: string };
if (typeof packageMetadata.version !== "string" || packageMetadata.version.length === 0) {
  throw new Error("Tarve package version is missing.");
}
const compatibility = await createNativeCompatibilityManifest(root, packageMetadata.version);
// Published libraries always take the fat-LTO `release` profile.
delete process.env.TARVE_NATIVE_PROFILE;
const packagedLibrary = join(platformOutput, nativeName);
if (prebuilt) {
  if (values["native-only"]) throw new Error("--prebuilt packages a staged runtime; it cannot be combined with --native-only.");
  await assertNativeRuntimeCompatible(packagedLibrary, hostTarget, compatibility).catch((error: Error) => {
    throw new Error(`--prebuilt needs the ${hostTarget} runtime staged by \`bun run package:native\` from this checkout: ${error.message}`);
  });
  console.log(`Tarve native ${platformDirectory}: using the staged runtime ${packagedLibrary}`);
} else {
  // Native compilation is intentionally host-native. Release automation builds each
  // runtime on its own OS, then assembles one universal Tarve package containing both.
  if (parts.includes("full")) {
    const library = await buildNative(true);
    // A whole build starts from an empty folder; a partial one (--parts) adds to what is staged.
    if (values.parts === undefined) await rm(platformOutput, { recursive: true, force: true });
    await mkdir(platformOutput, { recursive: true });
    await copyFile(library, packagedLibrary);
    await writeNativeRuntimeManifest(packagedLibrary, hostTarget, compatibility);
  }
  for (const variant of NATIVE_VARIANTS) {
    if (!parts.includes(variant.name)) continue;
    const features = variantFeatures(variant, hostConfig.platform);
    const built = await buildNative(true, features);
    const destination = nativeVariantPath(platformOutput, variant.name, nativeName);
    await mkdir(dirname(destination), { recursive: true });
    await copyFile(built, destination);
    await writeNativeRuntimeManifest(destination, hostTarget, compatibility);
    console.log(`Native variant ${variant.name} [${features.join(", ") || "core"}]: ${(Bun.file(destination).size / 1048576).toFixed(1)} MiB`);
  }
}

if (values["native-only"]) {
  console.log(`Tarve native ${platformDirectory} release runtime ready (${parts.join(", ")}): ${platformOutput}`);
  process.exit(0);
}

if (!values.local) {
  // macOS runtimes are not part of the npm package yet (no macOS release runner); see reports/gap/macos-ts.md.
  const requiredRuntimes = PACKAGED_TARGETS.map(target => {
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
  for (let index = 0; index < PACKAGED_TARGETS.length; index++) {
    await assertNativeRuntimeCompatible(requiredRuntimes[index]!, PACKAGED_TARGETS[index]!, compatibility);
    // Variants are optional for `tarve build` (it falls back to the full library), but staged
    // runtimes assembled from separate jobs (--prebuilt) must bring every one: a lost artifact
    // would otherwise ship a package without them.
    for (const variant of NATIVE_VARIANTS) {
      const path = nativeVariantPath(dirname(requiredRuntimes[index]!), variant.name, targetConfig(PACKAGED_TARGETS[index]!).nativeName);
      if (existsSync(path)) await assertNativeRuntimeCompatible(path, PACKAGED_TARGETS[index]!, compatibility);
      else if (prebuilt && !values["no-variants"]) throw new Error(`--prebuilt: the ${variant.name} variant of the ${PACKAGED_TARGETS[index]} runtime is missing (${path}).`);
    }
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
  ["packages/core/src/pack-host.ts", "pack-host.js"],
  ["packages/core/build.ts", "build.js"],
  ["packages/core/cli.ts", "cli.js"],
  ["packages/core/alias-preload.ts", "alias-preload.js"],
  ["packages/core/node-build.ts", "node-build.js"],
  ["packages/core/package-installer.ts", "package-installer.js"],
  // The Windows installer wizard `tarve package --format setup` builds, with the app embedded (setup-build.ts).
  ["packages/core/setup/app.tsx", "setup-app.js"],
  ["packages/protocol/src/index.ts", "protocol.js"],
];
const results = await Promise.all(entries.map(([entry, naming]) => Bun.build({
  entrypoints: [join(root, entry)], outdir: output, naming,
  // The CLI and the Node build API must start under Node as well as Bun.
  target: entry.endsWith("/cli.ts") || entry.includes("/node-") || entry.endsWith("/package-installer.ts") ? "node" : "bun",
  external: ["#tarve/runtime", "#tarve/assets", "esbuild", "resedit", "typescript", "typescript/*"],
})));
for (const result of results) {
  if (!result.success) throw new AggregateError(result.logs, "Package bundle failed");
}
// build({ runtime: "txiki" }) bundles the app with these sources (prelude and node:* shims).
await cp(join(root, "packages/core/txiki"), join(output, "txiki"), { recursive: true });
// tarve build --target android bundles the app with the Android prelude and shims.
await cp(join(root, "packages/core/android"), join(output, "android"), { recursive: true });
await writeNativeCompatibilityManifest(
  join(output, NATIVE_COMPATIBILITY_MANIFEST_NAME),
  compatibility,
);
const types = Bun.spawn([process.execPath, join(root, "node_modules/typescript/bin/tsc"), "-p", "tsconfig.package.json"], { cwd: root, stdout: "inherit", stderr: "inherit" });
if (await types.exited !== 0) throw new Error("Package declaration generation failed");
await copyFile(join(root, "packages/core/src/assets.d.ts"), join(root, "dist/types/core/src/assets.d.ts"));
console.log(values.local
  ? `local package staging ready for ${hostTarget}.`
  : `npm package ready: JS, declarations, CLI, and native ${PACKAGED_TARGETS.join(" + ")} release runtimes.`);
