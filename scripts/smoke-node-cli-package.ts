// `npx tarve package` under Node.js: builds the Node smoke app with the packaged CLI
// (`node dist/npm/cli.js package app.tsx`, the host format) and packages the formats of the
// other OSes from header-only executables through the same CLI, then checks every archive
// with the readers the unit tests use (archive-readers.ts). Cross-building a Linux/macOS app
// needs that OS's native runtime, which a Windows checkout does not have; packaging does not.
// Expects `bun run package:local` (dist/npm); TARVE_NODE_TARBALL installs a packed tarball instead.
import { strict as assert } from "node:assert";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { gunzipSync } from "node:zlib";
import { readAr, readTar, readZip, type TarEntry } from "../packages/core/archive-readers";
import { parsePlist, writeMacAppBundle } from "../packages/core/macos-bundle";
import { hostBuildTarget, isMacTarget, targetConfig } from "../packages/core/targets";
import { encodePng } from "../packages/core/src/png";

const root = resolve(import.meta.dirname, "..");
const target = hostBuildTarget();
if (!target) throw new Error("Unsupported Node CLI package smoke host");
const config = targetConfig(target);
const node = process.env.TARVE_NODE ?? "node";
const npm = process.platform === "win32" ? "npm.cmd" : "npm";
const decoder = new TextDecoder();
const directory = mkdtempSync(join(tmpdir(), "tarve-node-cli-package-"));

function run(command: string, args: string[], timeout = 300_000): string {
  const env = { ...process.env };
  delete env.TARVE_NATIVE;
  // A Node-only consumer: the CLI must default to the Node runtime, not the Bun running this script.
  delete env.npm_config_user_agent;
  const result = spawnSync(command, args, { cwd: directory, env, encoding: "utf8", timeout, shell: command === npm });
  const output = `${result.stdout ?? ""}${result.stderr ?? ""}`;
  assert.equal(result.status, 0, `Failed: ${command} ${args.join(" ")}\n${output}${result.error ? `\n${result.error.message}` : ""}`);
  return output;
}

const sha = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");

function elf(): Uint8Array {
  const bytes = new Uint8Array(4097).fill(0x41);
  bytes.set([0x7f, 0x45, 0x4c, 0x46, 2, 1, 1, 0], 0);
  new DataView(bytes.buffer).setUint16(18, 0x3e, true);
  return bytes;
}

function pe(): Uint8Array {
  const bytes = new Uint8Array(3000).fill(0x42);
  const view = new DataView(bytes.buffer);
  bytes.set([0x4d, 0x5a], 0);
  view.setUint32(0x3c, 0x80, true);
  bytes.set([0x50, 0x45, 0, 0], 0x80);
  view.setUint16(0x84, 0x8664, true);
  return bytes;
}

function machO(): Uint8Array {
  const bytes = new Uint8Array(64);
  bytes.set([0xcf, 0xfa, 0xed, 0xfe], 0);
  new DataView(bytes.buffer).setUint32(4, 0x0100000c, true);
  return bytes;
}

/** `tarve package` under Node; returns the artifact paths it printed, by format. */
function tarvePackage(cli: string, input: string, format: string): Map<string, string> {
  const output = run(node, [cli, "package", input, "--format", format]);
  const artifacts = new Map([...output.matchAll(/^(deb|tar|zip|msix|app-zip): (.+)$/gm)].map(match => [match[1]!, match[2]!.trim()]));
  for (const wanted of format.split(",")) assert.ok(artifacts.has(wanted), `tarve package printed no ${wanted} artifact:\n${output}`);
  return artifacts;
}

function checkDeb(path: string, executable: Uint8Array, exeName: string): void {
  const members = readAr(readFileSync(path));
  assert.deepEqual(members.map(member => member.name), ["debian-binary", "control.tar.gz", "data.tar.gz"]);
  assert.equal(decoder.decode(members[0]!.data), "2.0\n");
  const control = readTar(gunzipSync(members[1]!.data));
  const controlFile = decoder.decode(control.find(entry => entry.path === "./control")!.data);
  for (const line of ["Package: smoke-notes\n", "Version: 1.2.3\n", "Architecture: amd64\n", "Description: Node CLI package smoke\n"]) {
    assert.ok(controlFile.includes(line), `control lacks ${JSON.stringify(line)}:\n${controlFile}`);
  }
  assert.equal(control.find(entry => entry.path === "./postinst")!.mode, 0o755);
  const data = readTar(gunzipSync(members[2]!.data));
  const exe = data.find(entry => entry.path === `./opt/smoke-notes/${exeName}`);
  assert.ok(exe, `data.tar.gz lacks the executable: ${data.map(entry => entry.path).join(", ")}`);
  assert.equal(exe.mode, 0o755);
  assert.equal(exe.uname, "root");
  assert.equal(sha(exe.data), sha(executable));
  assert.equal(data.find(entry => entry.path === "./usr/bin/smoke-notes")!.link, `/opt/smoke-notes/${exeName}`);
  const desktop = decoder.decode(data.find(entry => entry.path === "./usr/share/applications/dev.tarve.SmokeNotes.desktop")!.data);
  assert.ok(desktop.includes("Name=Smoke Notes\n") && desktop.includes("Exec=/usr/bin/smoke-notes %U\n"), desktop);
  const md5sums = decoder.decode(control.find(entry => entry.path === "./md5sums")!.data);
  assert.ok(md5sums.includes(`${createHash("md5").update(executable).digest("hex")}  opt/smoke-notes/${exeName}\n`), md5sums);
}

function checkTar(path: string, executable: Uint8Array, exeName: string): void {
  const entries: TarEntry[] = readTar(gunzipSync(readFileSync(path)));
  assert.deepEqual(entries.map(entry => entry.path).sort(), [
    "smoke-notes-1.2.3/", "smoke-notes-1.2.3/dev.tarve.SmokeNotes.desktop", "smoke-notes-1.2.3/dev.tarve.SmokeNotes.png",
    `smoke-notes-1.2.3/${exeName}`, "smoke-notes-1.2.3/install.sh",
  ].sort());
  const exe = entries.find(entry => entry.path === `smoke-notes-1.2.3/${exeName}`)!;
  assert.equal(exe.mode, 0o755);
  assert.equal(sha(exe.data), sha(executable));
  assert.equal(entries.find(entry => entry.path.endsWith("install.sh"))!.mode, 0o755);
}

function checkZip(path: string, executable: Uint8Array, exeName: string): void {
  const entries = readZip(readFileSync(path));
  assert.deepEqual(entries.map(entry => entry.path), ["Smoke-Notes-1.2.3/", `Smoke-Notes-1.2.3/${exeName}`]);
  assert.equal(entries[1]!.mode & 0o777, 0o755);
  assert.equal(sha(entries[1]!.data), sha(executable));
}

function checkAppZip(path: string, executable: Uint8Array): void {
  const entries = new Map(readZip(readFileSync(path)).map(entry => [entry.path, entry]));
  const exe = entries.get("Smoke Notes.app/Contents/MacOS/Smoke Notes");
  assert.ok(exe, `app-zip lacks the executable: ${[...entries.keys()].join(", ")}`);
  assert.equal(exe.mode & 0o777, 0o755);
  assert.equal(sha(exe.data), sha(executable));
  const plist = entries.get("Smoke Notes.app/Contents/Info.plist")!;
  assert.equal(plist.mode & 0o777, 0o644);
  assert.equal(parsePlist(decoder.decode(plist.data)).CFBundleIdentifier, "dev.tarve.SmokeNotes");
}

try {
  writeFileSync(join(directory, "package.json"), JSON.stringify({
    name: "smoke-notes", version: "1.2.3", private: true, type: "module", description: "Node CLI package smoke",
    author: "Tarve Smoke <smoke@tarve.dev>", tarve: { name: "Smoke Notes", icon: "icon.png", appId: "dev.tarve.SmokeNotes" },
  }));
  writeFileSync(join(directory, "icon.png"), encodePng(new Uint8Array(64 * 64 * 4).fill(200), 64, 64));
  mkdirSync(join(directory, "assets"));
  writeFileSync(join(directory, "app.tsx"), readFileSync(join(root, "examples/node-smoke/node-smoke.tsx"), "utf8").replaceAll("../assets/", "./assets/"));
  copyFileSync(join(root, "examples/assets/studio.png"), join(directory, "assets/studio.png"));
  if (process.env.TARVE_NODE_TARBALL) {
    run(npm, ["install", "--ignore-scripts", "--no-audit", "--no-fund", resolve(process.env.TARVE_NODE_TARBALL)], 240_000);
  } else {
    // The local staging (dist/npm + native/) has the published layout; link it as the installed package.
    if (!existsSync(join(root, "dist/npm/cli.js"))) throw new Error("dist/npm/cli.js is missing: run `bun run package:local` first.");
    mkdirSync(join(directory, "node_modules/@tarve"), { recursive: true });
    symlinkSync(root, join(directory, "node_modules/@tarve/core"), "junction");
  }
  const cli = join(directory, "node_modules/@tarve/core/dist/npm/cli.js");

  // 1. Build + package the real app for this OS (the format `tarve package app.tsx` defaults to).
  const hostFormat = config.platform === "win32" ? "zip" : isMacTarget(target) ? "app-zip" : "deb,tar";
  const built = tarvePackage(cli, "app.tsx", hostFormat);
  const exeName = `Smoke Notes${config.executableSuffix}`.replaceAll(" ", "");
  const distExecutables = readdirSync(join(directory, "dist")).filter(name => name.startsWith("Smoke") && !/\.(zip|deb|tar\.gz)$/.test(name));
  assert.ok(distExecutables.length > 0, `tarve package app.tsx built no executable in dist/: ${readdirSync(join(directory, "dist")).join(", ")}`);
  if (isMacTarget(target)) {
    const app = join(directory, "dist", "Smoke Notes.app");
    checkAppZip(built.get("app-zip")!, readFileSync(join(app, "Contents/MacOS/Smoke Notes")));
  } else {
    const executablePath = join(directory, "dist", distExecutables.find(name => name.replaceAll(" ", "") === exeName) ?? distExecutables[0]!);
    const executable = readFileSync(executablePath);
    const name = executablePath.slice(executablePath.lastIndexOf(config.platform === "win32" ? "\\" : "/") + 1);
    if (config.platform === "win32") checkZip(built.get("zip")!, executable, name);
    else { checkDeb(built.get("deb")!, executable, name); checkTar(built.get("tar")!, executable, name); }
    // The packaged executable is the app: it renders headless and prints its marker.
    assert.ok(run(executablePath, []).includes("tarve-node-ready"), "the built executable did not render");
  }

  // 2. The other OSes' formats from header-only executables, through the same Node CLI.
  const fixtures = join(directory, "fixtures");
  mkdirSync(fixtures);
  if (config.platform !== "linux") {
    const linux = join(fixtures, "SmokeNotes");
    writeFileSync(linux, elf());
    const artifacts = tarvePackage(cli, linux, "deb,tar");
    checkDeb(artifacts.get("deb")!, elf(), "SmokeNotes");
    checkTar(artifacts.get("tar")!, elf(), "SmokeNotes");
  }
  if (config.platform !== "win32") {
    const windows = join(fixtures, "SmokeNotes.exe");
    writeFileSync(windows, pe());
    checkZip(tarvePackage(cli, windows, "zip").get("zip")!, pe(), "SmokeNotes.exe");
  }
  if (!isMacTarget(target)) {
    const app = writeMacAppBundle(join(fixtures, "Smoke Notes.app"), {
      executable: machO(), nativeLibrary: Uint8Array.of(0xcf, 0xfa, 0xed, 0xfe, 1, 2, 3),
      metadata: { name: "Smoke Notes", version: "1.2.3", appId: "dev.tarve.SmokeNotes" },
    });
    checkAppZip(tarvePackage(cli, app, "app-zip").get("app-zip")!, machO());
  }
  console.log(`Tarve Node CLI package smoke PASS (node ${run(node, ["--version"]).trim()}: built ${hostFormat}, packaged deb, tar, zip, app-zip)`);
} finally {
  rmSync(directory, { recursive: true, force: true });
}
