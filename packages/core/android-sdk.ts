import { existsSync, readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { delimiter, join } from "node:path";

/** The lowest Android API level the app runs on. */
export const MIN_SDK = 26;

export const windows = process.platform === "win32";
export const exe = (name: string) => windows ? `${name}.exe` : name;

export function versionDirectories(directory: string): string[] {
  if (!existsSync(directory)) return [];
  const parts = (name: string) => name.split(/[.-]/).map(part => Number.parseInt(part, 10) || 0);
  return readdirSync(directory)
    .filter(name => statSync(join(directory, name)).isDirectory())
    .sort((a, b) => {
      const [x, y] = [parts(a), parts(b)];
      for (let index = 0; index < Math.max(x.length, y.length); index++) {
        const difference = (y[index] ?? 0) - (x[index] ?? 0);
        if (difference) return difference;
      }
      return 0;
    })
    .map(name => join(directory, name));
}

export function androidSdk(): string {
  const candidates = [
    process.env.ANDROID_HOME,
    process.env.ANDROID_SDK_ROOT,
    windows && process.env.LOCALAPPDATA ? join(process.env.LOCALAPPDATA, "Android", "Sdk") : undefined,
    join(homedir(), "Library", "Android", "sdk"),
    join(homedir(), "Android", "Sdk"),
  ];
  const sdk = candidates.find(candidate => candidate && existsSync(join(candidate, "build-tools")));
  if (!sdk) throw new Error("Android SDK not found: install it (Android Studio, or sdkmanager \"build-tools;35.0.0\" \"platforms;android-35\") and set ANDROID_HOME.");
  return sdk;
}

export function buildTools(sdk: string): string {
  const tools = versionDirectories(join(sdk, "build-tools")).find(directory => existsSync(join(directory, exe("aapt2"))));
  if (!tools) throw new Error(`No build-tools with aapt2 in ${join(sdk, "build-tools")}: sdkmanager "build-tools;35.0.0"`);
  return tools;
}

export function platformJar(sdk: string): string {
  const platforms = join(sdk, "platforms");
  const jar = existsSync(platforms)
    ? readdirSync(platforms)
      .map(name => ({ name, level: Number(/^android-(\d+)$/.exec(name)?.[1] ?? 0) }))
      .filter(({ level }) => level >= MIN_SDK)
      .sort((a, b) => b.level - a.level)
      .map(({ name }) => join(platforms, name, "android.jar"))
      .find(path => existsSync(path))
    : undefined;
  if (!jar) throw new Error(`No Android platform (API ${MIN_SDK}+) in ${platforms}: sdkmanager "platforms;android-35"`);
  return jar;
}

export function androidNdk(sdk = androidSdk()): string {
  const explicit = process.env.ANDROID_NDK_HOME ?? process.env.ANDROID_NDK_ROOT ?? process.env.NDK_HOME;
  if (explicit && existsSync(explicit)) return explicit;
  const ndk = versionDirectories(join(sdk, "ndk"))[0] ?? (existsSync(join(sdk, "ndk-bundle")) ? join(sdk, "ndk-bundle") : undefined);
  if (!ndk) throw new Error("Android NDK not found: sdkmanager \"ndk;27.2.12479018\", or set ANDROID_NDK_HOME.");
  return ndk;
}

/** A JDK's java and keytool: JAVA_HOME, Android Studio's bundled JBR, then PATH. */
export function jdk(): { java: string; keytool: string; javac: string; jarsigner: string } {
  const homes = [
    process.env.JAVA_HOME,
    ...windows ? [join(process.env.ProgramFiles ?? "C:\\Program Files", "Android", "Android Studio", "jbr")] : [],
    "/Applications/Android Studio.app/Contents/jbr/Contents/Home",
    "/opt/android-studio/jbr",
    ...process.env.LOCALAPPDATA ? versionDirectories(join(process.env.LOCALAPPDATA, "Android", "jdk")) : [],
  ];
  const tools = (bin: string) => ({ java: join(bin, exe("java")), keytool: join(bin, exe("keytool")), javac: join(bin, exe("javac")), jarsigner: join(bin, exe("jarsigner")) });
  const home = homes.find(candidate => candidate && existsSync(join(candidate, "bin", exe("java"))));
  if (home) return tools(join(home, "bin"));
  const onPath = (process.env.PATH ?? "").split(delimiter).find(directory => directory && existsSync(join(directory, exe("java"))));
  if (onPath) return tools(onPath);
  throw new Error("A JDK (17+) is needed to sign the APK: install one and set JAVA_HOME.");
}

/** A Java package name from the app id or name: `Acme.Notes` → `acme.notes`, `Counter` → `dev.tarve.counter`. */
export function androidPackageName(appId: string | undefined, name: string): string {
  const segment = (text: string) => {
    const cleaned = text.toLowerCase().replace(/[^a-z0-9_]/g, "_").replace(/^_+|_+$/g, "");
    return !cleaned ? "app" : /^[a-z]/.test(cleaned) ? cleaned : `app_${cleaned}`;
  };
  const parts = (appId ?? "").split(/[.\s/]+/).filter(Boolean).map(segment);
  return parts.length >= 2 ? parts.join(".") : `dev.tarve.${parts[0] ?? segment(name)}`;
}

/** `1.2.3` → 10203; a missing version is 1. */
export function androidVersionCode(version: string | undefined): number {
  const [major = 0, minor = 0, patch = 0] = (version ?? "").split(/[.+-]/).map(part => Number.parseInt(part, 10) || 0);
  return Math.max(1, Math.min(2_100_000_000, major * 10_000 + minor * 100 + patch));
}

export const escapeXml = (value: string) => value.replace(/[<>&"']/g, character => `&#${character.charCodeAt(0)};`);
