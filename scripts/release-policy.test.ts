import { describe, expect, test } from "bun:test";
import { resolve } from "node:path";
import { assertReleasePolicy } from "./release-policy";

const root = resolve(import.meta.dir, "..");

describe("repository release policy", () => {
  test("keeps license, product version, protocol and ABI policy coherent", async () => {
    const state = await assertReleasePolicy(root);
    expect(state.license).toBe("Apache-2.0");
    expect(state.distribution).toBe("open-source");
    expect(state.protocolVersion).not.toBe(state.nativeAbiVersion);
  });

  test("requires a release tag to exactly match the product version", async () => {
    const state = await assertReleasePolicy(root);
    expect((await assertReleasePolicy(root, `v${state.version}`)).tag).toBe(`v${state.version}`);
    await expect(assertReleasePolicy(root, "v999.0.0")).rejects.toThrow("Release tag mismatch");
  });
});
