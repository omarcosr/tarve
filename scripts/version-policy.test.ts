import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { assertVersionsSynchronized, readProductVersions, setProductVersion } from "./version-policy";

async function fixture(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "tarve-version-policy-"));
  await mkdir(join(root, "packages/core"), { recursive: true });
  await mkdir(join(root, "packages/protocol"), { recursive: true });
  await mkdir(join(root, "native"), { recursive: true });
  await Bun.write(join(root, "package.json"), JSON.stringify({ name: "tarve", version: "1.2.3" }));
  await Bun.write(join(root, "packages/core/package.json"), JSON.stringify({ name: "@tarve/core", version: "1.2.3" }));
  await Bun.write(join(root, "packages/protocol/package.json"), JSON.stringify({ name: "@tarve/protocol", version: "1.2.3" }));
  await Bun.write(join(root, "bun.lock"), '{"workspaces":{"packages/core":{"name":"@tarve/core","version":"1.2.3"},"packages/protocol":{"name":"@tarve/protocol","version":"1.2.3"}}}');
  await Bun.write(join(root, "native/Cargo.toml"), '[package]\nname = "tarve_native"\nversion = "1.2.3"\nedition = "2024"\n\n[lib]\ncrate-type = ["cdylib"]\n');
  await Bun.write(join(root, "native/Cargo.lock"), 'version = 4\n\n[[package]]\nname = "tarve_native"\nversion = "1.2.3"\n');
  return root;
}

describe("product version policy", () => {
  test("detects drift and synchronizes every product manifest", async () => {
    const root = await fixture();
    expect(assertVersionsSynchronized(await readProductVersions(root))).toBe("1.2.3");
    const core = join(root, "packages/core/package.json");
    const manifest = await Bun.file(core).json();
    manifest.version = "1.2.4";
    await Bun.write(core, JSON.stringify(manifest));
    const drifted = await readProductVersions(root);
    expect(() => assertVersionsSynchronized(drifted)).toThrow("Product version drift");
    await setProductVersion(root, "2.0.0-beta.1");
    expect(assertVersionsSynchronized(await readProductVersions(root))).toBe("2.0.0-beta.1");
  });
});
