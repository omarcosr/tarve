// Type-checks the native runtime for macOS from any host. C build scripts (ring, onig_sys, mimalloc)
// cross-compile through `zig cc`, which ships the macOS libc headers; no Xcode SDK is needed.
import { mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

const root = resolve(import.meta.dir, "..");
const targetDir = join(root, "native", "target-apple");
const shims = join(targetDir, "zig-shims");
const windows = process.platform === "win32";
const targets: Record<string, string> = {
  "aarch64-apple-darwin": "aarch64-macos",
  "x86_64-apple-darwin": "x86_64-macos",
};

if (!Bun.which("zig")) throw new Error("zig is required on PATH (winget install zig.zig / brew install zig).");
mkdirSync(shims, { recursive: true });

function shim(name: string, command: string): string {
  const path = join(shims, windows ? `${name}.cmd` : name);
  writeFileSync(path, windows ? `@${command} %*\r\n` : `#!/bin/sh\nexec ${command} "$@"\n`, { mode: 0o755 });
  return path;
}

const requested = process.argv.slice(2).filter((arg) => !arg.startsWith("-"));
const selected = requested.length ? requested : Object.keys(targets);
let failed = false;
for (const rustTarget of selected) {
  const zigTarget = targets[rustTarget];
  if (!zigTarget) throw new Error(`Unknown target ${rustTarget}; expected ${Object.keys(targets).join(", ")}`);
  const key = rustTarget.replaceAll("-", "_");
  const env = {
    ...process.env,
    [`CC_${key}`]: shim(`cc-${rustTarget}`, `zig cc -target ${zigTarget}`),
    [`AR_${key}`]: shim("ar", "zig ar"),
    CRATE_CC_NO_DEFAULTS: "1",
  };
  console.log(`cargo check --target ${rustTarget}`);
  const add = Bun.spawnSync(["rustup", "target", "add", rustTarget], { stdout: "ignore", stderr: "inherit" });
  if (add.exitCode !== 0) throw new Error(`rustup target add ${rustTarget} failed`);
  const check = Bun.spawnSync(
    ["cargo", "check", "--manifest-path", join(root, "native", "Cargo.toml"), "--target", rustTarget, "--target-dir", targetDir],
    { env, stdout: "inherit", stderr: "inherit" },
  );
  if (check.exitCode !== 0) failed = true;
}
process.exit(failed ? 1 : 0);
