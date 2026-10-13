import { describe, expect, test } from "bun:test";
import { decodePng, encodeIco, encodePng, isIco, isPng, largestIcoPng, pngSize, resizeSquare } from "./png";

function solid(width: number, height: number, [r, g, b, a]: [number, number, number, number]): Uint8Array {
  const rgba = new Uint8Array(width * height * 4);
  for (let i = 0; i < width * height; i++) rgba.set([r, g, b, a], i * 4);
  return rgba;
}

describe("png", () => {
  test("encodePng and decodePng round-trip RGBA pixels", () => {
    const rgba = new Uint8Array([255, 0, 0, 255, 0, 255, 0, 128, 0, 0, 255, 0, 10, 20, 30, 40]);
    const png = encodePng(rgba, 2, 2);
    expect(isPng(png)).toBe(true);
    expect(pngSize(png)).toEqual({ width: 2, height: 2 });
    const decoded = decodePng(png);
    expect(decoded.width).toBe(2);
    expect(decoded.height).toBe(2);
    expect([...decoded.rgba]).toEqual([...rgba]);
  });

  test("rejects bytes that are not a PNG", () => {
    expect(isPng(new Uint8Array([1, 2, 3]))).toBe(false);
    expect(pngSize(new Uint8Array([1, 2, 3]))).toBeUndefined();
    expect(() => decodePng(new Uint8Array([1, 2, 3]))).toThrow("not a PNG file");
  });

  test("resizeSquare averages pixels and pads a non-square image with transparency", () => {
    // 4x2 image: left half red, right half blue → 2x2 square with transparent top/bottom bands.
    const rgba = new Uint8Array(4 * 2 * 4);
    for (let i = 0; i < 8; i++) rgba.set(i % 4 < 2 ? [255, 0, 0, 255] : [0, 0, 255, 255], i * 4);
    const out = resizeSquare({ width: 4, height: 2, rgba }, 2);
    expect(out).toHaveLength(2 * 2 * 4);
    // Each output pixel covers a 2x2 source block, half of which is the transparent band.
    expect([...out.subarray(0, 4)]).toEqual([255, 0, 0, 128]);
    expect([...out.subarray(4, 8)]).toEqual([0, 0, 255, 128]);
  });

  test("resizeSquare of a solid square keeps its colour", () => {
    const out = resizeSquare({ width: 8, height: 8, rgba: solid(8, 8, [10, 20, 30, 255]) }, 4);
    expect([...out.subarray(0, 4)]).toEqual([10, 20, 30, 255]);
    expect([...out.subarray(60, 64)]).toEqual([10, 20, 30, 255]);
  });

  test("encodeIco packs PNG entries and largestIcoPng finds the biggest", () => {
    const small = encodePng(solid(16, 16, [0, 0, 0, 255]), 16, 16);
    const big = encodePng(solid(256, 256, [0, 0, 0, 255]), 256, 256);
    const ico = encodeIco([{ size: 16, png: small }, { size: 256, png: big }]);
    expect(isIco(ico)).toBe(true);
    expect(isPng(ico)).toBe(false);
    const largest = largestIcoPng(ico);
    expect(largest && pngSize(largest)).toEqual({ width: 256, height: 256 });
    expect(largestIcoPng(small)).toBeUndefined();
  });
});
