import { join, resolve } from "node:path";
import { hostBuildTarget, targetConfig } from "../packages/core/targets";

const root = resolve(import.meta.dir, "..");

export async function buildNative(release: boolean): Promise<string> {
  const target = hostBuildTarget();
  if (!target) throw new Error(`Unsupported native platform: ${process.platform}-${process.arch}`);
  const config = targetConfig(target);
  const env = { ...process.env };
  if (release && config.platform === "win32") {
    // Keep the CRT inside our DLL; no allocator ownership crosses the C ABI.
    if (env.CARGO_ENCODED_RUSTFLAGS !== undefined) env.CARGO_ENCODED_RUSTFLAGS += "\u001f-Ctarget-feature=+crt-static";
    else env.RUSTFLAGS = `${env.RUSTFLAGS ?? ""} -Ctarget-feature=+crt-static`.trim();
  }
  const targetDirectory = join(root, "native/target");
  const cargo = Bun.spawn([
    "cargo", "build", "--locked", "--manifest-path", join(root, "native/Cargo.toml"),
    "--target-dir", targetDirectory, ...(release ? ["--release"] : []),
  ], { cwd: root, env, stdout: "inherit", stderr: "inherit" });
  if (await cargo.exited !== 0) throw new Error("Native build failed");
  return join(targetDirectory, release ? "release" : "debug", config.nativeName);
}
