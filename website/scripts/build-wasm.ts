// Compiles Tarve's native crate to WebAssembly for the documentation playground.
// Needs: rustup target add wasm32-unknown-unknown && cargo install wasm-bindgen-cli --version 0.2.129
import { resolve } from "node:path";

const website = resolve(import.meta.dir, "..");
const native = resolve(website, "../native");

// SIMD lets vello_cpu rasterize with wasm simd128 (every current browser supports it).
const env = { ...process.env, RUSTFLAGS: [process.env.RUSTFLAGS, "-C target-feature=+simd128"].filter(Boolean).join(" ") };

function run(command: string[]): void {
  const result = Bun.spawnSync(command, { cwd: native, env, stdout: "inherit", stderr: "inherit" });
  if (result.exitCode !== 0) process.exit(result.exitCode ?? 1);
}

run([
  "cargo",
  "build",
  "--release",
  "--target",
  "wasm32-unknown-unknown",
  "--no-default-features",
  "--features",
  "fxhash",
  "--lib",
]);
run([
  "wasm-bindgen",
  resolve(native, "target/wasm32-unknown-unknown/release/tarve_native.wasm"),
  "--target",
  "web",
  "--out-dir",
  resolve(website, "src/lib/playground/wasm"),
  "--out-name",
  "tarve_web",
]);
console.log("[build-wasm] src/lib/playground/wasm/tarve_web_bg.wasm");
