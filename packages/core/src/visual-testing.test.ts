import { describe, expect, test } from "bun:test";
import { compareRgbaImages } from "./visual-testing";

describe("visual regression helpers", () => {
  test("rejects malformed RGBA buffers instead of treating missing channels as equal", () => {
    const valid = {
      width: 1,
      height: 1,
      rgba: Uint8Array.of(10, 20, 30, 255),
    };
    expect(() => compareRgbaImages(
      { width: 1, height: 1, rgba: Uint8Array.of(10, 20, 30) },
      valid,
    )).toThrow("exactly 4 bytes");
  });

  test("reports thresholded pixel differences", () => {
    const actual = {
      width: 1,
      height: 1,
      rgba: Uint8Array.of(10, 20, 30, 255),
    };
    const expected = {
      width: 1,
      height: 1,
      rgba: Uint8Array.of(12, 20, 30, 255),
    };
    expect(compareRgbaImages(actual, expected, { threshold: 2 })).toMatchObject({
      differentPixels: 0,
      maxChannelDelta: 2,
    });
    expect(compareRgbaImages(actual, expected, { threshold: 1 })).toMatchObject({
      differentPixels: 1,
      maxChannelDelta: 2,
    });
  });
});
