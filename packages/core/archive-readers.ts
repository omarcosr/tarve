// Independent readers for the archives `tarve package` writes (ar, ustar, zip), so the unit
// tests and the Node.js CLI smoke check the produced bytes the same way. They validate the
// structure (magic, checksums, CRC-32) with node:assert, so they run under Bun and Node.js alike.
import { strict as assert } from "node:assert";
import { inflateRawSync } from "node:zlib";
import { crc32 } from "./archive-formats";

const decoder = new TextDecoder();

export interface ArMember { name: string; mode: string; data: Uint8Array }
export interface TarEntry { path: string; type: string; mode: number; data: Uint8Array; link: string; uname: string }
export interface ZipEntry { path: string; data: Uint8Array; mode: number }

/** The members of a System V / GNU ar archive (a .deb). */
export function readAr(bytes: Uint8Array): ArMember[] {
  assert.equal(decoder.decode(bytes.subarray(0, 8)), "!<arch>\n", "ar magic");
  const members: ArMember[] = [];
  let offset = 8;
  while (offset < bytes.length) {
    const header = decoder.decode(bytes.subarray(offset, offset + 60));
    assert.equal(header.slice(58, 60), "`\n", `ar header terminator at ${offset}`);
    const size = Number(header.slice(48, 58).trim());
    members.push({ name: header.slice(0, 16).trim(), mode: header.slice(40, 48).trim(), data: bytes.subarray(offset + 60, offset + 60 + size) });
    offset += 60 + size + (size % 2);
  }
  return members;
}

/** The entries of an uncompressed ustar archive; every header checksum is verified. */
export function readTar(bytes: Uint8Array): TarEntry[] {
  const text = (start: number, length: number) => decoder.decode(bytes.subarray(start, start + length)).replace(/\0.*$/s, "");
  const entries: TarEntry[] = [];
  let offset = 0;
  while (offset + 512 <= bytes.length && bytes.subarray(offset, offset + 512).some(byte => byte !== 0)) {
    let sum = 0;
    for (let index = 0; index < 512; index++) sum += index >= 148 && index < 156 ? 0x20 : bytes[offset + index]!;
    assert.equal(Number.parseInt(text(offset + 148, 8).trim(), 8), sum, `tar header checksum at ${offset}`);
    assert.equal(text(offset + 257, 6), "ustar", `tar magic at ${offset}`);
    const size = Number.parseInt(text(offset + 124, 12), 8);
    const prefix = text(offset + 345, 155);
    entries.push({
      path: (prefix ? prefix + "/" : "") + text(offset, 100), type: String.fromCharCode(bytes[offset + 156]!),
      mode: Number.parseInt(text(offset + 100, 8), 8), data: bytes.subarray(offset + 512, offset + 512 + size),
      link: text(offset + 157, 100), uname: text(offset + 265, 32),
    });
    offset += 512 + Math.ceil(size / 512) * 512;
  }
  return entries;
}

/** The entries of a zip (central directory order), inflated; every CRC-32 is verified. */
export function readZip(bytes: Uint8Array): ZipEntry[] {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const end = bytes.length - 22;
  assert.equal(view.getUint32(end, true), 0x06054b50, "zip end of central directory");
  const count = view.getUint16(end + 10, true);
  let offset = view.getUint32(end + 16, true);
  const entries: ZipEntry[] = [];
  for (let index = 0; index < count; index++) {
    assert.equal(view.getUint32(offset, true), 0x02014b50, `zip central header at ${offset}`);
    const method = view.getUint16(offset + 10, true), crc = view.getUint32(offset + 16, true);
    const compressed = view.getUint32(offset + 20, true), nameLength = view.getUint16(offset + 28, true);
    const extra = view.getUint16(offset + 30, true), comment = view.getUint16(offset + 32, true);
    const mode = view.getUint32(offset + 38, true) >>> 16, local = view.getUint32(offset + 42, true);
    const path = decoder.decode(bytes.subarray(offset + 46, offset + 46 + nameLength));
    assert.equal(view.getUint32(local, true), 0x04034b50, `zip local header for ${path}`);
    const start = local + 30 + view.getUint16(local + 26, true) + view.getUint16(local + 28, true);
    const body = bytes.subarray(start, start + compressed);
    const data = method === 8 ? new Uint8Array(inflateRawSync(body)) : body;
    assert.equal(crc32(data), crc, `zip CRC-32 of ${path}`);
    entries.push({ path, data, mode });
    offset += 46 + nameLength + extra + comment;
  }
  return entries;
}
