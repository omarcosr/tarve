import { expect, test } from "bun:test";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { nativePath } from "./src/bridge/runtime";
import { buildNode } from "./node-build";
import { NtExecutable, NtExecutableResource, Resource } from "resedit";

const node = Bun.which("node");
const version = node ? spawnSync(node, ["--version"], { encoding: "utf8" }).stdout.trim() : "";
const supported = /^v(?:2[7-9]|[3-9]\d)\.|^v26\.(?:1\d|[2-9]\d)\./.test(version);

test.skipIf(!supported)("Node SEA runs the same native TSX app without Bun", async () => {
  let library: string;
  try { library = nativePath(); } catch { return; }
  if (!existsSync(library)) return;
  const directory = mkdtempSync(join(tmpdir(), "tarve-node-smoke-"));
  try {
    const outfile = join(directory, process.platform === "win32" ? "App.exe" : "App");
    await buildNode({
      entrypoint: resolve(import.meta.dirname, "../../examples/node-smoke.tsx"),
      outfile,
      nativeLibrary: library,
      nodeExecutable: node ?? undefined,
    });
    expect(execFileSync(outfile, { encoding: "utf8", timeout: 15000 })).toContain("tarve-node-ready");
    // Rebuilding over an existing executable succeeds, as with Bun builds.
    await buildNode({ entrypoint: resolve(import.meta.dirname, "../../examples/node-smoke.tsx"), outfile, nativeLibrary: library, nodeExecutable: node ?? undefined });
    expect(execFileSync(outfile, { encoding: "utf8", timeout: 15000 })).toContain("tarve-node-ready");
    if (process.platform === "win32") {
      // Same identity as a Bun-compiled app: GUI subsystem (no console window) and Tarve metadata.
      const binary = readFileSync(outfile);
      expect(binary.readUInt16LE(binary.readUInt32LE(0x3c) + 24 + 68)).toBe(2);
      const info = Resource.VersionInfo.fromEntries(NtExecutableResource.from(NtExecutable.from(binary, { ignoreCert: true })).entries)[0]!;
      const strings = info.getStringValues(info.getAllLanguagesForStringValues()[0]!);
      expect(strings.FileDescription).toBe("node-smoke — native Tarve application");
      expect(strings.ProductName).toBe("node-smoke");
      expect(strings.CompanyName).toBeUndefined();
    }
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}, 60000);
