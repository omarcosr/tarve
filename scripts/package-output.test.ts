import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { cleanPackageOutputs } from "./package-output";

describe("package output cleanup", () => {
  test("removes stale generated package trees and tarballs without touching unrelated dist artifacts", async () => {
    const root = await mkdtemp(join(tmpdir(), "tarve-package-clean-"));
    const stale = [
      join(root, "dist/npm/removed.js"),
      join(root, "dist/types/removed.d.ts"),
      join(root, "native/win32-x64/removed.dll"),
      join(root, "dist/tarve-0.0.1.tgz"),
      join(root, "dist/tarve-old.tgz"),
    ];
    for (const file of stale) {
      await mkdir(join(file, ".."), { recursive: true });
      await Bun.write(file, "stale");
    }
    const capture = join(root, "dist/components-real.png");
    await Bun.write(capture, "keep");

    await cleanPackageOutputs(root);

    for (const file of stale) expect(await Bun.file(file).exists()).toBe(false);
    expect(await Bun.file(capture).text()).toBe("keep");
  });
});
