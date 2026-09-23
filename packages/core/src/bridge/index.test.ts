import { describe, expect, test } from "bun:test";
import { NATIVE_ABI_VERSION, PROTOCOL_VERSION } from "../../../protocol/src/index";
import { assertNativeAbiVersion } from "./index";

describe("native ABI compatibility", () => {
  test("is versioned independently from the JSON protocol", () => {
    expect(NATIVE_ABI_VERSION).not.toBe(PROTOCOL_VERSION);
    expect(() => assertNativeAbiVersion(NATIVE_ABI_VERSION)).not.toThrow();
    expect(() => assertNativeAbiVersion(NATIVE_ABI_VERSION + 1)).toThrow(
      `Native ABI mismatch; expected ${NATIVE_ABI_VERSION}, got ${NATIVE_ABI_VERSION + 1}. Rebuild the library.`,
    );
  });
});
