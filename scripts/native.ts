import { join, resolve } from "node:path";
import { hostBuildTarget, targetConfig } from "../packages/core/targets";

const root = resolve(import.meta.dir, "..");

function linuxNativePrerequisiteError(missing: string[]): Error {
  return new Error([
    `Missing Linux native build prerequisites: ${missing.join(", ")}.`,
    "On Ubuntu/WSL install the system packages with:",
    "  apt-get update && apt-get install -y build-essential pkg-config libx11-dev libxkbcommon-dev libxkbcommon-x11-0 libwayland-dev libegl1-mesa-dev libfontconfig1-dev curl ca-certificates",
    "Install the Rust stable toolchain with:",
    '  curl --proto "=https" --tlsv1.2 -sSf https://sh.rustup.rs | sh -s -- -y --profile minimal --default-toolchain stable',
    '  source "$HOME/.cargo/env"',
    "Then run bun run package:native again.",
  ].join("\n"));
}

/**
 * `features`: build with only these optional native features (native/Cargo.toml) instead of the
 * defaults, into a separate target directory so the full library stays incremental.
 */
export async function buildNative(release: boolean, features?: readonly string[]): Promise<string> {
  const target = hostBuildTarget();
  if (!target) throw new Error(`Unsupported native platform: ${process.platform}-${process.arch}`);
  const config = targetConfig(target);
  const cargoExecutable = Bun.which("cargo");
  if (config.platform === "linux") {
    const missing: string[] = [];
    if (!cargoExecutable) missing.push("cargo");
    if (!Bun.which("cc") && !Bun.which("gcc") && !Bun.which("clang")) missing.push("C compiler");
    if (!Bun.which("pkg-config")) missing.push("pkg-config");
    if (missing.length > 0) throw linuxNativePrerequisiteError(missing);
  } else if (config.platform === "darwin") {
    const missing: string[] = [];
    if (!cargoExecutable) missing.push("cargo (https://rustup.rs)");
    if (!Bun.which("cc") && !Bun.which("clang")) missing.push("C compiler (xcode-select --install)");
    if (missing.length > 0) throw new Error(`Missing macOS native build prerequisites: ${missing.join(", ")}.`);
  } else if (!cargoExecutable) {
    throw new Error("Rust Cargo is required to build the Tarve native runtime. Install the stable Rust toolchain from https://rustup.rs and retry.");
  }
  const env = { ...process.env };
  // Matches LSMinimumSystemVersion in the .app Info.plist (packages/core/macos-bundle.ts).
  if (config.platform === "darwin") env.MACOSX_DEPLOYMENT_TARGET ??= "11.0";
  if (release && config.platform === "win32") {
    // Keep the CRT inside our DLL; no allocator ownership crosses the C ABI.
    if (env.CARGO_ENCODED_RUSTFLAGS !== undefined) env.CARGO_ENCODED_RUSTFLAGS += "\u001f-Ctarget-feature=+crt-static";
    else env.RUSTFLAGS = `${env.RUSTFLAGS ?? ""} -Ctarget-feature=+crt-static`.trim();
  }
  const targetDirectory = join(root, features ? "native/target-variants" : "native/target");
  const cargo = Bun.spawn([
    cargoExecutable!, "build", "--locked", "--manifest-path", join(root, "native/Cargo.toml"),
    "--target-dir", targetDirectory, ...(release ? ["--release"] : []),
    ...(features ? ["--no-default-features", "--features", ["mimalloc", "fxhash", ...features].join(",")] : []),
  ], { cwd: root, env, stdout: "inherit", stderr: "inherit" });
  if (await cargo.exited !== 0) throw new Error("Native build failed");
  return join(targetDirectory, release ? "release" : "debug", config.nativeName);
}
