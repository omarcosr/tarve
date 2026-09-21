import { deflateSync } from "node:zlib";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";

// Small deterministic local PNG: no network asset dependency for the example.
export async function makeAsset(root: string): Promise<void> {
  const width = 800, height = 360;
  const bytes = Buffer.alloc((width * 4 + 1) * height);
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    const offset = y * (width * 4 + 1) + 1 + x * 4;
    let rgb = [234, 231, 223];
    if ((x - 615) ** 2 + (y - 112) ** 2 < 46 ** 2) rgb = [167, 150, 124];
    if (y > 210 - 62 * Math.sin(x / 230)) rgb = [195, 191, 179];
    if (y > 265 - 65 * Math.cos((x - 280) / 230)) rgb = [139, 143, 126];
    if (y > 322 - 42 * Math.sin(x / 185)) rgb = [65, 78, 66];
    bytes.set([...rgb, 255], offset);
  }
  function crc32(buffer: Buffer): number {
    let crc = 0xffffffff;
    for (const b of buffer) { crc ^= b; for (let k = 0; k < 8; k++) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0); }
    return (crc ^ 0xffffffff) >>> 0;
  }
  function chunk(type: string, data: Buffer): Buffer {
    const payload = Buffer.concat([Buffer.from(type), data]);
    const header = Buffer.alloc(4); header.writeUInt32BE(data.length);
    const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(payload));
    return Buffer.concat([header, payload, crc]);
  }
  const header = Buffer.alloc(13); header.writeUInt32BE(width); header.writeUInt32BE(height, 4); header[8] = 8; header[9] = 6;
  const png = Buffer.concat([Buffer.from([137,80,78,71,13,10,26,10]), chunk("IHDR", header), chunk("IDAT", deflateSync(bytes)), chunk("IEND", Buffer.alloc(0))]);
  await mkdir(join(root, "examples/assets"), { recursive: true });
  await Bun.write(join(root, "examples/assets/studio.png"), png);
}
