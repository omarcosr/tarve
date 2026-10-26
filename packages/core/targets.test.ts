import { describe, expect, test } from "bun:test";
import { BUILD_TARGETS, PACKAGED_TARGETS, hostBuildTarget, isBuildTarget, isMacTarget, nativeRelativePath, targetConfig } from "./targets";

describe("build targets", () => {
  test("lists Windows, Linux and both macOS architectures", () => {
    expect([...BUILD_TARGETS]).toEqual(["windows-x64", "linux-x64", "darwin-arm64", "darwin-x64"]);
    for (const target of BUILD_TARGETS) expect(isBuildTarget(target)).toBe(true);
    expect(isBuildTarget("darwin-universal")).toBe(false);
  });

  test("macOS targets use the dylib in native/darwin-<arch>", () => {
    expect(targetConfig("darwin-arm64")).toEqual({
      platform: "darwin", arch: "arm64", bunTarget: "bun-darwin-arm64",
      nativeDirectory: "darwin-arm64", nativeName: "libtarve_native.dylib", executableSuffix: "",
    });
    expect(targetConfig("darwin-x64").bunTarget).toBe("bun-darwin-x64");
    expect(nativeRelativePath("darwin-arm64")).toBe("native/darwin-arm64/libtarve_native.dylib");
    expect(nativeRelativePath("darwin-x64")).toBe("native/darwin-x64/libtarve_native.dylib");
    expect(isMacTarget("darwin-x64")).toBe(true);
    expect(isMacTarget("linux-x64")).toBe(false);
  });

  test("keeps the Windows and Linux targets unchanged", () => {
    expect(nativeRelativePath("windows-x64")).toBe("native/win32-x64/tarve_native.dll");
    expect(nativeRelativePath("linux-x64")).toBe("native/linux-x64/libtarve_native.so");
    expect(targetConfig("windows-x64").executableSuffix).toBe(".exe");
  });

  test("maps hosts, darwin included", () => {
    expect(hostBuildTarget("win32", "x64")).toBe("windows-x64");
    expect(hostBuildTarget("linux", "x64")).toBe("linux-x64");
    expect(hostBuildTarget("darwin", "arm64")).toBe("darwin-arm64");
    expect(hostBuildTarget("darwin", "x64")).toBe("darwin-x64");
    expect(hostBuildTarget("linux", "arm64")).toBeUndefined();
    expect(hostBuildTarget("freebsd", "x64")).toBeUndefined();
  });

  test("the npm package still ships only the Windows and Linux runtimes", () => {
    expect([...PACKAGED_TARGETS]).toEqual(["windows-x64", "linux-x64"]);
  });
});
