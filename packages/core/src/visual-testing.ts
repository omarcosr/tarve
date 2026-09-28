import { inflateSync } from "node:zlib";

export interface RgbaImage {
  width: number;
  height: number;
  rgba: Uint8Array;
}

export interface PixelComparisonOptions {
  /** Per-channel delta ignored as noise. */
  threshold?: number;
}

export interface PixelComparison {
  width: number;
  height: number;
  differentPixels: number;
  totalPixels: number;
  differenceRatio: number;
  maxChannelDelta: number;
}

function validateRgbaImage(image: RgbaImage, label: string): void {
  if (!Number.isInteger(image.width) || !Number.isInteger(image.height)
    || image.width <= 0 || image.height <= 0) {
    throw new RangeError(`${label} image dimensions must be positive integers`);
  }
  const expected = image.width * image.height * 4;
  if (!Number.isSafeInteger(expected)) {
    throw new RangeError(`${label} image dimensions are too large`);
  }
  if (!(image.rgba instanceof Uint8Array) || image.rgba.byteLength !== expected) {
    throw new RangeError(`${label} RGBA buffer must contain exactly ${expected} bytes`);
  }
}

/** Decode Tarve's 8-bit RGBA PNG captures without an external image dependency. */
export async function readPngRgba(path: string): Promise<RgbaImage> {
  const bytes = new Uint8Array(await Bun.file(path).arrayBuffer());
  const signature = [137, 80, 78, 71, 13, 10, 26, 10];
  if (!signature.every((value, index) => bytes[index] === value)) throw new Error(`Not a PNG capture: ${path}`);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let offset = 8;
  let width = 0;
  let height = 0;
  const idat: Uint8Array[] = [];
  while (offset + 12 <= bytes.length) {
    const length = view.getUint32(offset);
    const end = offset + 12 + length;
    if (end > bytes.length) throw new Error(`Invalid PNG chunk length in ${path}`);
    const type = String.fromCharCode(...bytes.subarray(offset + 4, offset + 8));
    const data = bytes.subarray(offset + 8, offset + 8 + length);
    if (type === "IHDR") {
      const header = new DataView(data.buffer, data.byteOffset, data.byteLength);
      width = header.getUint32(0);
      height = header.getUint32(4);
      if (data[8] !== 8 || data[9] !== 6 || data[10] !== 0 || data[11] !== 0 || data[12] !== 0) {
        throw new Error("Visual regression helpers require non-interlaced 8-bit RGBA PNG captures");
      }
    } else if (type === "IDAT") idat.push(data.slice());
    else if (type === "IEND") break;
    offset = end;
  }
  if (width <= 0 || height <= 0 || idat.length === 0) throw new Error(`PNG capture is missing image data: ${path}`);
  const raw = inflateSync(Buffer.concat(idat.map(chunk => Buffer.from(chunk))));
  const stride = width * 4;
  if (raw.length !== height * (stride + 1)) throw new Error(`Unexpected PNG row size in ${path}`);
  const rgba = new Uint8Array(width * height * 4);
  const paeth = (a: number, b: number, c: number) => {
    const p = a + b - c;
    const pa = Math.abs(p - a);
    const pb = Math.abs(p - b);
    const pc = Math.abs(p - c);
    return pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
  };
  for (let y = 0; y < height; y++) {
    const filter = raw[y * (stride + 1)];
    if (filter === undefined || filter > 4) throw new Error(`Unsupported PNG filter ${String(filter)}`);
    const source = y * (stride + 1) + 1;
    const target = y * stride;
    for (let x = 0; x < stride; x++) {
      const encoded = raw[source + x]!;
      const left = x >= 4 ? rgba[target + x - 4]! : 0;
      const up = y > 0 ? rgba[target - stride + x]! : 0;
      const upLeft = y > 0 && x >= 4 ? rgba[target - stride + x - 4]! : 0;
      const predictor = filter === 0 ? 0
        : filter === 1 ? left
        : filter === 2 ? up
        : filter === 3 ? Math.floor((left + up) / 2)
        : paeth(left, up, upLeft);
      rgba[target + x] = (encoded + predictor) & 0xff;
    }
  }
  return { width, height, rgba };
}

export function compareRgbaImages(actual: RgbaImage, expected: RgbaImage, options: PixelComparisonOptions = {}): PixelComparison {
  validateRgbaImage(actual, "Actual");
  validateRgbaImage(expected, "Expected");
  if (actual.width !== expected.width || actual.height !== expected.height) {
    throw new Error(`Image dimensions differ: actual ${actual.width}x${actual.height}, expected ${expected.width}x${expected.height}`);
  }
  const threshold = options.threshold ?? 0;
  if (!Number.isInteger(threshold) || threshold < 0 || threshold > 255) throw new RangeError("Pixel threshold must be an integer from 0 to 255");
  let differentPixels = 0;
  let maxChannelDelta = 0;
  for (let pixel = 0; pixel < actual.width * actual.height; pixel++) {
    let different = false;
    const base = pixel * 4;
    for (let channel = 0; channel < 4; channel++) {
      const delta = Math.abs(actual.rgba[base + channel]! - expected.rgba[base + channel]!);
      maxChannelDelta = Math.max(maxChannelDelta, delta);
      if (delta > threshold) different = true;
    }
    if (different) differentPixels++;
  }
  const totalPixels = actual.width * actual.height;
  return {
    width: actual.width,
    height: actual.height,
    differentPixels,
    totalPixels,
    differenceRatio: totalPixels === 0 ? 0 : differentPixels / totalPixels,
    maxChannelDelta,
  };
}

export async function comparePngCaptures(actualPath: string, expectedPath: string, options?: PixelComparisonOptions): Promise<PixelComparison> {
  const [actual, expected] = await Promise.all([readPngRgba(actualPath), readPngRgba(expectedPath)]);
  return compareRgbaImages(actual, expected, options);
}

export async function assertPngMatches(
  actualPath: string,
  expectedPath: string,
  options: PixelComparisonOptions & { maxDifferenceRatio?: number } = {},
): Promise<PixelComparison> {
  const comparison = await comparePngCaptures(actualPath, expectedPath, options);
  const limit = options.maxDifferenceRatio ?? 0;
  if (!Number.isFinite(limit) || limit < 0 || limit > 1) throw new RangeError("maxDifferenceRatio must be between 0 and 1");
  if (comparison.differenceRatio > limit) {
    throw new Error(
      `Visual regression mismatch: ${comparison.differentPixels}/${comparison.totalPixels} pixels `
      + `(${(comparison.differenceRatio * 100).toFixed(3)}%) differ; limit ${(limit * 100).toFixed(3)}%`,
    );
  }
  return comparison;
}
