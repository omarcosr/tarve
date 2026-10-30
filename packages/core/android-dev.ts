/**
 * `tarve dev app.tsx --target android`: builds and installs a dev APK once, launches it, then
 * rebundles only the JS on every save, pushes it to the app's external files directory
 * (`/sdcard/Android/data/<id>/files/dev/app.js`, which the dev APK runs instead of its
 * assets/tarve/app.js: native/src/android/qjs/dev.rs) and restarts the activity. No reinstall.
 * The app's console (logcat tag `tarve`) and crashes print here.
 */
import { execFile, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, watch, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { createInterface } from "node:readline";
import { metadataOverrides, type BuildOptions } from "./build";
import { buildMetadata } from "./package-metadata";
import { bundleAndroidJs } from "./android-bundle";
import { buildAndroid, type AndroidBuildOptions, type AndroidTarget } from "./android-build";
import { androidPackageName, androidSdk, exe } from "./android-sdk";

export interface AndroidDevOptions extends AndroidBuildOptions {
  /** adb serial (`adb devices`); defaults to ANDROID_SERIAL, then adb's only device. */
  device?: string;
}

/** The logcat line the dev APK writes once it evaluated a pushed bundle (native/src/android/qjs.rs). */
export const RELOADED_LINE = "tarve dev: pushed bundle evaluated";

/** adb's device selection: --device, then ANDROID_SERIAL; none lets adb pick its only device. */
export function adbDeviceArgs(device: string | undefined, env: NodeJS.ProcessEnv = process.env): string[] {
  const serial = device?.trim() || env.ANDROID_SERIAL?.trim();
  return serial ? ["-s", serial] : [];
}

/** `--target android` packs every ABI; the dev APK only needs the device's (smaller, faster to install). */
export function devTarget(target: AndroidTarget | undefined, deviceAbi: string): AndroidTarget {
  if (target && target !== "android") return target;
  const abi = deviceAbi.trim();
  return abi === "x86_64" ? "android-x64" : abi === "arm64-v8a" ? "android-arm64" : "android";
}

/** Where the dev APK looks for a pushed bundle and the files it imports: its external files directory. */
export function devPaths(packageName: string): { directory: string; bundle: string; files: string } {
  const directory = `/sdcard/Android/data/${packageName}/files/dev`;
  return { directory, bundle: `${directory}/app.js`, files: `${directory}/files` };
}

/** The app's Linux uid from `pm list packages -U <name>` (which also lists names it is a prefix of). */
export function packageUid(output: string, packageName: string): string | undefined {
  for (const line of output.split(/\r?\n/)) {
    const match = /^package:(\S+)\s+uid:(\d+)/.exec(line.trim());
    if (match?.[1] === packageName) return match[2];
  }
  return undefined;
}

/** logcat filter for the app's console (tag `tarve`) and its crashes, only its own lines when the uid is known. */
export function logcatArgs(uid: string | undefined): string[] {
  return [...uid ? [`--uid=${uid}`] : [], "-v", "tag", "-s", "tarve:*", "AndroidRuntime:E", "libc:F"];
}

const BUNDLED = /\.(?:[cm]?[jt]sx?|json|css|svelte|vue|png|jpe?g|webp|gif|svg|ico|woff2?|ttf|otf|mp3|mp4|wav|ogg|webm|txt|md|html?)$/i;

/** Whether a changed file (relative to the watched directory) can change the bundle: sources and assets, not builds, logs or dot directories. */
export function isSourceChange(path: string): boolean {
  return BUNDLED.test(path) && !/(^|[\\/])(node_modules|dist|target|\.[^\\/]+)[\\/]/.test(path);
}

/** The directory watched for saves: the app's package (nearest package.json), else the entry's directory. */
export function watchRoot(entrypoint: string, exists: (path: string) => boolean = existsSync): string {
  const start = dirname(resolve(entrypoint));
  for (let directory = start; ; directory = dirname(directory)) {
    if (exists(join(directory, "package.json"))) return directory;
    if (dirname(directory) === directory) return start;
  }
}

function adbPath(): string {
  try {
    const path = join(androidSdk(), "platform-tools", exe("adb"));
    if (existsSync(path)) return path;
  } catch { /* no SDK found: adb from PATH */ }
  return "adb";
}

const since = (start: number) => `${Math.round(performance.now() - start)} ms`;
const digest = (path: string) => createHash("sha1").update(readFileSync(path)).digest("hex");
const message = (error: unknown) => error instanceof Error ? error.message : String(error);

export async function devAndroid(options: AndroidDevOptions): Promise<number> {
  if (!/\.[cm]?[jt]sx?$/i.test(options.entrypoint)) throw new Error("tarve dev --target android needs a JS/TS app entry; build Go apps with tarve build.");
  const adbExecutable = adbPath();
  const device = adbDeviceArgs(options.device);
  const adb = (...args: string[]) => new Promise<string>((resolveOutput, reject) => {
    execFile(adbExecutable, [...device, ...args], { maxBuffer: 16 << 20 }, (error, stdout, stderr) => {
      if (error) reject(new Error(`adb ${args.join(" ")}: ${(stderr || stdout || error.message).trim()}`));
      else resolveOutput(stdout);
    });
  });
  const abi = await adb("shell", "getprop", "ro.product.cpu.abi").catch(error => {
    throw new Error(`${message(error)}\nConnect a device or start an emulator; with several, pick one with --device <serial> or ANDROID_SERIAL (adb devices).`);
  });
  const target = devTarget(options.target, abi);
  const { metadata, define } = buildMetadata(options.entrypoint, metadataOverrides(options as BuildOptions));
  const packageName = androidPackageName(metadata.appId, metadata.name);
  const paths = devPaths(packageName);
  const activity = `${packageName}/dev.tarve.TarveActivity`;
  const temporary = mkdtempSync(join(tmpdir(), "tarve-android-dev-"));
  try {
    let start = performance.now();
    const first = await bundleAndroidJs(options as BuildOptions, define, temporary);
    // Files the APK carries; a later bundle's new imports are pushed beside its app.js.
    const pushed = new Set(first.assets.map(asset => asset.name));
    let current = digest(first.bundle);
    const apk = await buildAndroid({ ...options, target, format: "apk", dev: true, bundled: first, outfile: options.outfile ?? join(temporary, "dev.apk") });
    console.log(`tarve dev: built ${packageName} for ${target} (${since(start)})`);
    start = performance.now();
    await adb("install", "-r", apk).catch(error => {
      throw new Error(`${message(error)}${/INCOMPATIBLE|SIGNATURE/.test(message(error)) ? `\nAn APK signed with another key is installed: adb uninstall ${packageName}` : ""}`);
    });
    console.log(`tarve dev: installed (${since(start)})`);
    // A bundle pushed in an earlier session must not shadow the fresh APK.
    await adb("shell", "rm", "-rf", paths.directory);
    // This app's lines (--uid: other apps log under `tarve` too) from now on; no `logcat -c`,
    // which would clear the device's log for everyone else.
    const uid = packageUid(await adb("shell", "pm", "list", "packages", "-U", packageName), packageName);
    const since0 = `${(await adb("shell", "date", "+%s")).trim()}.000`;
    let savedAt: number | undefined;
    const startLogcat = (filter: boolean) => {
      const child = spawn(adbExecutable, [...device, "logcat", "-T", since0, ...logcatArgs(filter ? uid : undefined)], { stdio: ["ignore", "pipe", "pipe"] });
      createInterface({ input: child.stdout! }).on("line", raw => {
        const line = raw.replace(/\r+$/, "");
        console.log(line);
        if (savedAt !== undefined && line.includes(RELOADED_LINE)) {
          console.log(`tarve dev: reloaded ${since(savedAt)} after the save`);
          savedAt = undefined;
        }
      });
      return child;
    };
    let logcat = startLogcat(uid !== undefined);
    // Android 8 logcat has no --uid: every app's `tarve` lines then.
    if (uid !== undefined && await new Promise(done => { logcat.once("exit", () => done(true)); setTimeout(() => done(false), 1500); })) {
      logcat = startLogcat(false);
    }
    logcat.stderr!.pipe(process.stderr);
    await adb("shell", "am", "start", "-n", activity);
    const root = watchRoot(options.entrypoint);
    console.log(`tarve dev: watching ${root} (Ctrl+C to stop; the app keeps running)`);

    let changedAt: number | undefined;
    let building = false;
    let failure: string | undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const rebuild = async () => {
      if (building) return;
      building = true;
      while (changedAt !== undefined) {
        const at = changedAt;
        changedAt = undefined;
        try {
          const next = await bundleAndroidJs(options as BuildOptions, define, temporary);
          const hash = digest(next.bundle);
          failure = undefined;
          if (hash === current) continue;
          for (const asset of next.assets.filter(asset => !pushed.has(asset.name))) {
            const local = join(temporary, "files", asset.name);
            mkdirSync(dirname(local), { recursive: true });
            writeFileSync(local, asset.data);
            await adb("push", local, `${paths.files}/${asset.name}`);
            pushed.add(asset.name);
          }
          await adb("push", next.bundle, paths.bundle);
          current = hash;
          savedAt = at;
          await adb("shell", "am", "start", "-S", "-n", activity);
          console.log(`tarve dev: pushed and restarted (${since(at)} after the save)`);
        } catch (error) {
          // Unrelated files saved meanwhile rebundle too: the same error prints once.
          if (message(error) !== failure) console.error(`tarve dev: ${message(error)}\ntarve dev: the app keeps running the last good bundle.`);
          failure = message(error);
        }
      }
      building = false;
    };
    const watcher = watch(root, { recursive: true }, (_event, file) => {
      if (!file || !isSourceChange(String(file))) return;
      changedAt ??= performance.now();
      clearTimeout(timer);
      timer = setTimeout(() => void rebuild(), 30);
    });
    try {
      return await new Promise<number>(resolveCode => {
        const stop = () => resolveCode(0);
        process.once("SIGINT", stop);
        process.once("SIGTERM", stop);
        logcat.once("exit", () => {
          console.error("tarve dev: adb logcat ended (device disconnected?)");
          resolveCode(1);
        });
      });
    } finally {
      watcher.close();
      clearTimeout(timer);
      logcat.kill();
    }
  } finally {
    if (options.compileJsx) await (await import("./jsx-compile")).closeJsxCompiler();
    rmSync(temporary, { recursive: true, force: true });
  }
}
