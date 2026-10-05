import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  assertNativeRuntimeCompatible,
  createNativeCompatibilityManifest,
  nativeSourceFingerprint,
  writeNativeRuntimeManifest,
  type NativeCompatibilityManifest,
} from "./native-runtime";

const temporary: string[] = [];

afterEach(async () => {
  await Promise.all(temporary.splice(0).map(path => rm(path, { recursive: true, force: true })));
});

function compatibility(overrides: Partial<NativeCompatibilityManifest> = {}): NativeCompatibilityManifest {
  return {
    schemaVersion: 1,
    packageVersion: "1.2.3",
    protocolVersion: 42,
    nativeAbiVersion: 5,
    sourceFingerprint: "a".repeat(64),
    ...overrides,
  };
}

describe("native runtime compatibility manifests", () => {
  test("accepts a matching runtime and binds metadata to the library bytes", async () => {
    const root = await mkdtemp(join(tmpdir(), "tarve-runtime-"));
    temporary.push(root);
    const directory = join(root, "linux-x64");
    await mkdir(directory);
    const library = join(directory, "libtarve_native.so");
    await writeFile(library, "native-v42");
    await writeNativeRuntimeManifest(library, "linux-x64", compatibility());
    await expect(assertNativeRuntimeCompatible(
      library,
      "linux-x64",
      compatibility(),
    )).resolves.toMatchObject({ target: "linux-x64", protocolVersion: 42 });
    await writeFile(library, "modified-after-manifest");
    await expect(assertNativeRuntimeCompatible(
      library,
      "linux-x64",
      compatibility(),
    )).rejects.toThrow("hash mismatch");
  });

  test("rejects stale protocol/source metadata before cross-compilation", async () => {
    const root = await mkdtemp(join(tmpdir(), "tarve-runtime-"));
    temporary.push(root);
    const directory = join(root, "linux-x64");
    await mkdir(directory);
    const library = join(directory, "libtarve_native.so");
    await writeFile(library, "native-v41");
    await writeNativeRuntimeManifest(
      library,
      "linux-x64",
      compatibility({ protocolVersion: 41, sourceFingerprint: "b".repeat(64) }),
    );
    await expect(assertNativeRuntimeCompatible(
      library,
      "linux-x64",
      compatibility(),
    )).rejects.toThrow("stale or incompatible");
  });

  test("rejects a staged cross-target runtime without metadata", async () => {
    const root = await mkdtemp(join(tmpdir(), "tarve-runtime-"));
    temporary.push(root);
    const directory = join(root, "linux-x64");
    await mkdir(directory);
    const library = join(directory, "libtarve_native.so");
    await writeFile(library, "legacy-runtime");
    await expect(assertNativeRuntimeCompatible(
      library,
      "linux-x64",
      compatibility(),
    )).rejects.toThrow("metadata missing");
  });

  test("source fingerprints are stable across LF and CRLF checkouts", async () => {
    const root = await mkdtemp(join(tmpdir(), "tarve-source-"));
    temporary.push(root);
    await mkdir(join(root, "native", "src"), { recursive: true });
    await writeFile(join(root, "native", "Cargo.toml"), "[package]\nname = \"tarve_native\"\n");
    await writeFile(join(root, "native", "Cargo.lock"), "version = 4\n");
    const source = join(root, "native", "src", "lib.rs");
    await writeFile(source, "pub fn value() -> u32 {\n    42\n}\n");
    const lf = await nativeSourceFingerprint(root);
    await writeFile(source, "pub fn value() -> u32 {\r\n    42\r\n}\r\n");
    const crlf = await nativeSourceFingerprint(root);
    expect(crlf).toBe(lf);
  });

  test("compatibility metadata refuses TypeScript/Rust protocol drift", async () => {
    const root = await mkdtemp(join(tmpdir(), "tarve-source-"));
    temporary.push(root);
    await mkdir(join(root, "native", "src"), { recursive: true });
    await writeFile(join(root, "native", "Cargo.toml"), "[package]\nname = \"tarve_native\"\n");
    await writeFile(join(root, "native", "Cargo.lock"), "version = 4\n");
    await writeFile(join(root, "native", "src", "protocol.rs"), "pub const VERSION: u32 = 41;\n");
    await writeFile(join(root, "native", "src", "bridge.rs"), "pub const ABI_VERSION: u32 = 5;\n");
    await expect(createNativeCompatibilityManifest(root, "1.2.3")).rejects.toThrow(
      "TypeScript=53, Rust=41",
    );
  });
});
