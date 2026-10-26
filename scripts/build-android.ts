// Builds the Android runtime (native/android/<abi>/libtarve_native.so) with cargo-ndk.
// Needs the Android NDK (ANDROID_NDK_HOME, or ndk/<version> in the SDK), cargo-ndk and the Rust targets:
//   rustup target add aarch64-linux-android x86_64-linux-android && cargo install cargo-ndk
import { existsSync, statSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { ANDROID_ABIS, androidNdk, androidSdk } from "../packages/core/android-build";

const { values } = parseArgs({ options: { abi: { type: "string", multiple: true }, debug: { type: "boolean" } } });
const abis = values.abi ?? [...ANDROID_ABIS];
const root = join(import.meta.dir, "..");
const ndk = process.env.ANDROID_NDK_HOME ?? androidNdk(androidSdk());
const args = ["ndk", ...abis.flatMap(abi => ["-t", abi]), "-P", "26", "-o", "android", "build", "--lib", "--target-dir", "target-android"];
if (!values.debug) args.push("--release");
// A phone runs this library on small cores at low clocks: whole-program LTO in one codegen unit
// trades build time for a smaller, faster library (only for this build; desktop keeps thin LTO).
const profile = values.debug ? {} : { CARGO_PROFILE_RELEASE_LTO: "fat", CARGO_PROFILE_RELEASE_CODEGEN_UNITS: "1" };
const build = Bun.spawn(["cargo", ...args], { cwd: join(root, "native"), env: { ...process.env, ...profile, ANDROID_NDK_HOME: ndk }, stdout: "inherit", stderr: "inherit" });
if (await build.exited !== 0) process.exit(1);
for (const abi of abis) {
  const library = join(root, "native/android", abi, "libtarve_native.so");
  if (!existsSync(library)) throw new Error(`cargo-ndk did not produce ${library}`);
  console.log(`${abi}: ${library} (${(statSync(library).size / 1048576).toFixed(1)} MiB)`);
}
