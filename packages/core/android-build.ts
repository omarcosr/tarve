/**
 * `tarve build --target android`: an APK with the Tarve runtime (native/android/<abi>/
 * libtarve_native.so, a NativeActivity) and the app beside it, from either side:
 *
 * - a TSX/JS app (written for Bun or Node.js), bundled for the QuickJS-ng engine the runtime
 *   embeds on Android (android/prelude.ts, native/src/android/qjs.rs): assets/tarve/app.js;
 * - a Go app (a main package directory), built with the NDK as libtarveapp.so, whose
 *   `main` the runtime calls (native/src/android.rs).
 *
 * Needs the Android SDK (build-tools, a platform) and a JDK for signing; Go apps also the NDK.
 */
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { metadataOverrides, type BuildOptions } from "./build";
import { buildMetadata } from "./package-metadata";
import { cacheRoot } from "./node-target";
import { bundleAndroidJs, type AndroidBundle } from "./android-bundle";
import { androidFileIntentFilters, androidIntentFilters, type FileTypeAssociation } from "./src/associations";
import { resolveAppAssociations } from "./associations-config";
import { type ZipEntry, readZip, zipEntry, writeZip } from "./android-zip";
export { crc32, readZip, writeZip, zipEntry, type ZipEntry } from "./android-zip";
import { MIN_SDK, windows, exe, androidSdk, buildTools, platformJar, androidNdk, jdk, androidPackageName, androidVersionCode, escapeXml } from "./android-sdk";
export { androidNdk, androidPackageName, androidSdk, androidVersionCode } from "./android-sdk";

export const ANDROID_ABIS = ["arm64-v8a", "x86_64"] as const;
export type AndroidAbi = typeof ANDROID_ABIS[number];
export const ANDROID_TARGETS = ["android", "android-arm64", "android-x64"] as const;
export type AndroidTarget = typeof ANDROID_TARGETS[number];

export interface AndroidBuildOptions extends Omit<BuildOptions, "target" | "runtime" | "nativeLibrary"> {
  /** "android" packs every ABI with a native library; the others one each. */
  target?: AndroidTarget;
  /** Directory with <abi>/libtarve_native.so. Defaults to TARVE_ANDROID_NATIVE, then native/android. */
  nativeDirectory?: string;
  /** Signing keystore. Defaults to TARVE_ANDROID_KEYSTORE, then the debug keystore (~/.android/debug.keystore, created when missing). */
  keystore?: string;
  /** "apk" (installable, the default) or "aab" (an Android App Bundle for Google Play); an outfile ending in .aab picks "aab". */
  format?: AndroidFormat;
  /** Extra manifest permissions (`CAMERA` or `android.permission.CAMERA`), added to package.json `tarve.android.permissions`. */
  permissions?: string[];
  /**
   * The JS engine on the device: "quickjs" (default; QuickJS-ng inside the runtime, a few MB) or
   * "bun" (the app as a Bun executable started by the activity: Bun's full API, ~45 MB more per
   * ABI in the download). Go apps ignore it.
   */
  runtime?: AndroidRuntime;
  /** bundletool jar for "aab". Defaults to TARVE_BUNDLETOOL, then a pinned release downloaded once into the Tarve cache. */
  bundletool?: string;
  /** Deep-link schemes (`myapp` for `myapp://…`) the activity opens, beside package.json `tarve.protocols`. */
  protocols?: string[];
  /** `tarve dev`: the APK runs the bundle pushed to <external files>/dev/app.js when there is one (assets/tarve/dev marks it). */
  dev?: boolean;
  /** The JS bundle, already built (`tarve dev` bundles first); bundled here when absent. */
  bundled?: AndroidBundle;
}

export type AndroidFormat = "apk" | "aab";
export type AndroidRuntime = "quickjs" | "bun";

/**
 * What every Tarve APK declares: network, background playback, notifications (app.notify, the
 * media notification) and `authenticate()` (USE_BIOMETRIC: granted at install, no prompt).
 * Location is not here: an app that calls getCurrentPosition adds ACCESS_FINE_LOCATION /
 * ACCESS_COARSE_LOCATION (package.json `tarve.android.permissions`).
 */
export const DEFAULT_ANDROID_PERMISSIONS = [
  "android.permission.INTERNET",
  "android.permission.FOREGROUND_SERVICE",
  "android.permission.FOREGROUND_SERVICE_MEDIA_PLAYBACK",
  "android.permission.POST_NOTIFICATIONS",
  "android.permission.WAKE_LOCK",
  "android.permission.USE_BIOMETRIC",
] as const;

/** `CAMERA` → `android.permission.CAMERA`; a name with a dot (`com.example.READ`) is kept. */
export function androidPermissionName(name: string): string {
  const trimmed = name.trim();
  if (!/^[A-Za-z_][A-Za-z0-9_.]*$/.test(trimmed)) throw new TypeError(`Invalid Android permission: ${JSON.stringify(name)}`);
  return trimmed.includes(".") ? trimmed : `android.permission.${trimmed}`;
}

/**
 * package.json `tarve.android` (and `tarve.apps["<entry>"].android` for one entry of a
 * multi-app package): `{ "permissions": ["CAMERA", "RECORD_AUDIO"], "notificationIcon": "bell.png" }`.
 */
export function androidConfig(entrypoint: string): { permissions: string[]; notificationIcon?: string; cleartextTraffic?: boolean } {
  const entry = resolve(entrypoint);
  for (let directory = dirname(entry); ; directory = dirname(directory)) {
    const path = join(directory, "package.json");
    if (existsSync(path)) {
      const tarve = (JSON.parse(readFileSync(path, "utf8")) as { tarve?: { android?: unknown; apps?: Record<string, { android?: unknown }> } }).tarve;
      const key = relative(directory, entry).replaceAll("\\", "/");
      const permissions: string[] = [];
      let notificationIcon: string | undefined;
      let cleartextTraffic: boolean | undefined;
      for (const [where, android] of [["tarve.android", tarve?.android], [`tarve.apps["${key}"].android`, (tarve?.apps?.[key] ?? tarve?.apps?.["./" + key])?.android]] as const) {
        if (android === undefined) continue;
        const { permissions: list, notificationIcon: icon, cleartextTraffic: cleartext } = android as { permissions?: unknown; notificationIcon?: unknown; cleartextTraffic?: unknown };
        if (cleartext !== undefined) {
          if (typeof cleartext !== "boolean") throw new TypeError(`package.json ${where}.cleartextTraffic must be a boolean`);
          cleartextTraffic = cleartext;
        }
        if (list !== undefined && (!Array.isArray(list) || list.some(item => typeof item !== "string"))) throw new TypeError(`package.json ${where}.permissions must be an array of strings`);
        permissions.push(...(list as string[] | undefined) ?? []);
        if (icon !== undefined) {
          if (typeof icon !== "string" || !icon.toLowerCase().endsWith(".png")) throw new TypeError(`package.json ${where}.notificationIcon must be a .png path`);
          notificationIcon = resolve(directory, icon);
          if (!existsSync(notificationIcon)) throw new Error(`Notification icon not found: ${notificationIcon}`);
        }
      }
      return { permissions, ...notificationIcon ? { notificationIcon } : {}, ...cleartextTraffic ? { cleartextTraffic } : {} };
    }
    if (dirname(directory) === directory) return { permissions: [] };
  }
}

/** The default notification small icon: a bell (Material Icons, Apache-2.0), white on transparent. */
const NOTIFICATION_ICON = `<?xml version="1.0" encoding="utf-8"?>
<vector xmlns:android="http://schemas.android.com/apk/res/android" android:width="24dp" android:height="24dp" android:viewportWidth="24" android:viewportHeight="24">
  <path android:fillColor="#FFFFFFFF" android:pathData="M12,22c1.1,0 2,-0.9 2,-2h-4c0,1.1 0.89,2 2,2zM18,16v-5c0,-3.07 -1.64,-5.64 -4.5,-6.32L13.5,4c0,-0.83 -0.67,-1.5 -1.5,-1.5s-1.5,0.67 -1.5,1.5v0.68C7.63,5.36 6,7.92 6,11v5l-2,2v1h16v-1l-2,-2z"/>
</vector>
`;

/** 35 draws edge-to-edge: TarveActivity reports the window insets and the runtime lays out inside them. */
const TARGET_SDK = 35;

export function isAndroidTarget(value: string): value is AndroidTarget {
  return (ANDROID_TARGETS as readonly string[]).includes(value);
}

export function abisOf(target: AndroidTarget = "android"): AndroidAbi[] {
  return target === "android-arm64" ? ["arm64-v8a"] : target === "android-x64" ? ["x86_64"] : [...ANDROID_ABIS];
}

export function androidManifest(options: { packageName: string; label: string; versionCode: number; versionName: string; icon: boolean; permissions?: readonly string[]; cleartextTraffic?: boolean; bundle?: boolean; extractNativeLibs?: boolean; protocols?: readonly string[]; fileTypes?: readonly FileTypeAssociation[] }): string {
  const permissions = [...new Set([...DEFAULT_ANDROID_PERMISSIONS, ...(options.permissions ?? []).map(androidPermissionName)])];
  return `<?xml version="1.0" encoding="utf-8"?>
<manifest xmlns:android="http://schemas.android.com/apk/res/android"
    package="${options.packageName}"
    android:versionCode="${options.versionCode}"
    android:versionName="${escapeXml(options.versionName)}">
  <uses-sdk android:minSdkVersion="${MIN_SDK}" android:targetSdkVersion="${TARGET_SDK}"/>
  <queries><intent><action android:name="android.speech.RecognitionService"/></intent></queries>
${permissions.map(name => `  <uses-permission android:name="${escapeXml(name)}"/>`).join("\n")}
  <application
      android:label="${escapeXml(options.label)}"${options.icon ? `
      android:icon="@mipmap/ic_launcher"` : ""}
      android:hasCode="true"${options.cleartextTraffic ? `
      android:usesCleartextTraffic="true"` : ""}${options.bundle ? "" : `
      android:extractNativeLibs="${options.extractNativeLibs ? "true" : "false"}"`}>
    <activity
        android:name="dev.tarve.TarveActivity"
        android:exported="true"
        android:launchMode="singleTask"
        android:theme="@style/TarveTheme"
        android:windowSoftInputMode="adjustResize"
        android:configChanges="orientation|screenSize|smallestScreenSize|screenLayout|keyboard|keyboardHidden|navigation|density|fontScale|uiMode|locale|layoutDirection">
      <meta-data android:name="android.app.lib_name" android:value="tarve_native"/>
      <intent-filter>
        <action android:name="android.intent.action.MAIN"/>
        <category android:name="android.intent.category.LAUNCHER"/>
      </intent-filter>
${androidIntentFilters(options.protocols)}${androidFileIntentFilters(options.fileTypes)}    </activity>
    <activity android:name="dev.tarve.TarveWebSignIn" android:exported="false" android:theme="@android:style/Theme.Material.Light.NoActionBar"
        android:configChanges="orientation|screenSize|smallestScreenSize|screenLayout|keyboard|keyboardHidden|density|fontScale|uiMode"/>
    <activity android:name="dev.tarve.TarveFilePicker" android:exported="false" android:theme="@android:style/Theme.Translucent.NoTitleBar"
        android:configChanges="orientation|screenSize|smallestScreenSize|screenLayout|keyboard|keyboardHidden|density|fontScale|uiMode"/>
    <activity android:name="dev.tarve.TarvePermissions" android:exported="false" android:theme="@android:style/Theme.Translucent.NoTitleBar"
        android:configChanges="orientation|screenSize|smallestScreenSize|screenLayout|keyboard|keyboardHidden|density|fontScale|uiMode"/>
    <activity android:name="dev.tarve.TarveNotificationOpen" android:exported="false" android:excludeFromRecents="true"
        android:theme="@android:style/Theme.Translucent.NoTitleBar"/>
    <receiver android:name="dev.tarve.TarveScheduledNotifications" android:exported="false">
      <intent-filter>
        <action android:name="android.intent.action.BOOT_COMPLETED"/>
        <action android:name="android.intent.action.MY_PACKAGE_REPLACED"/>
      </intent-filter>
    </receiver>
    <service android:name="dev.tarve.TarveMediaService" android:exported="false" android:foregroundServiceType="mediaPlayback"/>
    <provider android:name="dev.tarve.TarveFileProvider" android:authorities="${options.packageName}.tarve.files" android:exported="false" android:grantUriPermissions="true"/>
  </application>
</manifest>
`;
}

/**
 * The activity's theme: no action bar, and opaque black system bars with light icons. The
 * runtime lays the UI out between the bars, and their icons cannot follow the app's own
 * colors (that needs the UI thread, which a code-free NativeActivity APK has no hook on),
 * so they stay readable over any app.
 */
export function androidTheme(): string {
  return `<?xml version="1.0" encoding="utf-8"?>
<resources>
  <style name="TarveTheme" parent="@android:style/Theme.Material.NoActionBar">
    <item name="android:windowBackground">@android:color/black</item>
    <item name="android:statusBarColor">@android:color/black</item>
    <item name="android:navigationBarColor">@android:color/black</item>
    <item name="android:windowLightStatusBar">false</item>
    <item name="android:windowLightNavigationBar">false</item>
  </style>
</resources>
`;
}

function isGoApp(entrypoint: string): boolean {
  const path = resolve(entrypoint);
  if (path.endsWith(".go")) return true;
  return existsSync(path) && statSync(path).isDirectory() && readdirSync(path).some(name => name.endsWith(".go"));
}

/** The Go app as libtarveapp.so: its main package plus an exported TarveAndroidMain that runs main(). */
function buildGo(entrypoint: string, abi: AndroidAbi, output: string, temporary: string): void {
  const directory = resolve(entrypoint).endsWith(".go") ? dirname(resolve(entrypoint)) : resolve(entrypoint);
  const ndk = androidNdk();
  const host = windows ? "windows-x86_64" : process.platform === "darwin" ? "darwin-x86_64" : "linux-x86_64";
  const clang = join(ndk, "toolchains", "llvm", "prebuilt", host, "bin", exe("clang"));
  if (!existsSync(clang)) throw new Error(`NDK clang not found: ${clang}`);
  const triple = abi === "arm64-v8a" ? "aarch64-linux-android" : "x86_64-linux-android";
  const entry = join(temporary, `tarve_android_main_${abi}.go`);
  writeFileSync(entry, [
    "//go:build android",
    "",
    "package main",
    "",
    "import \"C\"",
    "",
    "// TarveAndroidMain is what the Tarve runtime's android_main calls (native/src/android.rs).",
    "//",
    "//export TarveAndroidMain",
    "func TarveAndroidMain() { main() }",
    "",
  ].join("\n"));
  const overlay = join(temporary, `overlay-${abi}.json`);
  writeFileSync(overlay, JSON.stringify({ Replace: { [join(directory, "zz_tarve_android_main.go")]: entry } }));
  execFileSync("go", ["build", "-buildmode=c-shared", "-trimpath", "-ldflags=-s -w", `-overlay=${overlay}`, "-o", output, "."], {
    cwd: directory,
    stdio: ["ignore", "inherit", "inherit"],
    env: {
      ...process.env,
      GOOS: "android",
      GOARCH: abi === "arm64-v8a" ? "arm64" : "amd64",
      CGO_ENABLED: "1",
      CC: `"${clang}" --target=${triple}${MIN_SDK}`,
      CGO_LDFLAGS: "-Wl,-soname,libtarveapp.so",
    },
  });
}

function nativeLibrary(options: AndroidBuildOptions, abi: AndroidAbi): string {
  const directory = resolve(options.nativeDirectory ?? process.env.TARVE_ANDROID_NATIVE ?? join(import.meta.dirname, "../../native/android"));
  const library = join(directory, abi, "libtarve_native.so");
  if (!existsSync(library)) {
    throw new Error(`Tarve native library missing for ${abi}: ${library}. Build it with \`bun run build:native:android\` (cargo-ndk and the Android NDK).`);
  }
  return library;
}

/**
 * classes.dex with the runtime's Java side (packages/core/android/java): the background
 * playback service. javac against the platform's android.jar, then d8 from the build-tools.
 */
function compileJava(options: { javac: string; java: string; tools: string; androidJar: string; temporary: string }): Uint8Array {
  const sources = join(import.meta.dirname, "android/java");
  const files: string[] = [];
  const walk = (directory: string) => {
    for (const name of readdirSync(directory)) {
      const path = join(directory, name);
      if (statSync(path).isDirectory()) walk(path);
      else if (name.endsWith(".java")) files.push(path);
    }
  };
  walk(sources);
  const classes = join(options.temporary, "classes");
  const dex = join(options.temporary, "dex");
  mkdirSync(classes, { recursive: true });
  mkdirSync(dex, { recursive: true });
  const run = (command: string, args: string[], what: string) => {
    try {
      execFileSync(command, args, { stdio: "pipe" });
    } catch (error) {
      throw new Error(`${what} failed: ${String((error as { stderr?: Uint8Array }).stderr ?? error)}`);
    }
  };
  run(options.javac, ["-source", "8", "-target", "8", "-Xlint:-options", "-encoding", "UTF-8", "-bootclasspath", options.androidJar, "-d", classes, ...files], "javac");
  const compiled: string[] = [];
  const collect = (directory: string) => {
    for (const name of readdirSync(directory)) {
      const path = join(directory, name);
      if (statSync(path).isDirectory()) collect(path);
      else if (name.endsWith(".class")) compiled.push(path);
    }
  };
  collect(classes);
  run(options.java, ["-cp", join(options.tools, "lib", "d8.jar"), "com.android.tools.r8.D8", "--release", "--min-api", String(MIN_SDK), "--lib", options.androidJar, "--output", dex, ...compiled], "d8");
  return readFileSync(join(dex, "classes.dex"));
}
const BUNDLETOOL_VERSION = "1.18.1";

/** bundletool-all.jar: `explicit`, TARVE_BUNDLETOOL, else the pinned release from GitHub, downloaded once into the Tarve cache. */
export async function bundletoolJar(explicit?: string): Promise<string> {
  const configured = explicit ?? process.env.TARVE_BUNDLETOOL;
  if (configured) {
    if (!existsSync(configured)) throw new Error(`bundletool not found: ${configured}`);
    return resolve(configured);
  }
  const name = `bundletool-all-${BUNDLETOOL_VERSION}.jar`;
  const cached = join(cacheRoot(), "bundletool", name);
  if (existsSync(cached)) return cached;
  const url = `https://github.com/google/bundletool/releases/download/${BUNDLETOOL_VERSION}/${name}`;
  const response = await fetch(url);
  if (!response.ok) throw new Error(`Could not download bundletool from ${url}: HTTP ${response.status}. Set TARVE_BUNDLETOOL to a bundletool-all jar.`);
  mkdirSync(dirname(cached), { recursive: true });
  const partial = `${cached}.${process.pid}.partial`;
  writeFileSync(partial, new Uint8Array(await response.arrayBuffer()));
  renameSync(partial, cached);
  return cached;
}

/**
 * The bundletool module layout from the proto-format link and the APK entries: the manifest
 * under manifest/, classes.dex under dex/, resources.pb, res/, assets/ and lib/ as they are.
 */
export function appBundleModule(base: readonly ZipEntry[], entries: readonly ZipEntry[]): ZipEntry[] {
  const rename = (entry: ZipEntry): ZipEntry => entry.name === "AndroidManifest.xml" ? { ...entry, name: "manifest/AndroidManifest.xml" }
    : /^classes\d*\.dex$/.test(entry.name) ? { ...entry, name: `dex/${entry.name}` }
    : entry;
  return [...base, ...entries].map(rename);
}

/** `bundletool build-bundle`, then jarsigner with the same key an APK would get. */
async function packAppBundle(options: {
  base: ZipEntry[]; entries: ZipEntry[]; temporary: string; outfile: string; java: string; jarsigner: string; bundletool: string; extractNativeLibs: boolean;
  key: { keystore: string; password: string; alias: string; keyPassword: string };
}): Promise<void> {
  const module = join(options.temporary, "base.zip");
  writeFileSync(module, writeZip(appBundleModule(options.base, options.entries), () => 4));
  // Native libraries stay uncompressed and 16 KB aligned in the APKs Play generates (Android 15 devices),
  // except with a Bun app, whose executable must be extracted to run.
  const config = join(options.temporary, "BundleConfig.json");
  writeFileSync(config, JSON.stringify({
    optimizations: { uncompressNativeLibraries: options.extractNativeLibs ? { enabled: false } : { enabled: true, alignment: "PAGE_ALIGNMENT_16K" } },
    compression: { uncompressedGlob: ["assets/tarve/files/**.png", "assets/tarve/files/**.jpg", "assets/tarve/files/**.jpeg", "assets/tarve/files/**.webp", "assets/tarve/files/**.gif", "assets/tarve/files/**.woff", "assets/tarve/files/**.woff2"] },
  }));
  const unsigned = join(options.temporary, "unsigned.aab");
  try {
    execFileSync(options.java, ["-jar", options.bundletool, "build-bundle", `--modules=${module}`, `--config=${config}`, `--output=${unsigned}`], { stdio: "pipe" });
  } catch (error) {
    throw new Error(`bundletool build-bundle failed: ${String((error as { stderr?: Uint8Array }).stderr ?? error)}`);
  }
  mkdirSync(dirname(options.outfile), { recursive: true });
  rmSync(options.outfile, { force: true });
  try {
    execFileSync(options.jarsigner, [
      "-keystore", options.key.keystore, "-storepass:env", "TARVE_AAB_KS_PASS", "-keypass:env", "TARVE_AAB_KEY_PASS",
      "-signedjar", options.outfile, unsigned, options.key.alias,
    ], { stdio: "pipe", env: { ...process.env, TARVE_AAB_KS_PASS: options.key.password, TARVE_AAB_KEY_PASS: options.key.keyPassword } });
  } catch (error) {
    const failure = error as { stdout?: Uint8Array; stderr?: Uint8Array };
    throw new Error(`jarsigner failed: ${String(failure.stderr?.length ? failure.stderr : failure.stdout ?? error)}`);
  }
}
/** Bun's `--compile` target for an ABI: Bun runs on Android (Bionic) since 1.4. */
const BUN_ANDROID_TARGETS: Record<AndroidAbi, string> = { "arm64-v8a": "bun-linux-arm64-android", x86_64: "bun-linux-x64-android" };

/**
 * `--runtime bun`: the app compiled into a Bun executable for Android, packed as
 * lib/<abi>/libtarvebun.so. The activity starts it and serves the C ABI over a socket
 * (native/src/android/bun_host.rs, src/bridge/remote.ts). Needs Bun to build.
 */
async function compileBunApp(options: AndroidBuildOptions, abi: AndroidAbi, outfile: string, define: Record<string, string>): Promise<void> {
  if (!process.versions.bun) throw new Error("Android builds with --runtime bun need Bun: run them with bunx tarve (or bun run).");
  const { frameworkPlugins } = await import("./framework-plugins");
  const sourceDirectory = join(import.meta.dirname, "src");
  const repositorySource = existsSync(join(sourceDirectory, "index.ts"));
  const runtime: import("bun").BunPlugin = {
    name: "tarve-android-bun-runtime",
    setup(builder) {
      if (repositorySource) {
        builder.onResolve({ filter: /^tarve$/ }, () => ({ path: join(sourceDirectory, "index.ts") }));
        builder.onResolve({ filter: /^tarve\/jsx-runtime$/ }, () => ({ path: join(sourceDirectory, "jsx-runtime.ts") }));
        builder.onResolve({ filter: /^tarve\/jsx-dev-runtime$/ }, () => ({ path: join(sourceDirectory, "jsx-dev-runtime.ts") }));
      }
      if (options.compileJsx) {
        builder.onLoad({ filter: /\.[jt]sx$/ }, async args => {
          if (/[\\/]node_modules[\\/]/.test(args.path) || args.path.startsWith(sourceDirectory)) return undefined;
          const { compileJsx } = await import("./jsx-compile");
          return { contents: (await compileJsx(readFileSync(args.path, "utf8"))).code, loader: args.path.endsWith(".jsx") ? "jsx" : "tsx" };
        });
      }
      // The library lives in the activity's process, reached through TARVE_ANDROID_BRIDGE_FD.
      builder.onResolve({ filter: /^#tarve\/runtime$/ }, () => ({ path: "runtime", namespace: "tarve-android" }));
      builder.onLoad({ filter: /^runtime$/, namespace: "tarve-android" }, () => ({
        loader: "ts",
        contents: `export function nativePath() { return process.env.TARVE_NATIVE ?? "libtarve_native.so"; }`,
      }));
    },
  };
  const result = await Bun.build({
    entrypoints: [resolve(options.entrypoint)],
    target: "bun",
    plugins: [runtime, ...await frameworkPlugins<import("bun").BunPlugin>(resolve(options.entrypoint))],
    define: { "process.env.NODE_ENV": JSON.stringify("production"), ...define },
    minify: true,
    compile: { target: BUN_ANDROID_TARGETS[abi] as "bun-linux-x64", outfile, autoloadDotenv: false, autoloadBunfig: false },
  });
  if (!result.success) throw new AggregateError(result.logs, "Could not compile the Tarve application for Android");
}



function signingKey(keytool: string, explicit?: string): { keystore: string; password: string; alias: string; keyPassword: string } {
  const keystore = explicit ?? process.env.TARVE_ANDROID_KEYSTORE;
  if (keystore) {
    const password = process.env.TARVE_ANDROID_KEYSTORE_PASSWORD;
    if (!password) throw new Error("TARVE_ANDROID_KEYSTORE_PASSWORD is required with a release keystore.");
    return { keystore: resolve(keystore), password, alias: process.env.TARVE_ANDROID_KEY_ALIAS ?? "release", keyPassword: process.env.TARVE_ANDROID_KEY_PASSWORD ?? password };
  }
  const debug = join(homedir(), ".android", "debug.keystore");
  if (!existsSync(debug)) {
    mkdirSync(dirname(debug), { recursive: true });
    execFileSync(keytool, [
      "-genkeypair", "-keystore", debug, "-storepass", "android", "-alias", "androiddebugkey", "-keypass", "android",
      "-keyalg", "RSA", "-keysize", "2048", "-validity", "10000", "-dname", "CN=Android Debug,O=Android,C=US",
    ], { stdio: "pipe" });
  }
  return { keystore: debug, password: "android", alias: "androiddebugkey", keyPassword: "android" };
}

export async function buildAndroid(options: AndroidBuildOptions): Promise<string> {
  const abis = abisOf(options.target);
  const go = isGoApp(options.entrypoint);
  const sdk = androidSdk();
  const tools = buildTools(sdk);
  const androidJar = platformJar(sdk);
  const { java, keytool, javac, jarsigner } = jdk();
  const format: AndroidFormat = options.format ?? (options.outfile?.toLowerCase().endsWith(".aab") ? "aab" : "apk");
  if (format !== "apk" && format !== "aab") throw new TypeError(`Unknown Android format: ${String(format)}. Expected apk or aab.`);
  const bundle = format === "aab";
  const runtime: AndroidRuntime = options.runtime ?? "quickjs";
  if (runtime !== "quickjs" && runtime !== "bun") throw new TypeError(`Unknown Android runtime: ${String(runtime)}. Expected quickjs or bun.`);
  const bun = runtime === "bun" && !go;
  const config = androidConfig(options.entrypoint);
  const permissions = [...config.permissions, ...options.permissions ?? []];
  const bundletool = bundle ? await bundletoolJar(options.bundletool) : undefined;
  const libraries = abis.map(abi => [abi, nativeLibrary(options, abi)] as const);
  const { metadata, images, define } = buildMetadata(options.entrypoint, metadataOverrides(options as BuildOptions));
  const outfile = resolve(options.outfile ?? `dist/${metadata.name}.${format}`);
  const packageName = androidPackageName(metadata.appId, metadata.name);

  const temporary = mkdtempSync(join(tmpdir(), "tarve-android-build-"));
  try {
    const entries: ZipEntry[] = [];
    if (go) {
      for (const abi of abis) {
        const library = join(temporary, abi, "libtarveapp.so");
        mkdirSync(dirname(library), { recursive: true });
        buildGo(options.entrypoint, abi, library, temporary);
        entries.push(zipEntry(`lib/${abi}/libtarveapp.so`, readFileSync(library), false));
      }
    } else if (bun) {
      for (const abi of abis) {
        const executable = join(temporary, abi, "libtarvebun.so");
        mkdirSync(dirname(executable), { recursive: true });
        await compileBunApp(options, abi, executable, define);
        // Compressed: the package manager extracts it (extractNativeLibs) so it can run.
        entries.push(zipEntry(`lib/${abi}/libtarvebun.so`, readFileSync(executable), true));
      }
    } else {
      const { bundle, assets } = options.bundled ?? await bundleAndroidJs(options as BuildOptions, define, temporary);
      if (options.dev) entries.push(zipEntry("assets/tarve/dev", new Uint8Array(), false));
      if (process.env.TARVE_ANDROID_DEBUG) writeFileSync(process.env.TARVE_ANDROID_DEBUG, readFileSync(bundle));
      entries.push(zipEntry("assets/tarve/app.js", readFileSync(bundle), true));
      entries.push(zipEntry("assets/tarve/files.json", new TextEncoder().encode(JSON.stringify(assets.map(asset => ({ name: asset.name, size: asset.data.length })))), true));
      for (const asset of assets) entries.push(zipEntry(`assets/tarve/files/${asset.name}`, asset.data, !/\.(?:png|jpe?g|webp|gif|woff2?)$/i.test(asset.name)));
    }
    for (const [abi, library] of libraries) entries.push(zipEntry(`lib/${abi}/libtarve_native.so`, readFileSync(library), false));
    entries.push(zipEntry("classes.dex", compileJava({ javac, java, tools, androidJar, temporary }), true));

    // Manifest and the launcher icon through aapt2.
    const manifest = join(temporary, "AndroidManifest.xml");
    writeFileSync(manifest, androidManifest({
      packageName,
      label: metadata.name,
      versionCode: androidVersionCode(metadata.version),
      versionName: metadata.version ?? "1.0",
      icon: !!images?.png,
      permissions,
      cleartextTraffic: config.cleartextTraffic,
      bundle,
      extractNativeLibs: bun,
      ...(({ protocols, fileTypes }) => ({ protocols, fileTypes }))(resolveAppAssociations(options.entrypoint, { protocols: options.protocols })),
    }));
    const aapt2 = join(tools, exe("aapt2"));
    const resources = join(temporary, "res");
    mkdirSync(join(resources, "values"), { recursive: true });
    writeFileSync(join(resources, "values", "styles.xml"), androidTheme());
    if (images?.png) {
      mkdirSync(join(resources, "mipmap"), { recursive: true });
      writeFileSync(join(resources, "mipmap", "ic_launcher.png"), images.png);
    }
    // The status bar draws a notification's small icon from its alpha only: a colored launcher
    // icon would be a white square, so notifications get a white-on-transparent one.
    mkdirSync(join(resources, "drawable"), { recursive: true });
    if (config.notificationIcon) writeFileSync(join(resources, "drawable", "tarve_notification.png"), readFileSync(config.notificationIcon));
    else writeFileSync(join(resources, "drawable", "tarve_notification.xml"), NOTIFICATION_ICON);
    const compiled = join(temporary, "res.zip");
    execFileSync(aapt2, ["compile", "--dir", resources, "-o", compiled], { stdio: "pipe" });
    // An App Bundle takes the manifest and resources in protobuf form.
    const link = ["link", "-o", join(temporary, "base.apk"), "-I", androidJar, "--manifest", manifest, ...bundle ? ["--proto-format"] : [], compiled];
    try {
      execFileSync(aapt2, link, { stdio: "pipe" });
    } catch (error) {
      throw new Error(`aapt2 link failed: ${String((error as { stderr?: Uint8Array }).stderr ?? error)}`);
    }
    const base = readZip(readFileSync(join(temporary, "base.apk")));
    if (bundle) {
      const key = signingKey(keytool, options.keystore);
      await packAppBundle({ base, entries, temporary, outfile, java, jarsigner, bundletool: bundletool!, key, extractNativeLibs: bun });
      return outfile;
    }
    const unsigned = join(temporary, "unsigned.apk");
    // Shared libraries at 16 KB pages (Android 15 devices), everything else stored at 4 bytes.
    writeFileSync(unsigned, writeZip([...base, ...entries], name => name.endsWith(".so") ? 16384 : 4));

    const key = signingKey(keytool, options.keystore);
    mkdirSync(dirname(outfile), { recursive: true });
    rmSync(outfile, { force: true });
    try {
      execFileSync(java, [
        "-jar", join(tools, "lib", "apksigner.jar"), "sign",
        "--ks", key.keystore, "--ks-pass", "env:TARVE_APK_KS_PASS", "--ks-key-alias", key.alias, "--key-pass", "env:TARVE_APK_KEY_PASS",
        "--min-sdk-version", String(MIN_SDK), "--out", outfile, unsigned,
      ], { stdio: "pipe", env: { ...process.env, TARVE_APK_KS_PASS: key.password, TARVE_APK_KEY_PASS: key.keyPassword } });
    } catch (error) {
      throw new Error(`apksigner failed: ${String((error as { stderr?: Uint8Array }).stderr ?? error)}`);
    }
    rmSync(`${outfile}.idsig`, { force: true });
    return outfile;
  } finally {
    if (options.compileJsx) await (await import("./jsx-compile")).closeJsxCompiler();
    rmSync(temporary, { recursive: true, force: true });
  }
}
