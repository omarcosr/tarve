import { afterAll, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gunzipSync } from "node:zlib";
import { createTar } from "./archive-formats";
import { readAr, readTar, readZip } from "./archive-readers";
import { debianPackageName, executableInfo, msixVersion, packageApp, parsePackageFormats } from "./package-installer";
import { encodePng } from "./src/png";

const decoder = new TextDecoder();
const root = mkdtempSync(join(tmpdir(), "tarve-package-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));

// ---- fixtures -----------------------------------------------------------------

function elf(): Uint8Array {
  const bytes = new Uint8Array(4097).fill(0x41); // odd size: exercises ar padding
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

function project(name: string): string {
  const directory = join(root, name);
  mkdirSync(join(directory, "dist"), { recursive: true });
  const rgba = new Uint8Array(64 * 64 * 4).fill(200);
  writeFileSync(join(directory, "icon.png"), encodePng(rgba, 64, 64));
  writeFileSync(join(directory, "package.json"), JSON.stringify({
    name, version: "1.2.3", description: "Notes app", author: "Acme Inc. <dev@acme.test>",
    tarve: { name: "Acme Notes", icon: "icon.png", appId: "Acme.Notes" },
  }));
  return directory;
}

const MTIME = 1_700_000_000;

// ---- tests --------------------------------------------------------------------

describe("tarve package", () => {
  const linux = project("linux-app");
  const linuxExe = join(linux, "dist", "AcmeNotes");
  writeFileSync(linuxExe, elf());
  const windows = project("windows-app");
  const windowsExe = join(windows, "dist", "AcmeNotes.exe");
  writeFileSync(windowsExe, pe());

  test("reads the executable platform from its header", () => {
    expect(executableInfo(linuxExe)).toEqual({ platform: "linux", arch: "x64" });
    expect(executableInfo(windowsExe)).toEqual({ platform: "win32", arch: "x64" });
    const text = join(root, "not-an-exe.txt");
    writeFileSync(text, "hello");
    expect(() => executableInfo(text)).toThrow(/not a Linux/);
  });

  test("writes a .deb that parses back as ar + control/data tarballs", () => {
    const [artifact] = packageApp({ executable: linuxExe, format: "deb", categories: "Office;Utility", mtime: MTIME });
    expect(artifact!.path).toBe(join(linux, "dist", "acme-notes_1.2.3_amd64.deb"));
    const members = readAr(new Uint8Array(readFileSync(artifact!.path)));
    expect(members.map(member => member.name)).toEqual(["debian-binary", "control.tar.gz", "data.tar.gz"]);
    expect(decoder.decode(members[0]!.data)).toBe("2.0\n");

    const control = readTar(new Uint8Array(gunzipSync(members[1]!.data)));
    const controlFile = decoder.decode(control.find(entry => entry.path === "./control")!.data);
    expect(controlFile).toContain("Package: acme-notes\n");
    expect(controlFile).toContain("Version: 1.2.3\n");
    expect(controlFile).toContain("Architecture: amd64\n");
    expect(controlFile).toContain("Maintainer: Acme Inc.\n");
    expect(controlFile).toContain("Description: Notes app\n");
    expect(controlFile.endsWith("\n")).toBe(true);
    expect(control.find(entry => entry.path === "./postinst")!.mode).toBe(0o755);

    const data = readTar(new Uint8Array(gunzipSync(members[2]!.data)));
    const paths = data.map(entry => entry.path);
    expect(paths).toContain("./opt/acme-notes/");
    expect(paths).toContain("./usr/share/icons/hicolor/64x64/apps/");
    const exe = data.find(entry => entry.path === "./opt/acme-notes/AcmeNotes")!;
    expect(exe.type).toBe("0");
    expect(exe.mode).toBe(0o755);
    expect(exe.uname).toBe("root");
    expect(Buffer.from(exe.data).equals(Buffer.from(elf()))).toBe(true);
    const link = data.find(entry => entry.path === "./usr/bin/acme-notes")!;
    expect(link.type).toBe("2");
    expect(link.link).toBe("/opt/acme-notes/AcmeNotes");
    const desktop = decoder.decode(data.find(entry => entry.path === "./usr/share/applications/Acme.Notes.desktop")!.data);
    expect(desktop).toContain("Name=Acme Notes\n");
    expect(desktop).toContain("Exec=/usr/bin/acme-notes %U\n");
    expect(desktop).toContain("Icon=Acme.Notes\n");
    expect(desktop).toContain("StartupWMClass=Acme.Notes\n");
    expect(desktop).toContain("Categories=Office;Utility;\n");
    const icon = data.find(entry => entry.path === "./usr/share/icons/hicolor/64x64/apps/Acme.Notes.png")!;
    expect(icon.data[1]).toBe(0x50); // PNG signature

    const md5sums = decoder.decode(control.find(entry => entry.path === "./md5sums")!.data);
    expect(md5sums).toContain(`${createHash("md5").update(elf()).digest("hex")}  opt/acme-notes/AcmeNotes\n`);
    // Directories precede their contents (dpkg extracts in order).
    expect(paths.indexOf("./opt/")).toBeLessThan(paths.indexOf("./opt/acme-notes/AcmeNotes"));
  });

  test("writes a Linux .tar.gz with desktop entry and install script", () => {
    const [artifact] = packageApp({ executable: linuxExe, format: "tar", outDir: join(linux, "out"), mtime: MTIME });
    expect(artifact!.path).toBe(join(linux, "out", "acme-notes-1.2.3-linux-x64.tar.gz"));
    const entries = readTar(new Uint8Array(gunzipSync(readFileSync(artifact!.path))));
    expect(entries.map(entry => entry.path).sort()).toEqual([
      "acme-notes-1.2.3/", "acme-notes-1.2.3/Acme.Notes.desktop", "acme-notes-1.2.3/Acme.Notes.png",
      "acme-notes-1.2.3/AcmeNotes", "acme-notes-1.2.3/install.sh",
    ]);
    const install = entries.find(entry => entry.path.endsWith("install.sh"))!;
    expect(install.mode).toBe(0o755);
    expect(decoder.decode(install.data)).toContain('ln -sf "$app/"\'AcmeNotes\' "$bin/acme-notes"');
  });

  test("writes a portable .zip whose files inflate back to the executable", () => {
    const [artifact] = packageApp({ executable: windowsExe, format: "zip", mtime: MTIME });
    expect(artifact!.path).toBe(join(windows, "dist", "Acme-Notes-1.2.3-windows-x64.zip"));
    const entries = readZip(new Uint8Array(readFileSync(artifact!.path)));
    expect(entries.map(entry => entry.path)).toEqual(["Acme-Notes-1.2.3/", "Acme-Notes-1.2.3/AcmeNotes.exe"]);
    expect(Buffer.from(entries[1]!.data).equals(Buffer.from(pe()))).toBe(true);
    expect(entries[1]!.mode & 0o777).toBe(0o755);
  });

  test("defaults to deb + tar for Linux and zip for Windows", () => {
    expect(packageApp({ executable: linuxExe, outDir: join(linux, "defaults"), mtime: MTIME }).map(item => item.format)).toEqual(["deb", "tar"]);
    expect(packageApp({ executable: windowsExe, outDir: join(windows, "defaults"), mtime: MTIME }).map(item => item.format)).toEqual(["zip"]);
  });

  test("writes an MSIX layout with AppxManifest.xml when makeappx is unavailable", () => {
    const [artifact] = packageApp({ executable: windowsExe, format: "msix", makeappx: false, publisher: "Acme Inc." });
    expect(artifact!.packed).toBe(false);
    expect(artifact!.note).toContain("makeappx pack");
    const manifest = readFileSync(join(artifact!.path, "AppxManifest.xml"), "utf8");
    expect(manifest).toContain('<Identity Name="Acme.Notes" Publisher="CN=Acme Inc." Version="1.2.3.0" ProcessorArchitecture="x64" />');
    expect(manifest).toContain('Executable="AcmeNotes.exe" EntryPoint="Windows.FullTrustApplication"');
    expect(manifest).toContain('<rescap:Capability Name="runFullTrust" />');
    for (const logo of ["StoreLogo", "Square44x44Logo", "Square150x150Logo"]) expect(existsSync(join(artifact!.path, "Assets", `${logo}.png`))).toBe(true);
    expect(readFileSync(join(artifact!.path, "AcmeNotes.exe")).equals(Buffer.from(pe()))).toBe(true);
  });

  test("rejects a format for the wrong OS and invalid values", () => {
    expect(() => packageApp({ executable: windowsExe, format: "deb" })).toThrow(/Linux executable/);
    expect(() => packageApp({ executable: linuxExe, format: "msix" })).toThrow(/Windows executable/);
    expect(() => parsePackageFormats("deb,rpm")).toThrow(/rpm/);
    expect(parsePackageFormats("deb, zip,deb")).toEqual(["deb", "zip"]);
    expect(msixVersion("1.2.3-beta.1")).toBe("1.2.3.0");
    expect(() => msixVersion("1.70000")).toThrow();
    expect(debianPackageName("My Cool_App!")).toBe("my-cool-app");
    expect(debianPackageName("X")).toBe("x-app");
  });

  test("tar keeps paths over 100 bytes through the ustar prefix", () => {
    const long = `${"directory/".repeat(12)}file.txt`;
    const [entry] = readTar(createTar([{ path: long, data: new TextEncoder().encode("hi") }], MTIME));
    expect(entry!.path).toBe(long);
    expect(decoder.decode(entry!.data)).toBe("hi");
  });

  // libarchive (bsdtar, bundled with Windows 10+ and most Linux distributions) reads ar, tar and zip.
  const bsdtar = spawnSync("tar", ["--version"], { encoding: "utf8" });
  test.skipIf(bsdtar.status !== 0 || !/bsdtar|libarchive/.test(bsdtar.stdout ?? ""))("bsdtar lists the produced archives", () => {
    const deb = join(linux, "dist", "acme-notes_1.2.3_amd64.deb");
    const list = (file: string) => spawnSync("tar", ["-tf", file], { encoding: "utf8" }).stdout.split(/\r?\n/).filter(Boolean);
    expect(list(deb)).toEqual(["debian-binary", "control.tar.gz", "data.tar.gz"]);
    expect(list(join(linux, "out", "acme-notes-1.2.3-linux-x64.tar.gz"))).toContain("acme-notes-1.2.3/install.sh");
    expect(list(join(windows, "dist", "Acme-Notes-1.2.3-windows-x64.zip"))).toContain("Acme-Notes-1.2.3/AcmeNotes.exe");
  });
});
