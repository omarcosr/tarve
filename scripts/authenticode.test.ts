import { describe, expect, test } from "bun:test";
import { assertSigningEnvironment, signingRequested } from "./authenticode";

describe("Authenticode configuration", () => {
  test("requires an explicit signing switch and exactly one PFX source", () => {
    expect(signingRequested({})).toBe(false);
    expect(signingRequested({ TARVE_AUTHENTICODE_SIGN: "1" })).toBe(true);
    expect(() => assertSigningEnvironment({})).toThrow("exactly one");
    expect(() => assertSigningEnvironment({
      TARVE_AUTHENTICODE_PFX_BASE64: "ZmFrZQ==",
      TARVE_AUTHENTICODE_PFX_PATH: "certificate.pfx",
      TARVE_AUTHENTICODE_PFX_PASSWORD: "secret",
    })).toThrow("exactly one");
    expect(() => assertSigningEnvironment({
      TARVE_AUTHENTICODE_PFX_BASE64: "ZmFrZQ==",
    })).toThrow("PASSWORD");
    expect(() => assertSigningEnvironment({
      TARVE_AUTHENTICODE_PFX_BASE64: "ZmFrZQ==",
      TARVE_AUTHENTICODE_PFX_PASSWORD: "secret",
    })).not.toThrow();
  });
});
