#!/usr/bin/env node
import { spawn } from "node:child_process";
import { resolve } from "node:path";
import { parseArgs } from "node:util";
import { resolveAppMetadata, runtimeMetadata } from "./package-metadata";
import { build, smolExecArgv } from "./build";
import { devNode, runNode } from "./node-dev";
import { selectRuntime } from "./runtime-select";
import { frameworkPreloads } from "./framework-plugins";
import { generateUpdateKeys, release } from "./updates-build";
import { BUILD_TARGETS, hostBuildTarget, isBuildTarget, isMacTarget, targetConfig, type BuildTarget } from "./targets";
import { ANDROID_TARGETS, isAndroidTarget } from "./android-build";
import { existsSync, writeFileSync } from "node:fs";

const COMMANDS = ["run", "dev", "build"] as const;
const KEY_FILE = "tarve-update.key";

function usage(target?: BuildTarget): string {
  const output = `dist/App${target ? targetConfig(target).executableSuffix : ""}`;
  return [
    "Usage: tarve <run|dev|build> <app.tsx> [options]",
    "       tarve keygen",
    "       tarve pack <app.tsx> --version 1.2.1 [--runtime bun|node|txiki] [--target ...]",
    "       tarve release --version 1.2.0 --artifact win32-x64=dist/App.exe [--pack dist/App.tarve] [...]",
    "       tarve package <dist/App | dist/App.app | app.tsx> --format deb|tar|zip|msix|app-zip [options]",
    "",
    "  run      run the app",
    "  dev      run with hot reload into the same window (--inspect: open the visual inspector window)",
    "  build    compile a standalone executable (a .app bundle for darwin-* targets)",
    `  keygen   create an update signing key pair (writes ${KEY_FILE}, prints the public key)`,
    "  pack     build a signed, encrypted app pack (.tarve): the app's code and files, without the runtime",
    "  release  copy built executables and packs to --out and write the signed latest.json",
    "  package  wrap a built executable (or build app.tsx first) into a .deb, .tar.gz, portable .zip, MSIX or zipped .app",
    "",
    "Options:",
    "  --runtime bun|node|txiki        defaults to the runtime that launched tarve; txiki: build only",
    "                                  android: quickjs (default, = txiki) or bun (the app as a Bun executable; build with Bun)",
    `  --target ${BUILD_TARGETS.join("|")}  build: target OS (cross-compiles)`,
    `  --target ${ANDROID_TARGETS.join("|")}  build: an APK or AAB (app.tsx on QuickJS-ng, or a Go main package directory)`,
    "  --format apk|aab                build (android): installable APK (default) or App Bundle for Google Play (.aab outfile picks aab)",
    "  --permission CAMERA             build (android): repeatable manifest permission, beside package.json tarve.android.permissions",
    "  --keystore release.jks          build (android): signing keystore (default: the debug keystore)",
    "  --bundletool path.jar           build (android aab): bundletool jar (default: TARVE_BUNDLETOOL, then downloaded once)",
    `  --outfile ${output}              build, pack: output path`,
    "  --compile-jsx                   build: compile JSX into reusable templates (needs typescript 7)",
    "  --smol                          smaller JS heap, collected more often (bun, node)",
    "  --native-features auto|all|<list> build: native subsystems (vello-gpu, syntax, markdown, net, media); auto = what the app uses",
    "  --name App, --version 1.0.0     app metadata (executable, window, app identity)",
    "  --icon icon.png                 app icon: .png (square, 256 px+) or .ico",
    "  --app-id Acme.App               Windows AppUserModelID / Linux app id",
    "  --description, --publisher, --copyright  build: executable details",
    "                                  each defaults to the \"tarve\" field of package.json",
    "  --target-executable path        build (node): target OS Node binary for offline cross-builds",
    "  --packs                         build: the executable also runs app packs (tarve pack) newer than the app it embeds",
    "  --artifact platform=path        release: repeatable, platform is <os>-<arch> (win32-x64, linux-x64, darwin-arm64=dist/App.app)",
    "  --pack dist/App.tarve           release: repeatable app pack; executables built with --packs download it instead",
    `  --key ${KEY_FILE}          release, pack, build --packs: private key file or base64 (default: TARVE_UPDATE_PRIVATE_KEY, then ./${KEY_FILE})`,
    "  --public-key base64             release: verify the signed manifest before writing it",
    "  --out dist/updates              release: output directory; keygen: where the key goes",
    "  --base-url https://host/path/   release: artifact URL prefix (default: relative to latest.json)",
    "  --notes text                    release: release notes",
    "  --format deb,tar,zip,msix,app-zip package: comma separated (default: deb,tar for Linux, zip for Windows, app-zip for macOS); --out: output directory",
    "  --categories Utility;Office     package: freedesktop menu categories (deb, tar)",
    "  --protocol myapp                package, build (android): repeatable deep-link scheme (myapp://…), beside package.json tarve.protocols",
    "  --file-type ext=Name            package: repeatable file association, beside package.json tarve.fileTypes",
    "  --sign \"signtool sign … {file}\"  release: Authenticode command per Windows artifact, before hashing",
    "                                  (default: TARVE_SIGN_COMMAND)",
    "  --sign \"Developer ID Application: …\"  release (darwin-* .app artifacts only, on macOS): codesign identity",
    "                                  (default: TARVE_MACOS_SIGN_IDENTITY; --entitlements file.plist or TARVE_MACOS_ENTITLEMENTS)",
    "  --notarize                      release (macOS): notarytool submit --wait + stapler; --notary-profile name or TARVE_NOTARY_PROFILE,",
    "                                  else APPLE_ID, APPLE_TEAM_ID, APPLE_APP_PASSWORD",
  ].join("\n");
}

/** Run a child process with inherited stdio and resolve with its exit code. */
function forward(command: string, args: string[], env: NodeJS.ProcessEnv = process.env): Promise<number> {
  return new Promise((resolveCode, reject) => {
    const child = spawn(command, args, { stdio: "inherit", env });
    const stop = () => child.kill();
    process.on("SIGINT", stop);
    process.on("SIGTERM", stop);
    child.once("error", error => {
      reject((error as NodeJS.ErrnoException).code === "ENOENT"
        ? new Error(command === "bun"
          ? "Bun was not found. Install Bun, or run with Node.js 26.10+ and --runtime node."
          : `${command} was not found. Install it or choose the other runtime with --runtime.`)
        : error);
    });
    child.once("exit", (code, signal) => {
      process.off("SIGINT", stop);
      process.off("SIGTERM", stop);
      resolveCode(code ?? (signal ? 1 : 0));
    });
  });
}

/** `--runtime` for Android: QuickJS-ng (default; also `txiki`, the same engine) or Bun. Node.js has no Android build. */
function androidRuntime(runtime: string | undefined): "quickjs" | "bun" {
  if (runtime === undefined || runtime === "txiki" || runtime === "quickjs") return "quickjs";
  if (runtime === "bun") return "bun";
  throw new Error(`--runtime ${runtime} cannot run on Android: use bun, or txiki/quickjs (the default). Node.js publishes no Android build.`);
}

async function main(): Promise<number> {
  const { values, positionals } = parseArgs({
    args: process.argv.slice(2),
    allowPositionals: true,
    options: {
      outfile: { type: "string" }, name: { type: "string" }, version: { type: "string" },
      icon: { type: "string" }, "app-id": { type: "string" }, description: { type: "string" },
      publisher: { type: "string" }, copyright: { type: "string" },
      target: { type: "string" }, runtime: { type: "string" }, "compile-jsx": { type: "boolean" }, smol: { type: "boolean" },
      "native-features": { type: "string" },
      "target-executable": { type: "string" }, keystore: { type: "string" },
      permission: { type: "string", multiple: true }, format: { type: "string" }, bundletool: { type: "string" },
      artifact: { type: "string", multiple: true }, key: { type: "string" }, "public-key": { type: "string" },
      out: { type: "string" }, "base-url": { type: "string" }, notes: { type: "string" }, sign: { type: "string" },
      notarize: { type: "boolean" }, "notary-profile": { type: "string" }, entitlements: { type: "string" },
      categories: { type: "string" }, protocol: { type: "string", multiple: true }, "file-type": { type: "string", multiple: true },
      inspect: { type: "boolean" }, packs: { type: "boolean" }, pack: { type: "string", multiple: true },
      help: { type: "boolean", short: "h" },
    },
  });
  const [command, entrypoint] = positionals;
  if (values.help || positionals.length === 0) {
    console.log(usage(values.target && isBuildTarget(values.target) ? values.target : hostBuildTarget()));
    return 0;
  }
  if (command === "keygen") return keygen(values.out);
  if (command === "release") {
    if (!values.version) throw new Error("tarve release needs --version.");
    const privateKey = updateKey(values.key, "tarve release");
    const artifacts = values.artifact ?? [];
      // --sign is the Authenticode command for Windows artifacts; with only macOS artifacts it is the codesign identity.
      const macOnly = artifacts.some(pair => pair.startsWith("darwin-")) && !artifacts.some(pair => pair.startsWith("win32-"));
      const { macSignOptions } = await import("./macos-sign");
    const macSign = artifacts.some(pair => pair.startsWith("darwin-"))
      ? macSignOptions({ identity: macOnly ? values.sign : undefined, entitlements: values.entitlements, notarize: values.notarize, notaryProfile: values["notary-profile"] })
      : undefined;
    console.log(release({
      version: values.version, artifacts, packs: values.pack, privateKey, publicKey: values["public-key"],
      outDir: values.out, baseUrl: values["base-url"], name: values.name, notes: values.notes,
      sign: values.sign ?? process.env.TARVE_SIGN_COMMAND, macSign,
    }));
    return 0;
  }
  if (command === "package") return packageCommand(entrypoint, positionals.length, values);
  if (command === "pack") {
    if (!entrypoint || positionals.length !== 2) throw new Error("Expected: tarve pack <app.tsx> --version 1.2.1. Use --help for options.");
    if (values.target !== undefined && !isBuildTarget(values.target)) throw new Error(`Unsupported pack target: ${values.target}. Expected ${BUILD_TARGETS.join(", ")}.`);
    const { buildPack } = await import("./pack-build");
    console.log(await buildPack({
      entrypoint, outfile: values.outfile, name: values.name, version: values.version, appId: values["app-id"],
      description: values.description, publisher: values.publisher, copyright: values.copyright, icon: values.icon,
      target: values.target as BuildTarget | undefined,
      runtime: values.runtime === "txiki" ? "txiki" : selectRuntime(values.runtime),
      compileJsx: values["compile-jsx"], nativeFeatures: values["native-features"],
      updateKey: updateKey(values.key, "tarve pack"),
    }));
    return 0;
  }
  if (!COMMANDS.includes(command as typeof COMMANDS[number]) || !entrypoint || positionals.length !== 2) {
    throw new Error("Expected: tarve <run|dev|build> <app.tsx>. Use --help for options.");
  }
  if (values.target !== undefined && isAndroidTarget(values.target)) {
    if (command !== "build") throw new Error("Android targets are only supported by tarve build.");
    // Bun or Node.js only bundles: on the device the app runs on the runtime's QuickJS-ng (or as Go).
    const { buildAndroid } = await import("./android-build");
    console.log(await buildAndroid({
      entrypoint, outfile: values.outfile, name: values.name, version: values.version,
      icon: values.icon, appId: values["app-id"], description: values.description,
      publisher: values.publisher, copyright: values.copyright,
      target: values.target, compileJsx: values["compile-jsx"], keystore: values.keystore,
      format: values.format as "apk" | "aab" | undefined, permissions: values.permission, bundletool: values.bundletool,
      runtime: androidRuntime(values.runtime), protocols: values.protocol,
    }));
    return 0;
  }
  if (values.target !== undefined && !isBuildTarget(values.target)) {
    throw new Error(`Unsupported target: ${values.target}. Expected ${[...BUILD_TARGETS, ...ANDROID_TARGETS].join(", ")}.`);
  }
  // txiki.js only runs compiled executables: there is no `tarve run|dev` on it.
  const txiki = values.runtime === "txiki";
  if (txiki && command !== "build") throw new Error("--runtime txiki is only supported by tarve build.");
  const runtime = txiki ? "txiki" : selectRuntime(values.runtime);
  // Bun apps need Bun: when bunx or `bun run` started this CLI under Node, hand over to Bun.
  if (runtime === "bun" && !process.versions.bun) {
    return forward("bun", [process.argv[1]!, ...process.argv.slice(2), "--runtime", "bun"]);
  }
  if (command === "build") {
    console.log(await build({
      entrypoint, outfile: values.outfile, name: values.name, version: values.version,
      icon: values.icon, appId: values["app-id"], description: values.description,
      publisher: values.publisher, copyright: values.copyright,
      target: values.target as BuildTarget | undefined,
      runtime,
      compileJsx: values["compile-jsx"],
      smol: values.smol,
      targetExecutable: values["target-executable"],
      nativeFeatures: values["native-features"],
      updateKey: values.packs ? updateKey(values.key, "tarve build --packs") : undefined,
    }));
    return 0;
  }
  // The app reads its name, id and icon from here (a built executable has them baked in).
  const metadata = resolveAppMetadata(entrypoint, { name: values.name, icon: values.icon, appId: values["app-id"] });
  process.env.TARVE_APP_METADATA = runtimeMetadata(metadata, metadata.icon);
  // The app opens its inspector window (component tree, picker, render counts, events) from this.
  // Not TARVE_INSPECT: that one is the automation's path for the node tree (app/automation.ts).
  if (values.inspect) process.env.TARVE_INSPECTOR = "1";
  if (runtime === "node") {
    if (command === "dev") {
      await devNode(entrypoint, values.smol ? smolExecArgv("node") : []);
      return 0;
    }
    return runNode(entrypoint, values.smol ? smolExecArgv("node") : []);
  }
  const app = resolve(entrypoint);
  const smol = values.smol ? smolExecArgv("bun") : [];
  return command === "dev"
    ? forward(process.execPath, [...smol, ...frameworkPreloads(app), "--hot", app], { ...process.env, TARVE_DEV: process.env.TARVE_DEV ?? "1" })
    : forward(process.execPath, [...smol, ...frameworkPreloads(app), app]);
}

try {
  process.exitCode = await main();
} catch (error) {
  console.error(`error: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
}
type CliValues = Readonly<Record<string, string | boolean | string[] | undefined>>;

/** `tarve package <executable | app.tsx>`: builds first when given source (one build per target OS), then packages. */
async function packageCommand(input: string | undefined, count: number, values: CliValues): Promise<number> {
  if (!input || count !== 2) throw new Error("Expected: tarve package <dist/App | dist/App.app | app.tsx> --format deb|tar|zip|msix|app-zip. Use --help for options.");
  const { packageApp, packageFormatPlatform, parsePackageFormats } = await import("./package-installer");
  const { parseFileTypeFlag } = await import("./associations-config");
  const list = (key: string) => Array.isArray(values[key]) ? values[key] as string[] : [];
  const string = (key: string) => typeof values[key] === "string" ? values[key] as string : undefined;
  const formats = parsePackageFormats(string("format"));
  const metadata = {
    name: string("name"), version: string("version"), description: string("description"), publisher: string("publisher"),
    copyright: string("copyright"), icon: string("icon"), appId: string("app-id"),
  };
  const source = /\.[cm]?[jt]sx?$/i.test(input);
  const emit = (executable: string, targetFormats: typeof formats) => {
    for (const artifact of packageApp({
      executable, format: targetFormats, outDir: string("out"), ...metadata,
      entrypoint: source ? input : undefined, categories: string("categories"),
        protocols: list("protocol"), fileTypes: list("file-type").map(parseFileTypeFlag),
    })) {
      console.log(`${artifact.format}: ${artifact.path}`);
      if (artifact.note) console.log(`  ${artifact.note}`);
    }
  };
  if (source) {
    const runtime = string("runtime") === "txiki" ? "txiki" : selectRuntime(string("runtime"));
    if (runtime === "bun" && !process.versions.bun) return forward("bun", [process.argv[1]!, ...process.argv.slice(2), "--runtime", "bun"]);
    const explicit = string("target");
    if (explicit !== undefined && !isBuildTarget(explicit)) throw new Error(`Unsupported target: ${explicit}. Expected ${BUILD_TARGETS.join(", ")}.`);
    const host = hostBuildTarget();
    const wanted = formats ?? (host === "windows-x64" ? ["zip" as const] : host && isMacTarget(host) ? ["app-zip" as const] : ["deb" as const, "tar" as const]);
    const byTarget = new Map<BuildTarget, typeof wanted>();
      const macTarget: BuildTarget = host && isMacTarget(host) ? host : "darwin-arm64";
      for (const format of wanted) {
      const platform = packageFormatPlatform(format);
      const target: BuildTarget = explicit ?? (platform === "linux" ? "linux-x64" : platform === "darwin" ? macTarget : "windows-x64");
      byTarget.set(target, [...byTarget.get(target) ?? [], format]);
    }
    for (const [target, targetFormats] of byTarget) {
      const executable = await build({
        entrypoint: input, outfile: byTarget.size === 1 ? string("outfile") : undefined, ...metadata, target, runtime,
        compileJsx: values["compile-jsx"] === true, smol: values.smol === true,
        targetExecutable: string("target-executable"), nativeFeatures: string("native-features"),
      });
      emit(executable, targetFormats);
    }
  } else {
    emit(input, formats);
  }
  return 0;
}

function keygen(outDir = "."): number {
  const path = resolve(outDir, KEY_FILE);
  if (existsSync(path)) throw new Error(`${path} already exists; delete it to replace the key (installed apps reject updates signed with a new one).`);
  const keys = generateUpdateKeys();
  writeFileSync(path, keys.privateKey + "\n", { mode: 0o600 });
  console.log(`private key: ${path} (keep it secret and out of git)`);
  console.log(`public key:  ${keys.publicKey}`);
  return 0;
}
/** The update private key: --key, then TARVE_UPDATE_PRIVATE_KEY, then ./tarve-update.key. */
function updateKey(flag: string | undefined, command: string): string {
  const key = flag ?? process.env.TARVE_UPDATE_PRIVATE_KEY ?? (existsSync(KEY_FILE) ? KEY_FILE : undefined);
  if (!key) throw new Error(`${command} needs --key, TARVE_UPDATE_PRIVATE_KEY or ./${KEY_FILE} (tarve keygen).`);
  return key;
}
