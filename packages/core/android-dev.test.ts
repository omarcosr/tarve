import { describe, expect, test } from "bun:test";
import { join, resolve } from "node:path";
import { adbDeviceArgs, devPaths, devTarget, isSourceChange, logcatArgs, packageUid, watchRoot } from "./android-dev";

describe("tarve dev --target android", () => {
  test("--device wins over ANDROID_SERIAL; neither leaves the choice to adb", () => {
    expect(adbDeviceArgs("emulator-5554", { ANDROID_SERIAL: "R5CW" })).toEqual(["-s", "emulator-5554"]);
    expect(adbDeviceArgs(undefined, { ANDROID_SERIAL: "R5CW" })).toEqual(["-s", "R5CW"]);
    expect(adbDeviceArgs(" ", { ANDROID_SERIAL: "" })).toEqual([]);
    expect(adbDeviceArgs(undefined, {})).toEqual([]);
  });

  test("--target android builds only the device's ABI; an explicit ABI target is kept", () => {
    expect(devTarget(undefined, "x86_64\r\n")).toBe("android-x64");
    expect(devTarget("android", "arm64-v8a\n")).toBe("android-arm64");
    expect(devTarget("android", "armeabi-v7a")).toBe("android");
    expect(devTarget("android-arm64", "x86_64")).toBe("android-arm64");
  });

  test("the bundle is pushed to the app's external files directory, where the dev APK looks", () => {
    expect(devPaths("dev.tarve.devloop")).toEqual({
      directory: "/sdcard/Android/data/dev.tarve.devloop/files/dev",
      bundle: "/sdcard/Android/data/dev.tarve.devloop/files/dev/app.js",
      files: "/sdcard/Android/data/dev.tarve.devloop/files/dev/files",
    });
  });

  test("logcat follows only the app's uid when pm reports it", () => {
    const output = "package:dev.tarve.devloop2 uid:10300\r\npackage:dev.tarve.devloop uid:10227\r\n";
    expect(packageUid(output, "dev.tarve.devloop")).toBe("10227");
    expect(packageUid(output, "dev.tarve.other")).toBeUndefined();
    expect(logcatArgs("10227")).toEqual(["--uid=10227", "-v", "tag", "-s", "tarve:*", "AndroidRuntime:E", "libc:F"]);
    expect(logcatArgs(undefined)[0]).toBe("-v");
  });

  test("saves under node_modules, dist, target, .git and editor temp files are ignored", () => {
    expect(isSourceChange("app.tsx")).toBe(true);
    expect(isSourceChange(join("src", "components", "List.tsx"))).toBe(true);
    expect(isSourceChange("targets.ts")).toBe(true);
    expect(isSourceChange(join("node_modules", "x", "index.js"))).toBe(false);
    expect(isSourceChange(join("dist", "App.apk"))).toBe(false);
    expect(isSourceChange("native/target/debug/x.rs")).toBe(false);
    expect(isSourceChange(".git/index")).toBe(false);
    expect(isSourceChange(join(".cache", "x.json"))).toBe(false);
    expect(isSourceChange("app.tsx~")).toBe(false);
    expect(isSourceChange("work/run.log")).toBe(false);
    expect(isSourceChange("native/src/lib.rs")).toBe(false);
    expect(isSourceChange("assets/logo.png")).toBe(true);
  });

  test("watches the app's package directory, else the entry's directory", () => {
    const app = resolve("/work/apps/todo/src/app.tsx");
    expect(watchRoot(app, path => path === resolve("/work/apps/todo/package.json"))).toBe(resolve("/work/apps/todo"));
    expect(watchRoot(app, () => false)).toBe(resolve("/work/apps/todo/src"));
  });
});
