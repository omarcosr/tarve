import { expect, test } from "bun:test";
import { resolve } from "node:path";
import { BUILD_TARGETS, hostBuildTarget, nativeDirectoryForBuildTarget, nativeRelativePath } from "./build";

test("public build targets map to packaged native runtime directories", () => {
  expect(nativeDirectoryForBuildTarget("windows-x64")).toBe("win32-x64");
  expect(nativeDirectoryForBuildTarget("linux-x64")).toBe("linux-x64");
  expect(nativeRelativePath("windows-x64")).toBe("native/win32-x64/tarve_native.dll");
  expect(nativeRelativePath("linux-x64")).toBe("native/linux-x64/libtarve_native.so");
  expect(hostBuildTarget("win32", "x64")).toBe("windows-x64");
  expect(hostBuildTarget("linux", "x64")).toBe("linux-x64");
  expect(hostBuildTarget("darwin", "arm64")).toBeUndefined();
});

test("npm package includes every supported native target directory", async () => {
  const metadata = await Bun.file(resolve(import.meta.dir, "../../package.json")).json() as { files?: string[] };
  const files = new Set(metadata.files ?? []);
  for (const target of BUILD_TARGETS) {
    expect(files.has(`native/${nativeDirectoryForBuildTarget(target)}`)).toBe(true);
  }
});
