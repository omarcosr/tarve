import { deflateRawSync } from "node:zlib";

// ZIP: aapt2 writes the manifest and resources; assets and libraries are added here, so that
// shared libraries are stored uncompressed at page boundaries (loaded in place, never extracted).
export interface ZipEntry { name: string; method: 0 | 8; crc: number; size: number; data: Uint8Array }

export const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let index = 0; index < 256; index++) {
    let value = index;
    for (let bit = 0; bit < 8; bit++) value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
    table[index] = value >>> 0;
  }
  return table;
})();

export function crc32(bytes: Uint8Array): number {
  let crc = 0xffffffff;
  for (const byte of bytes) crc = CRC_TABLE[(crc ^ byte) & 0xff]! ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

export function readZip(zip: Uint8Array): ZipEntry[] {
  const view = new DataView(zip.buffer, zip.byteOffset, zip.byteLength);
  let end = zip.length - 22;
  while (end >= 0 && view.getUint32(end, true) !== 0x06054b50) end--;
  if (end < 0) throw new Error("Not a ZIP archive");
  const count = view.getUint16(end + 10, true);
  let offset = view.getUint32(end + 16, true);
  const entries: ZipEntry[] = [];
  const decoder = new TextDecoder();
  for (let index = 0; index < count; index++) {
    if (view.getUint32(offset, true) !== 0x02014b50) throw new Error("Corrupt ZIP central directory");
    const method = view.getUint16(offset + 10, true);
    const crc = view.getUint32(offset + 16, true);
    const compressed = view.getUint32(offset + 20, true);
    const size = view.getUint32(offset + 24, true);
    const nameLength = view.getUint16(offset + 28, true);
    const extraLength = view.getUint16(offset + 30, true);
    const commentLength = view.getUint16(offset + 32, true);
    const local = view.getUint32(offset + 42, true);
    const name = decoder.decode(zip.subarray(offset + 46, offset + 46 + nameLength));
    if (method !== 0 && method !== 8) throw new Error(`Unsupported ZIP method ${method} for ${name}`);
    const start = local + 30 + view.getUint16(local + 26, true) + view.getUint16(local + 28, true);
    entries.push({ name, method: method as 0 | 8, crc, size, data: zip.subarray(start, start + compressed) });
    offset += 46 + nameLength + extraLength + commentLength;
  }
  return entries;
}

export function zipEntry(name: string, data: Uint8Array, compress: boolean): ZipEntry {
  const deflated = compress ? new Uint8Array(deflateRawSync(data, { level: 9 })) : undefined;
  return deflated && deflated.length < data.length
    ? { name, method: 8, crc: crc32(data), size: data.length, data: deflated }
    : { name, method: 0, crc: crc32(data), size: data.length, data };
}

/** Stored entries start at a multiple of `alignment(name)`, padded with a zipalign extra field (0xd935). */
export function writeZip(entries: readonly ZipEntry[], alignment: (name: string) => number): Uint8Array {
  const encoder = new TextEncoder();
  const parts: Uint8Array[] = [];
  const central: Uint8Array[] = [];
  let offset = 0;
  // 1980-01-01 00:00, as reproducible builds use.
  const time = 0;
  const date = (0 << 9) | (1 << 5) | 1;
  for (const entry of entries) {
    const name = encoder.encode(entry.name);
    const align = entry.method === 0 ? alignment(entry.name) : 1;
    let extra = new Uint8Array(0);
    if (align > 1) {
      const base = offset + 30 + name.length + 6;
      const padding = (align - (base % align)) % align;
      extra = new Uint8Array(6 + padding);
      const extraView = new DataView(extra.buffer);
      extraView.setUint16(0, 0xd935, true);
      extraView.setUint16(2, 2 + padding, true);
      extraView.setUint16(4, align > 0xffff ? 0xffff : align, true);
    }
    const header = new Uint8Array(30);
    const headerView = new DataView(header.buffer);
    headerView.setUint32(0, 0x04034b50, true);
    headerView.setUint16(4, entry.method === 8 ? 20 : 10, true);
    headerView.setUint16(6, 0x0800, true);
    headerView.setUint16(8, entry.method, true);
    headerView.setUint16(10, time, true);
    headerView.setUint16(12, date, true);
    headerView.setUint32(14, entry.crc, true);
    headerView.setUint32(18, entry.data.length, true);
    headerView.setUint32(22, entry.size, true);
    headerView.setUint16(26, name.length, true);
    headerView.setUint16(28, extra.length, true);
    const record = new Uint8Array(46 + name.length);
    const recordView = new DataView(record.buffer);
    recordView.setUint32(0, 0x02014b50, true);
    recordView.setUint16(4, 20, true);
    recordView.setUint16(6, entry.method === 8 ? 20 : 10, true);
    recordView.setUint16(8, 0x0800, true);
    recordView.setUint16(10, entry.method, true);
    recordView.setUint16(12, time, true);
    recordView.setUint16(14, date, true);
    recordView.setUint32(16, entry.crc, true);
    recordView.setUint32(20, entry.data.length, true);
    recordView.setUint32(24, entry.size, true);
    recordView.setUint16(28, name.length, true);
    recordView.setUint32(42, offset, true);
    record.set(name, 46);
    central.push(record);
    parts.push(header, name, extra, entry.data);
    offset += header.length + name.length + extra.length + entry.data.length;
  }
  const centralSize = central.reduce((size, record) => size + record.length, 0);
  const end = new Uint8Array(22);
  const endView = new DataView(end.buffer);
  endView.setUint32(0, 0x06054b50, true);
  endView.setUint16(8, entries.length, true);
  endView.setUint16(10, entries.length, true);
  endView.setUint32(12, centralSize, true);
  endView.setUint32(16, offset, true);
  const out = new Uint8Array(offset + centralSize + end.length);
  let position = 0;
  for (const part of [...parts, ...central, end]) {
    out.set(part, position);
    position += part.length;
  }
  return out;
}
