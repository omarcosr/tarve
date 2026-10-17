// A minimal PNG reader for the video smokes (8-bit RGB or RGBA, non-interlaced).
import { readFileSync } from "node:fs";
import { inflateSync } from "node:zlib";

/** RGBA pixels of a PNG the native capture wrote (8-bit RGB or RGBA, non-interlaced). */
export function readPng(path: string): { width: number; height: number; pixel(x: number, y: number): [number, number, number] } {
  const data = readFileSync(path);
  let offset = 8, width = 0, height = 0, channels = 4;
  const chunks: Buffer[] = [];
  while (offset < data.length) {
    const length = data.readUInt32BE(offset), type = data.toString("ascii", offset + 4, offset + 8);
    const body = data.subarray(offset + 8, offset + 8 + length);
    if (type === "IHDR") { width = body.readUInt32BE(0); height = body.readUInt32BE(4); channels = body[9] === 2 ? 3 : 4; }
    if (type === "IDAT") chunks.push(body);
    offset += 12 + length;
  }
  const raw = inflateSync(Buffer.concat(chunks));
  const stride = width * channels, out = Buffer.alloc(height * stride);
  for (let y = 0; y < height; y++) {
    const filter = raw[y * (stride + 1)]!, row = raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1));
    for (let x = 0; x < stride; x++) {
      const a = x >= channels ? out[y * stride + x - channels]! : 0, b = y > 0 ? out[(y - 1) * stride + x]! : 0, c = x >= channels && y > 0 ? out[(y - 1) * stride + x - channels]! : 0;
      const p = a + b - c, pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
      const predicted = filter === 1 ? a : filter === 2 ? b : filter === 3 ? (a + b) >> 1 : filter === 4 ? (pa <= pb && pa <= pc ? a : pb <= pc ? b : c) : 0;
      out[y * stride + x] = (row[x]! + predicted) & 255;
    }
  }
  return { width, height, pixel: (x, y) => [out[y * stride + x * channels]!, out[y * stride + x * channels + 1]!, out[y * stride + x * channels + 2]!] };
}
