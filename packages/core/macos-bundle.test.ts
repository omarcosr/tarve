import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readZip as readZipEntries } from "./archive-readers";
import {
  ICNS_ICON_TYPES, bundleExecutableName, bundleIdentifier, bundleVersion, encodeIcns, encodePlist, icnsFromImage,
  infoPlist, macAppBundleEntries, macAppPath, parseIcns, parsePlist, readMacAppBundle, writeMacAppBundle,
} from "./macos-bundle";
import { executableInfo, packageApp, packageFormatPlatform, parsePackageFormats } from "./package-installer";
import { decodePng, encodePng } from "./src/png";
import { generateUpdateKeys, release } from "./updates-build";
import { verifyUpdateManifest } from "./src/updates";

const root = mkdtempSync(join(tmpdir(), "tarve-macos-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));

/** A thin arm64 Mach-O header (MH_MAGIC_64 little-endian, CPU_TYPE_ARM64) and some padding. */
function machO(arch: "arm64" | "x64" = "arm64"): Uint8Array {
  const bytes = new Uint8Array(64);
  bytes.set([0xcf, 0xfa, 0xed, 0xfe], 0);
  new DataView(bytes.buffer).setUint32(4, arch === "arm64" ? 0x0100000c : 0x01000007, true);
  return bytes;
}

function solidPng(size: number): Uint8Array {
  const rgba = new Uint8Array(size * size * 4);
  for (let index = 0; index < rgba.length; index += 4) rgba.set([0x10, 0x80, 0xf0, 0xff], index);
  return encodePng(rgba, size, size);
}

function readZip(bytes: Uint8Array): Map<string, { data: Uint8Array; mode: number }> {
  return new Map(readZipEntries(bytes).map(entry => [entry.path, { data: entry.data, mode: entry.mode & 0o777 }]));
}

function buildApp(name = "Acme Notes"): string {
  const icon = join(root, "icon.png");
  writeFileSync(icon, solidPng(300));
  return writeMacAppBundle(join(root, `${name}.app`), {
    executable: machO(), nativeLibrary: Uint8Array.of(0xcf, 0xfa, 0xed, 0xfe, 1, 2, 3),
    metadata: { name, version: "1.2.3-beta.1", appId: "com.acme.notes", copyright: "© Acme & Co", icon }, icon: readFileSync(icon),
  });
}

describe("Info.plist", () => {
  test("has the bundle keys macOS reads, and parses back", () => {
    const text = infoPlist({ name: "Acme <Notes>", executable: "Acme Notes", identifier: "com.acme.notes", version: "1.2.3", iconFile: "AppIcon.icns", copyright: "© Acme & Co" });
    expect(text).toStartWith(`<?xml version="1.0" encoding="UTF-8"?>`);
    expect(text).toContain("<string>Acme &lt;Notes&gt;</string>");
    expect(parsePlist(text)).toEqual({
      CFBundleDevelopmentRegion: "en",
      CFBundleDisplayName: "Acme <Notes>",
      CFBundleExecutable: "Acme Notes",
      CFBundleIconFile: "AppIcon.icns",
      CFBundleIdentifier: "com.acme.notes",
      CFBundleInfoDictionaryVersion: "6.0",
      CFBundleName: "Acme <Notes>",
      CFBundlePackageType: "APPL",
      CFBundleShortVersionString: "1.2.3",
      CFBundleVersion: "1.2.3",
      LSMinimumSystemVersion: "11.0",
      NSHighResolutionCapable: true,
      NSHumanReadableCopyright: "© Acme & Co",
      NSSupportsAutomaticGraphicsSwitching: true,
    });
  });

  test("encodes and parses nested values", () => {
    const value = { list: ["a", 1, 2.5, false, []], nested: { empty: "", deep: { ok: true } }, none: {} };
    expect(parsePlist(encodePlist(value))).toEqual(value);
    expect(() => parsePlist("<plist><array/></plist>")).toThrow("root is not a dict");
  });

  test("derives identifier, version and executable name", () => {
    expect(bundleIdentifier({ name: "Acme Notes", appId: "Acme.Notes_App" })).toBe("Acme.Notes-App");
    expect(bundleIdentifier({ name: "Acme Notes" })).toBe("dev.tarve.acme-notes");
    expect(bundleVersion("v1.2.3-beta.1+5")).toBe("1.2.3");
    expect(bundleVersion("2")).toBe("2");
    expect(bundleVersion(undefined)).toBe("1.0.0");
    expect(() => bundleVersion("beta")).toThrow("macOS bundle version");
    expect(bundleExecutableName("A/B:C")).toBe("A-B-C");
    expect(macAppPath("dist/App")).toBe("dist/App.app");
    expect(macAppPath("dist/App.app")).toBe("dist/App.app");
  });
});

describe("icns", () => {
  test("round-trips the container", () => {
    const entries = [{ type: "ic07", data: Uint8Array.of(1, 2, 3) }, { type: "ic10", data: new Uint8Array(1000).fill(7) }];
    const bytes = encodeIcns(entries);
    expect(new TextDecoder().decode(bytes.subarray(0, 4))).toBe("icns");
    expect(new DataView(bytes.buffer).getUint32(4)).toBe(bytes.length);
    expect(parseIcns(bytes)).toEqual(entries);
    expect(() => parseIcns(bytes.subarray(0, bytes.length - 1))).toThrow("does not match");
    expect(() => parseIcns(Uint8Array.of(1, 2, 3, 4, 0, 0, 0, 8))).toThrow("not an icns");
    expect(() => encodeIcns([{ type: "toolong", data: new Uint8Array() }])).toThrow("Invalid icns type");
  });

  test("makes PNG entries up to the source size", () => {
    const small = parseIcns(icnsFromImage(solidPng(64)));
    expect(small.map(entry => entry.type)).toEqual(["ic07"]);
    const large = parseIcns(icnsFromImage(solidPng(600)));
    expect(large.map(entry => entry.type)).toEqual(["ic07", "ic08", "ic09"]);
    for (const entry of large) {
      const size = ICNS_ICON_TYPES.find(icon => icon.type === entry.type)!.size;
      const image = decodePng(entry.data);
      expect([image.width, image.height]).toEqual([size, size]);
      expect([...image.rgba.subarray(0, 4)]).toEqual([0x10, 0x80, 0xf0, 0xff]);
    }
    expect(() => icnsFromImage(Uint8Array.of(1, 2, 3))).toThrow("must be a PNG");
  });
});

describe(".app bundle", () => {
  test("lays out Info.plist, the executable, the dylib and the icon", () => {
    const entries = macAppBundleEntries({ executable: machO(), nativeLibrary: Uint8Array.of(9), metadata: { name: "Notes" }, icon: solidPng(128) });
    expect(entries.map(entry => entry.path)).toEqual([
      "Contents/", "Contents/Info.plist", "Contents/PkgInfo", "Contents/MacOS/", "Contents/MacOS/Notes",
      "Contents/Frameworks/", "Contents/Frameworks/libtarve_native.dylib", "Contents/Resources/", "Contents/Resources/AppIcon.icns",
    ]);
    expect(entries.find(entry => entry.path === "Contents/MacOS/Notes")!.mode).toBe(0o755);
    const plist = parsePlist(new TextDecoder().decode(entries[1]!.data));
    expect(plist.CFBundleIdentifier).toBe("dev.tarve.notes");
    expect(plist.CFBundleIconFile).toBe("AppIcon.icns");
    const plain = macAppBundleEntries({ executable: machO(), nativeLibrary: Uint8Array.of(9), metadata: { name: "Notes" } });
    expect(plain.some(entry => entry.path.includes("Resources"))).toBe(false);
    expect(parsePlist(new TextDecoder().decode(plain[1]!.data)).CFBundleIconFile).toBeUndefined();
  });

  test("writes the bundle to disk and reads it back", () => {
    const app = buildApp();
    const bundle = readMacAppBundle(app);
    expect(bundle.plist.CFBundleExecutable).toBe("Acme Notes");
    expect(bundle.plist.CFBundleVersion).toBe("1.2.3");
    expect(bundle.plist.NSHumanReadableCopyright).toBe("© Acme & Co");
    expect(existsSync(join(app, "Contents/Frameworks/libtarve_native.dylib"))).toBe(true);
    expect(parseIcns(readFileSync(join(app, "Contents/Resources/AppIcon.icns"))).map(entry => entry.type)).toEqual(["ic07", "ic08"]);
    expect(executableInfo(app)).toEqual({ platform: "darwin", arch: "arm64" });
    expect(() => readMacAppBundle(root)).toThrow("not a macOS app bundle");
  });
});

describe("tarve package --format app-zip", () => {
  test("zips the .app with executable modes", () => {
    const app = buildApp();
    const [artifact] = packageApp({ executable: app, outDir: join(root, "out"), version: "1.2.3", mtime: 1_700_000_000 });
    expect(artifact!.format).toBe("app-zip");
    expect(artifact!.path).toBe(join(root, "out", "Acme-Notes-1.2.3-macos-arm64.zip"));
    const zip = readZip(readFileSync(artifact!.path));
    expect(zip.get("Acme Notes.app/Contents/MacOS/Acme Notes")!.mode).toBe(0o755);
    expect(zip.get("Acme Notes.app/Contents/Frameworks/libtarve_native.dylib")!.mode).toBe(0o755);
    expect(zip.get("Acme Notes.app/Contents/Info.plist")!.mode).toBe(0o644);
    expect(parsePlist(new TextDecoder().decode(zip.get("Acme Notes.app/Contents/Info.plist")!.data)).CFBundleIdentifier).toBe("com.acme.notes");
    expect([...zip.get("Acme Notes.app/Contents/MacOS/Acme Notes")!.data]).toEqual([...machO()]);
  });

  test("rejects other formats for a .app and app-zip for other executables", () => {
    const app = buildApp();
    expect(() => packageApp({ executable: app, format: "deb", outDir: join(root, "out"), version: "1.0.0" })).toThrow("Linux executable");
    expect(() => packageApp({ executable: app, format: "zip", outDir: join(root, "out") })).toThrow("app-zip");
    const bare = join(root, "bare");
    writeFileSync(bare, machO("x64"));
    expect(executableInfo(bare)).toEqual({ platform: "darwin", arch: "x64" });
    expect(() => packageApp({ executable: bare, format: "app-zip", outDir: join(root, "out") })).toThrow("needs a macOS .app bundle");
    expect(packageFormatPlatform("app-zip")).toBe("darwin");
    expect(parsePackageFormats("app-zip")).toEqual(["app-zip"]);
    expect(() => parsePackageFormats("dmg")).toThrow("hdiutil");
  });
});

describe("tarve release with a macOS bundle", () => {
  test("zips the .app as the darwin artifact", () => {
    const app = buildApp("Rel");
    const keys = generateUpdateKeys();
    const out = join(root, "updates");
    const path = release({ version: "1.0.0", artifacts: [`darwin-arm64=${app}`], privateKey: keys.privateKey, outDir: out });
    const manifest = verifyUpdateManifest(JSON.parse(readFileSync(path, "utf8")), keys.publicKey);
    expect(manifest.platforms["darwin-arm64"]!.url).toBe("Rel-1.0.0-darwin-arm64.zip");
    const zip = readZip(readFileSync(join(out, "Rel-1.0.0-darwin-arm64.zip")));
    expect(zip.has("Rel.app/Contents/MacOS/Rel")).toBe(true);
  });

  test("rejects folders that are not bundles, and signing off macOS", () => {
    const keys = generateUpdateKeys();
    const folder = join(root, "plain");
    mkdirSync(folder, { recursive: true });
    expect(() => release({ version: "1.0.0", artifacts: [`darwin-arm64=${folder}`], privateKey: keys.privateKey, outDir: join(root, "u2") })).toThrow("must be a .app bundle");
    const app = buildApp("Signed");
    if (process.platform !== "darwin") {
      expect(() => release({ version: "1.0.0", artifacts: [`darwin-arm64=${app}`], privateKey: keys.privateKey, outDir: join(root, "u3"), macSign: { identity: "Developer ID Application: Acme (TEAM)" } }))
        .toThrow("needs macOS");
    }
    const zip = join(root, "App.zip");
    writeFileSync(zip, Uint8Array.of(0x50, 0x4b, 0x03, 0x04, 0, 0));
    expect(() => release({ version: "1.0.0", artifacts: [`darwin-arm64=${zip}`], privateKey: keys.privateKey, outDir: join(root, "u4"), macSign: { identity: "-" } }))
      .toThrow("Pass the .app bundle");
  });
});
