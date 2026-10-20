// Copies the Tarve counter into a pinned PocketJS checkout, compiles it with MicroTS, runs its Rust tests and builds dist/CounterMicroTS.exe.
import { cp, rm } from "node:fs/promises";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { writeFileSync, copyFileSync, mkdirSync } from "node:fs";

const POCKETJS = "https://github.com/pocket-nexus/pocketjs";
const COMMIT = "96e5f4084c2da45d72997c443fd478bcffb92dc7";
const root = resolve(import.meta.dir, ".pocketjs");
const app = resolve(root, "apps/tarve-counter");

function run(cmd: string[], cwd = root) {
  console.log("$", cmd.join(" "));
  const { exitCode } = Bun.spawnSync(cmd, { cwd, stdio: ["inherit", "inherit", "inherit"] });
  if (exitCode !== 0) process.exit(exitCode ?? 1);
}

if (!existsSync(root)) {
  run(["git", "init", "-q", root], import.meta.dir);
  run(["git", "remote", "add", "origin", POCKETJS]);
}
if (Bun.spawnSync(["git", "rev-parse", "HEAD"], { cwd: root }).stdout.toString().trim() !== COMMIT) {
  run(["git", "fetch", "-q", "--depth", "1", "origin", COMMIT]);
  run(["git", "checkout", "-q", "FETCH_HEAD"]);
}
if (!existsSync(resolve(root, "node_modules"))) run(["bun", "install"]);

await rm(app, { recursive: true, force: true });
await cp(resolve(import.meta.dir, "app"), app, { recursive: true });
run(["bun", "microts/compiler/cli.ts", "build", "tarve-counter", "--strict"]);
const { analyzeAot } = await import(resolve(root, "microts/compiler/aot-build.ts"));
const { bakeAtlases } = await import(resolve(root, "framework/compiler/bake-font.ts"));
const fonts = await bakeAtlases({ codepoints: [], slots: analyzeAot(resolve(app, "app.tsx"), { strict: true }).styles.usedFontSlots });
for (const font of fonts) writeFileSync(resolve(app, `gen/font-${font.slot}.bin`), font.bytes);
writeFileSync(resolve(app, "gen/fonts.rs"), `fn load_fonts(ui: &mut microts::Ui) {\n${fonts.map((font: { slot: number }) => `    assert!(ui.core_mut().load_font_atlas(include_bytes!("font-${font.slot}.bin")));`).join("\n")}\n}\n`);
run(["cargo", "test", "--manifest-path", "apps/tarve-counter/Cargo.toml", ...process.argv.slice(2)]);
run(["cargo", "build", "--release", "--manifest-path", "apps/tarve-counter/Cargo.toml"]);
const dist = resolve(import.meta.dir, "../dist");
mkdirSync(dist, { recursive: true });
copyFileSync(resolve(app, "target/release/tarve-counter-microts.exe"), resolve(dist, "CounterMicroTS.exe"));
console.log("exe", resolve(dist, "CounterMicroTS.exe"));
