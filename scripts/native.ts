import { join, resolve } from "node:path";

const root = resolve(import.meta.dir, "..");
const names: Record<string, string> = { win32: "tarve_native.dll", darwin: "libtarve_native.dylib", linux: "libtarve_native.so" };

export async function buildNative(release: boolean): Promise<string> {
  const name = names[process.platform];
  if (!name) throw new Error(`Unsupported native platform: ${process.platform}`);
  const env = { ...process.env };
  if (release && process.platform === "win32") {
    // Keep the CRT inside our DLL; no allocator ownership crosses the C ABI.
    if (env.CARGO_ENCODED_RUSTFLAGS !== undefined) env.CARGO_ENCODED_RUSTFLAGS += "\u001f-Ctarget-feature=+crt-static";
    else env.RUSTFLAGS = `${env.RUSTFLAGS ?? ""} -Ctarget-feature=+crt-static`.trim();
  }
  const target = join(root, "native/target");
  const cargo = Bun.spawn([
    "cargo", "build", "--locked", "--manifest-path", join(root, "native/Cargo.toml"),
    "--target-dir", target, ...(release ? ["--release"] : []),
  ], { cwd: root, env, stdout: "inherit", stderr: "inherit" });
  if (await cargo.exited !== 0) throw new Error("Native build failed");
  return join(target, release ? "release" : "debug", name);
}
