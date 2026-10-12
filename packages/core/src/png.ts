import { deflateSync, inflateSync } from "node:zlib";

export interface DecodedPng {
  width: number;
  height: number;
  /** Straight (not premultiplied) RGBA8. */
  rgba: Uint8Array;
}

const SIGNATURE = [137, 80, 78, 71, 13, 10, 26, 10];

export function isPng(bytes: Uint8Array): boolean {
  return SIGNATURE.every((value, index) => bytes[index] === value);
}

/** Width and height from a PNG's IHDR, without decoding it. */
export function pngSize(bytes: Uint8Array): { width: number; height: number } | undefined {
  if (!isPng(bytes) || bytes.length < 24) return undefined;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  return { width: view.getUint32(16), height: view.getUint32(20) };
}

/**
 * Decodes a non-interlaced PNG of any colour type at bit depth 8 or 16 (and
 * 1/2/4-bit palette or grey), the forms image editors and icon exporters write.
 */
export function decodePng(bytes: Uint8Array): DecodedPng {
  if (!isPng(bytes)) throw new Error("not a PNG file");
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let offset = 8;
  let width = 0, height = 0, depth = 0, colour = 0, interlace = 0;
  let palette: Uint8Array | undefined;
  let transparency: Uint8Array | undefined;
  const idat: Uint8Array[] = [];
  while (offset + 12 <= bytes.length) {
    const length = view.getUint32(offset);
    const type = String.fromCharCode(...bytes.subarray(offset + 4, offset + 8));
    const data = bytes.subarray(offset + 8, offset + 8 + length);
    if (offset + 12 + length > bytes.length) throw new Error("PNG chunk runs past the end of the file");
    if (type === "IHDR") {
      width = view.getUint32(offset + 8);
      height = view.getUint32(offset + 12);
      depth = data[8]!;
      colour = data[9]!;
      interlace = data[12]!;
    } else if (type === "PLTE") palette = data;
    else if (type === "tRNS") transparency = data;
    else if (type === "IDAT") idat.push(data);
    else if (type === "IEND") break;
    offset += 12 + length;
  }
  if (width <= 0 || height <= 0 || idat.length === 0) throw new Error("PNG has no image data");
  if (width * height > 16_384 * 16_384) throw new Error("PNG is too large");
  if (interlace !== 0) throw new Error("interlaced PNGs are not supported; save it without interlacing");
  const channels = ({ 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 } as Record<number, number>)[colour];
  if (channels === undefined || ![1, 2, 4, 8, 16].includes(depth) || (depth < 8 && colour !== 0 && colour !== 3) || (depth === 16 && colour === 3)) {
    throw new Error(`unsupported PNG format (colour type ${colour}, bit depth ${depth})`);
  }
  const bitsPerPixel = channels * depth;
  const bytesPerPixel = Math.max(1, bitsPerPixel >> 3);
  const stride = Math.ceil(width * bitsPerPixel / 8);
  const raw = inflateSync(Buffer.concat(idat.map(chunk => Buffer.from(chunk))));
  if (raw.length < height * (stride + 1)) throw new Error("PNG image data is truncated");
  const lines = new Uint8Array(height * stride);
  for (let y = 0; y < height; y++) {
    const filter = raw[y * (stride + 1)]!;
    const source = y * (stride + 1) + 1;
    const target = y * stride;
    for (let x = 0; x < stride; x++) {
      const encoded = raw[source + x]!;
      const left = x >= bytesPerPixel ? lines[target + x - bytesPerPixel]! : 0;
      const up = y > 0 ? lines[target - stride + x]! : 0;
      const upLeft = y > 0 && x >= bytesPerPixel ? lines[target - stride + x - bytesPerPixel]! : 0;
      let predictor = 0;
      if (filter === 1) predictor = left;
      else if (filter === 2) predictor = up;
      else if (filter === 3) predictor = (left + up) >> 1;
      else if (filter === 4) {
        const p = left + up - upLeft;
        const pa = Math.abs(p - left), pb = Math.abs(p - up), pc = Math.abs(p - upLeft);
        predictor = pa <= pb && pa <= pc ? left : pb <= pc ? up : upLeft;
      } else if (filter !== 0) throw new Error(`unsupported PNG filter ${filter}`);
      lines[target + x] = (encoded + predictor) & 0xff;
    }
  }
  const sample = (y: number, index: number): number => {
    const row = y * stride;
    if (depth === 8) return lines[row + index]!;
    if (depth === 16) return lines[row + index * 2]!;
    const bit = index * depth;
    return (lines[row + (bit >> 3)]! >> (8 - depth - (bit & 7))) & ((1 << depth) - 1);
  };
  const scale = depth < 8 && colour === 0 ? 255 / ((1 << depth) - 1) : 1;
  const rgba = new Uint8Array(width * height * 4);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const out = (y * width + x) * 4;
      const base = x * channels;
      if (colour === 3) {
        const index = sample(y, base);
        rgba[out] = palette?.[index * 3] ?? 0;
        rgba[out + 1] = palette?.[index * 3 + 1] ?? 0;
        rgba[out + 2] = palette?.[index * 3 + 2] ?? 0;
        rgba[out + 3] = transparency?.[index] ?? 255;
      } else if (colour === 0 || colour === 4) {
        const grey = Math.round(sample(y, base) * scale);
        rgba[out] = rgba[out + 1] = rgba[out + 2] = grey;
        rgba[out + 3] = colour === 4 ? sample(y, base + 1) : 255;
      } else {
        rgba[out] = sample(y, base);
        rgba[out + 1] = sample(y, base + 1);
        rgba[out + 2] = sample(y, base + 2);
        rgba[out + 3] = colour === 6 ? sample(y, base + 3) : 255;
      }
    }
  }
  return { width, height, rgba };
}

const CRC_TABLE = new Uint32Array(256).map((_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});

function crc32(bytes: Uint8Array): number {
  let crc = 0xffffffff;
  for (const byte of bytes) crc = CRC_TABLE[(crc ^ byte) & 0xff]! ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

function chunk(type: string, data: Uint8Array): Buffer {
  const out = Buffer.alloc(12 + data.length);
  out.writeUInt32BE(data.length, 0);
  out.write(type, 4, "ascii");
  out.set(data, 8);
  out.writeUInt32BE(crc32(out.subarray(4, 8 + data.length)), 8 + data.length);
  return out;
}

/** Encodes straight RGBA8 pixels as an 8-bit RGBA PNG. */
export function encodePng(rgba: Uint8Array, width: number, height: number): Uint8Array {
  const stride = width * 4;
  const raw = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y++) raw.set(rgba.subarray(y * stride, (y + 1) * stride), y * (stride + 1) + 1);
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8;
  header[9] = 6;
  return new Uint8Array(Buffer.concat([
    Buffer.from(SIGNATURE),
    chunk("IHDR", header),
    chunk("IDAT", deflateSync(raw, { level: 9 })),
    chunk("IEND", new Uint8Array()),
  ]));
}

/** Area-averaged downscale (premultiplied, so transparent edges keep their colour) to a size x size square. */
export function resizeSquare(image: DecodedPng, size: number): Uint8Array {
  const side = Math.max(image.width, image.height);
  const offsetX = (side - image.width) / 2, offsetY = (side - image.height) / 2;
  const out = new Uint8Array(size * size * 4);
  const ratio = side / size;
  for (let y = 0; y < size; y++) {
    const y0 = y * ratio - offsetY, y1 = (y + 1) * ratio - offsetY;
    for (let x = 0; x < size; x++) {
      const x0 = x * ratio - offsetX, x1 = (x + 1) * ratio - offsetX;
      let r = 0, g = 0, b = 0, a = 0;
      for (let sy = Math.max(0, Math.floor(y0)); sy < Math.min(image.height, Math.ceil(y1)); sy++) {
        const wy = Math.min(y1, sy + 1) - Math.max(y0, sy);
        for (let sx = Math.max(0, Math.floor(x0)); sx < Math.min(image.width, Math.ceil(x1)); sx++) {
          const w = wy * (Math.min(x1, sx + 1) - Math.max(x0, sx));
          const i = (sy * image.width + sx) * 4;
          const alpha = image.rgba[i + 3]! * w;
          r += image.rgba[i]! * alpha; g += image.rgba[i + 1]! * alpha; b += image.rgba[i + 2]! * alpha; a += alpha;
        }
      }
      const area = ratio * ratio;
      const o = (y * size + x) * 4;
      if (a > 0) { out[o] = Math.round(r / a); out[o + 1] = Math.round(g / a); out[o + 2] = Math.round(b / a); }
      out[o + 3] = Math.round(a / area);
    }
  }
  return out;
}

/** An .ico whose entries are PNG images (Windows Vista and later), each square and at most 256 px. */
export function encodeIco(entries: readonly { size: number; png: Uint8Array }[]): Uint8Array {
  const header = Buffer.alloc(6 + entries.length * 16);
  header.writeUInt16LE(0, 0);
  header.writeUInt16LE(1, 2);
  header.writeUInt16LE(entries.length, 4);
  let offset = header.length;
  entries.forEach(({ size, png }, index) => {
    const at = 6 + index * 16;
    header[at] = size >= 256 ? 0 : size;
    header[at + 1] = size >= 256 ? 0 : size;
    header.writeUInt16LE(1, at + 4);
    header.writeUInt16LE(32, at + 6);
    header.writeUInt32LE(png.length, at + 8);
    header.writeUInt32LE(offset, at + 12);
    offset += png.length;
  });
  return new Uint8Array(Buffer.concat([header, ...entries.map(entry => Buffer.from(entry.png))]));
}

export function isIco(bytes: Uint8Array): boolean {
  return bytes.length >= 6 && bytes[0] === 0 && bytes[1] === 0 && bytes[2] === 1 && bytes[3] === 0;
}

/** The largest PNG-compressed entry of an .ico, if it has one. */
export function largestIcoPng(bytes: Uint8Array): Uint8Array | undefined {
  if (!isIco(bytes)) return undefined;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let best: Uint8Array | undefined;
  let bestSize = 0;
  for (let index = 0; index < view.getUint16(4, true); index++) {
    const at = 6 + index * 16;
    if (at + 16 > bytes.length) break;
    const size = bytes[at] || 256;
    const length = view.getUint32(at + 8, true), start = view.getUint32(at + 12, true);
    const data = bytes.subarray(start, start + length);
    if (isPng(data) && size > bestSize) { best = data; bestSize = size; }
  }
  return best;
}
