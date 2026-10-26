// Compiles Tarve's native crate to WebAssembly for @tarve/headless.
// Needs: rustup target add wasm32-unknown-unknown && cargo install wasm-bindgen-cli --version 0.2.129
import { resolve } from "node:path";

const root = resolve(import.meta.dir, "../../..");
const native = resolve(root, "native");
const out = resolve(import.meta.dir, "../wasm");

// Two builds of the same crate, picked at load time by feature detection (src/runtime.ts):
// - simd: vello_cpu rasterizes with wasm simd128, about twice as fast (Bun, Node.js, browsers).
// - baseline: no SIMD, for engines without it (txiki.js's WAMR). It renders the same pixels.
// Each has its own target directory: RUSTFLAGS differ, and sharing one would rebuild everything.
const builds = [
  { name: "simd", rustflags: "-C target-feature=+simd128", targetDir: resolve(native, "target"), outDir: out },
  { name: "baseline", rustflags: "", targetDir: resolve(native, "target/wasm-baseline"), outDir: resolve(out, "baseline") },
];

function run(command: string[], env: Record<string, string | undefined>): void {
  const result = Bun.spawnSync(command, { cwd: native, env, stdout: "inherit", stderr: "inherit" });
  if (result.exitCode !== 0) process.exit(result.exitCode ?? 1);
}

for (const build of builds) {
  const env = { ...process.env, RUSTFLAGS: [process.env.RUSTFLAGS, build.rustflags].filter(Boolean).join(" ") };
  run(["cargo", "build", "--release", "--target", "wasm32-unknown-unknown", "--target-dir", build.targetDir, "--no-default-features", "--features", "fxhash", "--lib"], env);
  run([
    "wasm-bindgen",
    resolve(build.targetDir, "wasm32-unknown-unknown/release/tarve_native.wasm"),
    "--target",
    "web",
    "--out-dir",
    build.outDir,
    "--out-name",
    "tarve_web",
  ], env);
  console.log(`[build-wasm] ${build.name}: ${resolve(build.outDir, "tarve_web_bg.wasm")}`);
}
