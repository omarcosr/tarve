/**
 * Builds every app of the cross-framework benchmark (release builds only) and the harness.
 *   bun bench/frameworks/build.ts          ONLY=tarve,web,tauri,flutter,dioxus,egui,harness
 * FLUTTER points at flutter.bat when it is not on PATH.
 */
import { cpSync, existsSync, mkdirSync } from "node:fs";
import { join, resolve } from "node:path";

const root = resolve(import.meta.dir, "../..");
const fw = join(root, "bench/frameworks");
const work = join(root, "work/frameworks");
const only = process.env.ONLY?.split(",");
const want = (name: string) => !only || only.includes(name);
mkdirSync(work, { recursive: true });

function run(cmd: string[], cwd: string, env: Record<string, string> = {}): void {
  console.log(`> ${cmd.join(" ")}  (${cwd})`);
  const r = Bun.spawnSync(cmd, { cwd, env: { ...process.env, ...env }, stdout: "inherit", stderr: "inherit" });
  if (r.exitCode !== 0) throw new Error(`${cmd[0]} failed (${r.exitCode})`);
}

if (want("harness")) {
  run(["cargo", "build", "--release"], join(fw, "harness"), { CARGO_TARGET_DIR: join(work, "cargo-target-harness") });
  cpSync(join(work, "cargo-target-harness/release/bench-harness.exe"), join(work, "h.exe"));
}
if (want("tarve")) {
  const examples = join(root, "examples");
  run(["bun", "run", "tarve", "build", "../bench/frameworks/tarve/cross.tsx", "--outfile", "../work/frameworks/tarve-bun/bench.exe"], examples);
  run(["bun", "run", "tarve", "build", "../bench/frameworks/tarve/cross.tsx", "--runtime", "node", "--outfile", "../work/frameworks/tarve-node/bench.exe"], examples);
  run(["bun", "run", "tarve", "build", "../bench/frameworks/tarve/cross.tsx", "--runtime", "txiki", "--outfile", "../work/frameworks/tarve-txiki/bench.exe"], examples);
}
if (want("web")) {
  const web = join(fw, "web");
  run(["bun", "install"], web);
  run(["bun", "build", "main.tsx", "--outdir", "dist", "--minify", "--production"], web);
  cpSync(join(web, "index.html"), join(web, "dist/index.html"));
  const electron = join(fw, "electron");
  run(["npm", "install", "--no-audit", "--no-fund"], electron);
  if (!existsSync(join(electron, "node_modules/electron/dist/electron.exe"))) run(["node", "node_modules/electron/install.js"], electron);
  cpSync(join(web, "dist"), join(electron, "dist"), { recursive: true });
}
if (want("tauri")) {
  const icon = join(fw, "tauri/icons/icon.ico");
  if (!existsSync(icon)) {
    // 16x16 white 32-bit icon: tauri-build requires one on Windows.
    const w = 16, h = 16, bmp = new Uint8Array(40 + w * h * 4 + w * h / 8), dv = new DataView(bmp.buffer);
    dv.setUint32(0, 40, true); dv.setInt32(4, w, true); dv.setInt32(8, h * 2, true); dv.setUint16(12, 1, true); dv.setUint16(14, 32, true);
    bmp.fill(255, 40, 40 + w * h * 4);
    const head = new Uint8Array(22), hv = new DataView(head.buffer);
    hv.setUint16(2, 1, true); hv.setUint16(4, 1, true); head[6] = w; head[7] = h; hv.setUint16(10, 1, true); hv.setUint16(12, 32, true); hv.setUint32(14, bmp.length, true); hv.setUint32(18, 22, true);
    await Bun.write(icon, new Blob([head, bmp]));
  }
  run(["cargo", "build", "--release"], join(fw, "tauri"));
}
for (const crate of ["dioxus-native", "egui"]) {
  if (want(crate.split("-")[0]!)) run(["cargo", "build", "--release"], join(fw, crate), { CARGO_TARGET_DIR: join(work, "cargo-target") });
}
if (want("flutter")) run([process.env.FLUTTER ?? "flutter.bat", "build", "windows", "--release"], join(fw, "flutter"));
