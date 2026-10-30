import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_ANDROID_PERMISSIONS, abisOf, androidConfig, androidManifest, androidPackageName, androidPermissionName, androidVersionCode, appBundleModule, crc32, readZip, writeZip, zipEntry } from "./android-build";

describe("Android APK metadata", () => {
  test("package names come from the app id, else the name", () => {
    expect(androidPackageName("Acme.Notes", "Notes")).toBe("acme.notes");
    expect(androidPackageName(undefined, "My Counter")).toBe("dev.tarve.my_counter");
    expect(androidPackageName("Single", "x")).toBe("dev.tarve.single");
    expect(androidPackageName("com.1st-party.App", "x")).toBe("com.app_1st_party.app");
  });

  test("version codes order like the semantic version", () => {
    expect(androidVersionCode(undefined)).toBe(1);
    expect(androidVersionCode("1.2.3")).toBe(10203);
    expect(androidVersionCode("2.0.0-beta.1")).toBeGreaterThan(androidVersionCode("1.99.99"));
  });

  test("targets pick their ABIs", () => {
    expect(abisOf("android")).toEqual(["arm64-v8a", "x86_64"]);
    expect(abisOf("android-arm64")).toEqual(["arm64-v8a"]);
    expect(abisOf("android-x64")).toEqual(["x86_64"]);
  });

  test("the manifest runs the runtime in TarveActivity (a NativeActivity)", () => {
    const manifest = androidManifest({ packageName: "dev.tarve.app", label: "A & B", versionCode: 3, versionName: "0.0.3", icon: false });
    expect(manifest).toContain('android:name="dev.tarve.TarveActivity"');
    expect(manifest).toContain('android:launchMode="singleTask"');
    // API 35 is edge-to-edge: TarveActivity reports the window insets the UI is laid out in.
    expect(manifest).toContain('android:targetSdkVersion="35"');
    // share() hands files out through the app's own provider, not exported.
    expect(manifest).toContain('<provider android:name="dev.tarve.TarveFileProvider" android:authorities="dev.tarve.app.tarve.files" android:exported="false" android:grantUriPermissions="true"/>');
    expect(manifest).toContain('<uses-permission android:name="android.permission.USE_BIOMETRIC"/>');
    expect(manifest).not.toContain("ACCESS_FINE_LOCATION");
    expect(manifest).toContain('android:value="tarve_native"');
    expect(manifest).toContain('android:label="A &#38; B"');
    expect(manifest).not.toContain("@mipmap/ic_launcher");
    expect(manifest).toContain('android:name="dev.tarve.TarveMediaService"');
    expect(manifest).toContain('android:foregroundServiceType="mediaPlayback"');
    expect(manifest).toContain('android:name="dev.tarve.TarvePermissions"');
    expect(manifest).toContain('android:name="dev.tarve.TarveNotificationOpen"');
    // Timed and place notifications: re-armed after a reboot or an update.
    expect(manifest).toMatch(/<receiver android:name="dev.tarve.TarveScheduledNotifications" android:exported="false">[\s\S]*BOOT_COMPLETED[\s\S]*MY_PACKAGE_REPLACED[\s\S]*<\/receiver>/);
    expect(manifest).toContain('android:extractNativeLibs="false"');
  });

  test("apps add manifest permissions on top of the defaults", () => {
    expect(androidPermissionName("CAMERA")).toBe("android.permission.CAMERA");
    expect(androidPermissionName("com.example.READ")).toBe("com.example.READ");
    expect(() => androidPermissionName("bad name")).toThrow(TypeError);
    const manifest = androidManifest({ packageName: "dev.tarve.app", label: "A", versionCode: 1, versionName: "1", icon: false, permissions: ["CAMERA", "INTERNET", "android.permission.RECORD_AUDIO"] });
    const declared = [...manifest.matchAll(/<uses-permission android:name="([^"]+)"/g)].map(match => match[1]);
    expect(declared).toEqual([...DEFAULT_ANDROID_PERMISSIONS, "android.permission.CAMERA", "android.permission.RECORD_AUDIO"]);
  });

  test("package.json tarve.android.permissions, per app too", () => {
    const directory = mkdtempSync(join(tmpdir(), "tarve-android-config-"));
    try {
      writeFileSync(join(directory, "package.json"), JSON.stringify({ tarve: { android: { permissions: ["CAMERA"] }, apps: { "b.tsx": { android: { permissions: ["RECORD_AUDIO"] } } } } }));
      expect(androidConfig(join(directory, "a.tsx")).permissions).toEqual(["CAMERA"]);
      expect(androidConfig(join(directory, "b.tsx")).permissions).toEqual(["CAMERA", "RECORD_AUDIO"]);
      writeFileSync(join(directory, "package.json"), JSON.stringify({ tarve: { android: { permissions: "CAMERA" } } }));
      expect(() => androidConfig(join(directory, "a.tsx"))).toThrow(TypeError);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  test("file types open documents through VIEW intent-filters", () => {
    const manifest = androidManifest({ packageName: "a.b", label: "A", versionCode: 1, versionName: "1", icon: false, protocols: ["myapp"], fileTypes: [{ ext: "md", name: "Markdown", mime: "text/markdown" }, { ext: ".TarveNote", name: "Note" }] });
    const activity = manifest.slice(manifest.indexOf('android:name="dev.tarve.TarveActivity"'), manifest.indexOf("</activity>"));
    expect(activity).toContain('<data android:scheme="myapp"/>');
    expect(activity).toContain('<data android:mimeType="text/markdown"/>');
    expect(activity).toContain('<data android:pathPattern=".*\\\\.tarvenote"/>');
    expect(activity.match(/<data android:scheme="content"\/>/g)).toHaveLength(2);
  });

  test("an App Bundle module moves the manifest and dex", () => {
    const bytes = new Uint8Array([1]);
    const module = appBundleModule([zipEntry("AndroidManifest.xml", bytes, true), zipEntry("resources.pb", bytes, true), zipEntry("res/mipmap/ic_launcher.png", bytes, false)], [zipEntry("classes.dex", bytes, true), zipEntry("lib/x86_64/libtarve_native.so", bytes, false), zipEntry("assets/tarve/app.js", bytes, true)]);
    expect(module.map(entry => entry.name)).toEqual(["manifest/AndroidManifest.xml", "resources.pb", "res/mipmap/ic_launcher.png", "dex/classes.dex", "lib/x86_64/libtarve_native.so", "assets/tarve/app.js"]);
    expect(androidManifest({ packageName: "a.b", label: "A", versionCode: 1, versionName: "1", icon: false, bundle: true })).not.toContain("extractNativeLibs");
    // A Bun app's executable must be extracted to run.
    expect(androidManifest({ packageName: "a.b", label: "A", versionCode: 1, versionName: "1", icon: false, extractNativeLibs: true })).toContain('android:extractNativeLibs="true"');
    // Plain http:// (a LAN media server) only when the app asks for it in package.json.
    expect(androidManifest({ packageName: "a.b", label: "A", versionCode: 1, versionName: "1", icon: false })).not.toContain("usesCleartextTraffic");
    expect(androidManifest({ packageName: "a.b", label: "A", versionCode: 1, versionName: "1", icon: false, cleartextTraffic: true })).toContain('android:usesCleartextTraffic="true"');
  });
});

describe("APK ZIP writer", () => {
  test("crc32 matches the ZIP polynomial", () => {
    expect(crc32(new TextEncoder().encode("123456789"))).toBe(0xcbf43926);
  });

  test("entries round-trip and stored libraries start at page boundaries", () => {
    const text = new TextEncoder().encode("hello ".repeat(100));
    const library = new Uint8Array(5000).map((_, index) => index & 0xff);
    const zip = writeZip([zipEntry("assets/a.txt", text, true), zipEntry("lib/x86_64/libx.so", library, false), zipEntry("odd", new Uint8Array([1]), false)], name => name.endsWith(".so") ? 16384 : 4);
    const entries = readZip(zip);
    expect(entries.map(entry => [entry.name, entry.method])).toEqual([["assets/a.txt", 8], ["lib/x86_64/libx.so", 0], ["odd", 0]]);
    const so = entries[1]!;
    expect(so.data.byteOffset % 16384).toBe(0);
    expect([...so.data]).toEqual([...library]);
    expect(entries[2]!.data.byteOffset % 4).toBe(0);
    expect(entries[0]!.size).toBe(text.length);
  });
});
