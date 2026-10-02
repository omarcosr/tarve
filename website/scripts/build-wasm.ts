// Builds Tarve's WebAssembly runtime (packages/headless) and copies it next to the playground.
// Needs: rustup target add wasm32-unknown-unknown && cargo install wasm-bindgen-cli --version 0.2.129
import { cpSync, mkdirSync } from "node:fs";
import { resolve } from "node:path";

const website = resolve(import.meta.dir, "..");
const headless = resolve(website, "../packages/headless");
const out = resolve(website, "src/lib/playground/wasm");

const build = Bun.spawnSync(["bun", resolve(headless, "scripts/build-wasm.ts")], { stdout: "inherit", stderr: "inherit" });
if (build.exitCode !== 0) process.exit(build.exitCode ?? 1);
mkdirSync(out, { recursive: true });
cpSync(resolve(headless, "wasm"), out, { recursive: true });
console.log("[build-wasm] src/lib/playground/wasm/tarve_web_bg.wasm");
