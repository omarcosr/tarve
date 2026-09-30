import { expect, test } from "bun:test";
import { createHash, randomUUID } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { materializeAsset } from "./embedded-assets";

function source(content: string) {
  const directory = mkdtempSync(join(tmpdir(), "tarve-asset-src-"));
  const path = join(directory, "lib.bin");
  writeFileSync(path, content);
  const bytes = Buffer.from(content);
  return { path, digest: { sha256: createHash("sha256").update(bytes).digest("hex"), size: bytes.length } };
}

test("a build-time digest extracts once and reuses the copy without reading the source", () => {
  const asset = source(`native ${randomUUID()}`);
  const extracted = materializeAsset(asset.path, "lib.bin", asset.digest);
  expect(readFileSync(extracted, "utf8")).toBe(readFileSync(asset.path, "utf8"));
  rmSync(asset.path);
  // A second launch has an empty in-memory cache; emulate it with a new key.
  expect(materializeAsset(`${asset.path}-relaunch`, "lib.bin", asset.digest)).toBe(extracted);
  rmSync(join(extracted, ".."), { recursive: true, force: true });
});

test("a copy with the wrong size is rewritten from the embedded bytes", () => {
  const asset = source(`native ${randomUUID()}`);
  const extracted = materializeAsset(asset.path, "lib.bin", asset.digest);
  writeFileSync(extracted, "x");
  const relaunch = `${asset.path}-relaunch`;
  writeFileSync(relaunch, readFileSync(asset.path));
  expect(materializeAsset(relaunch, "lib.bin", asset.digest)).toBe(extracted);
  expect(readFileSync(extracted, "utf8")).toBe(readFileSync(asset.path, "utf8"));
  rmSync(join(extracted, ".."), { recursive: true, force: true });
});

test("embedded bytes that do not match the build-time digest are rejected", () => {
  const asset = source(`native ${randomUUID()}`);
  const stale = { sha256: "0".repeat(64), size: 1 };
  expect(() => materializeAsset(asset.path, "lib.bin", stale)).toThrow("build-time digest");
});
