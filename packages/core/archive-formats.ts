// Pure TypeScript archive writers for `tarve package`: ar (Debian packages), ustar
// tar (+ gzip) and zip. No external tools; Node.js and Bun alike (node:zlib only).
import { deflateRawSync, gzipSync } from "node:zlib";

export interface ArchiveEntry {
  /** Forward-slash path inside the archive. Directories may end with "/". */
  path: string;
  type?: "file" | "directory" | "symlink";
  data?: Uint8Array;
  /** Unix permission bits; defaults to 0o644 for files and 0o755 for directories. */
  mode?: number;
  /** Symlink target. */
  target?: string;
}

const encoder = new TextEncoder();

/** Seconds since the epoch: SOURCE_DATE_EPOCH (reproducible builds) or now. */
export function archiveTime(mtime?: number): number {
  if (mtime !== undefined) return Math.floor(mtime);
  const epoch = Number(process.env.SOURCE_DATE_EPOCH);
  return Number.isFinite(epoch) && epoch > 0 ? Math.floor(epoch) : Math.floor(Date.now() / 1000);
}

function concat(parts: readonly Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((total, part) => total + part.length, 0));
  let offset = 0;
  for (const part of parts) { out.set(part, offset); offset += part.length; }
  return out;
}

function entryType(entry: ArchiveEntry): "file" | "directory" | "symlink" {
  return entry.type ?? (entry.path.endsWith("/") ? "directory" : "file");
}

function entryMode(entry: ArchiveEntry): number {
  return entry.mode ?? (entryType(entry) === "directory" ? 0o755 : 0o644);
}

// ---- ar -------------------------------------------------------------------

/** A System V / GNU `ar` archive, as `dpkg-deb` writes `.deb` files. Member names up to 16 bytes. */
export function createAr(members: readonly { name: string; data: Uint8Array }[], mtime?: number): Uint8Array {
  const time = archiveTime(mtime);
  const parts: Uint8Array[] = [encoder.encode("!<arch>\n")];
  for (const member of members) {
    if (member.name.length > 16 || /[\s/]/.test(member.name)) throw new Error(`ar member name must be at most 16 characters without spaces: ${member.name}`);
    const header = member.name.padEnd(16) + String(time).padEnd(12) + "0".padEnd(6) + "0".padEnd(6)
      + "100644".padEnd(8) + String(member.data.length).padEnd(10) + "`\n";
    parts.push(encoder.encode(header), member.data);
    if (member.data.length % 2) parts.push(encoder.encode("\n"));
  }
  return concat(parts);
}

// ---- tar ------------------------------------------------------------------

function writeString(block: Uint8Array, offset: number, length: number, value: string): void {
  const bytes = encoder.encode(value);
  if (bytes.length > length) throw new Error(`tar field too long: ${value}`);
  block.set(bytes, offset);
}

function writeOctal(block: Uint8Array, offset: number, length: number, value: number): void {
  const text = value.toString(8);
  if (text.length > length - 1) throw new Error(`tar numeric field overflow: ${value}`);
  writeString(block, offset, length, text.padStart(length - 1, "0") + "\0");
}

/** Splits a long path into ustar `prefix` (155 bytes) and `name` (100 bytes). */
function splitTarPath(path: string): [prefix: string, name: string] {
  if (encoder.encode(path).length <= 100) return ["", path];
  for (let index = path.indexOf("/"); index >= 0; index = path.indexOf("/", index + 1)) {
    const prefix = path.slice(0, index), name = path.slice(index + 1);
    if (encoder.encode(prefix).length <= 155 && encoder.encode(name).length <= 100 && name) return [prefix, name];
  }
  throw new Error(`Path too long for a ustar archive: ${path}`);
}

function tarHeader(entry: ArchiveEntry, time: number): Uint8Array {
  const type = entryType(entry);
  const path = type === "directory" && !entry.path.endsWith("/") ? entry.path + "/" : entry.path;
  const [prefix, name] = splitTarPath(path);
  const block = new Uint8Array(512);
  writeString(block, 0, 100, name);
  writeOctal(block, 100, 8, entryMode(entry));
  writeOctal(block, 108, 8, 0);
  writeOctal(block, 116, 8, 0);
  writeOctal(block, 124, 12, type === "file" ? entry.data?.length ?? 0 : 0);
  writeOctal(block, 136, 12, time);
  block.fill(0x20, 148, 156);
  block[156] = (type === "directory" ? "5" : type === "symlink" ? "2" : "0").charCodeAt(0);
  if (type === "symlink") {
    if (!entry.target) throw new Error(`Symlink ${entry.path} needs a target`);
    writeString(block, 157, 100, entry.target);
  }
  writeString(block, 257, 6, "ustar\0");
  writeString(block, 263, 2, "00");
  writeString(block, 265, 32, "root");
  writeString(block, 297, 32, "root");
  writeString(block, 345, 155, prefix);
  let sum = 0;
  for (const byte of block) sum += byte;
  writeString(block, 148, 8, sum.toString(8).padStart(6, "0") + "\0 ");
  return block;
}

/** An uncompressed POSIX ustar archive (owner root:root, deterministic times). */
export function createTar(entries: readonly ArchiveEntry[], mtime?: number): Uint8Array {
  const time = archiveTime(mtime);
  const parts: Uint8Array[] = [];
  for (const entry of entries) {
    parts.push(tarHeader(entry, time));
    if (entryType(entry) !== "file" || !entry.data?.length) continue;
    parts.push(entry.data);
    const pad = (512 - (entry.data.length % 512)) % 512;
    if (pad) parts.push(new Uint8Array(pad));
  }
  parts.push(new Uint8Array(1024));
  return concat(parts);
}

/** `createTar` compressed with gzip (`.tar.gz`). */
export function createTarGz(entries: readonly ArchiveEntry[], mtime?: number): Uint8Array {
  return new Uint8Array(gzipSync(createTar(entries, mtime), { level: 9 }));
}

// ---- zip ------------------------------------------------------------------

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

export function crc32(data: Uint8Array): number {
  let crc = 0xffffffff;
  for (let index = 0; index < data.length; index++) crc = CRC_TABLE[(crc ^ data[index]!) & 0xff]! ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

function dosDateTime(seconds: number): [time: number, date: number] {
  const date = new Date(Math.max(seconds, 315532800) * 1000); // zip dates start in 1980
  return [
    (date.getUTCHours() << 11) | (date.getUTCMinutes() << 5) | Math.floor(date.getUTCSeconds() / 2),
    ((date.getUTCFullYear() - 1980) << 9) | ((date.getUTCMonth() + 1) << 5) | date.getUTCDate(),
  ];
}

/**
 * A zip archive (deflate, UTF-8 names, Unix permissions in the external attributes so
 * executables stay executable when unzipped on Linux). Entries and the archive must stay under 4 GB.
 */
export function createZip(entries: readonly ArchiveEntry[], mtime?: number): Uint8Array {
  const [time, date] = dosDateTime(archiveTime(mtime));
  const locals: Uint8Array[] = [];
  const central: Uint8Array[] = [];
  let offset = 0;
  for (const entry of entries) {
    const type = entryType(entry);
    if (type === "symlink") throw new Error(`zip archives here do not hold symlinks: ${entry.path}`);
    const path = type === "directory" && !entry.path.endsWith("/") ? entry.path + "/" : entry.path;
    const name = encoder.encode(path);
    const raw = type === "file" ? entry.data ?? new Uint8Array() : new Uint8Array();
    const deflated = raw.length ? new Uint8Array(deflateRawSync(raw, { level: 9 })) : raw;
    const store = deflated.length >= raw.length;
    const body = store ? raw : deflated;
    if (raw.length > 0xfffffffe || offset > 0xfffffffe) throw new Error("zip archive over 4 GB (zip64 is not supported)");
    const crc = crc32(raw);
    const method = store ? 0 : 8;
    const local = new DataView(new ArrayBuffer(30));
    local.setUint32(0, 0x04034b50, true);
    local.setUint16(4, 20, true);
    local.setUint16(6, 0x0800, true);
    local.setUint16(8, method, true);
    local.setUint16(10, time, true);
    local.setUint16(12, date, true);
    local.setUint32(14, crc, true);
    local.setUint32(18, body.length, true);
    local.setUint32(22, raw.length, true);
    local.setUint16(26, name.length, true);
    local.setUint16(28, 0, true);
    const header = new DataView(new ArrayBuffer(46));
    header.setUint32(0, 0x02014b50, true);
    header.setUint16(4, (3 << 8) | 20, true); // made by Unix, zip 2.0
    header.setUint16(6, 20, true);
    header.setUint16(8, 0x0800, true);
    header.setUint16(10, method, true);
    header.setUint16(12, time, true);
    header.setUint16(14, date, true);
    header.setUint32(16, crc, true);
    header.setUint32(20, body.length, true);
    header.setUint32(24, raw.length, true);
    header.setUint16(28, name.length, true);
    const unixMode = (type === "directory" ? 0o040000 : 0o100000) | entryMode(entry);
    header.setUint32(38, ((unixMode << 16) | (type === "directory" ? 0x10 : 0)) >>> 0, true);
    header.setUint32(42, offset, true);
    locals.push(new Uint8Array(local.buffer), name, body);
    central.push(new Uint8Array(header.buffer), name);
    offset += 30 + name.length + body.length;
  }
  const directory = concat(central);
  const end = new DataView(new ArrayBuffer(22));
  end.setUint32(0, 0x06054b50, true);
  end.setUint16(8, entries.length, true);
  end.setUint16(10, entries.length, true);
  end.setUint32(12, directory.length, true);
  end.setUint32(16, offset, true);
  return concat([...locals, directory, new Uint8Array(end.buffer)]);
}
