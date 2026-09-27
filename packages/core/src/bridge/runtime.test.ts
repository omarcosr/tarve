import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { developmentLibrary } from "./runtime";

const directories: string[] = [];

afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function manifest(value: unknown): string {
  const directory = mkdtempSync(join(tmpdir(), "tarve-runtime-"));
  directories.push(directory);
  writeFileSync(join(directory, "current.json"), JSON.stringify(value));
  return directory;
}

describe("development native runtime manifest", () => {
  test("uses a runtime tagged for the requested host target", () => {
    const directory = manifest({ target: "linux-x64", library: "libtarve_native-abc123.so" });
    expect(developmentLibrary(directory, "linux-x64")).toBe(join(directory, "libtarve_native-abc123.so"));
  });

  test("ignores a manifest produced for another host target", () => {
    const directory = manifest({ target: "windows-x64", library: "tarve_native-abc123.dll" });
    expect(developmentLibrary(directory, "linux-x64")).toBeUndefined();
  });

  test("ignores legacy manifests whose native filename belongs to another host", () => {
    const directory = manifest({ library: "tarve_native-abc123.dll" });
    expect(developmentLibrary(directory, "linux-x64")).toBeUndefined();
  });
});
