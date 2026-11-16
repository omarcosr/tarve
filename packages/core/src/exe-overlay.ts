// Data carried by a built Tarve executable outside its runtime's own image: the Windows installer
// (`tarve package --format setup`) keeps the app it installs here, so the installed uninstaller
// is the same executable with the overlay taken out instead of a second copy of the app.
//
// Bun and Node.js executables keep their app in PE sections and resources, so the overlay is
// appended to the file (before an Authenticode signature, which signtool appends last). A
// txiki.js executable reads its bytecode up to a trailer at the very end of the file and its
// embedded files at absolute offsets, so there the overlay goes between the txiki.js host image
// and its embedded files, and every offset after it moves. Either way the overlay region ends in
// a 16-byte footer: its length (two u32 LE) and "TARVEOVL".
import { closeSync, openSync, readSync, statSync, writeSync } from "node:fs";

const OVERLAY_MAGIC = "TARVEOVL";
const TXIKI_MAGIC = "tx1k1.js";
const BLOB_MAGIC = "TARVEBLB";
const FOOTER = 16;
const CHUNK = 1 << 20;
const encoder = new TextEncoder();
const decoder = new TextDecoder();

interface TxikiIndexEntry { offset: number; [key: string]: unknown }

/** Where a txiki.js executable keeps its parts (absolute offsets). */
interface TxikiLayout {
  /** End of the txiki.js host image: the first embedded file, or the index without files. */
  hostEnd: number;
  index: TxikiIndexEntry[];
  indexStart: number;
  payloadOffset: number;
  /** File size: the trailer's 12 bytes end it. */
  end: number;
}

type Read = (position: number, length: number) => Uint8Array;

function u32(bytes: Uint8Array, offset: number): number {
  return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(offset, true);
}

function footer(length: number): Uint8Array {
  const out = new Uint8Array(FOOTER);
  const view = new DataView(out.buffer);
  view.setUint32(0, length % 0x1_0000_0000, true);
  view.setUint32(4, Math.floor(length / 0x1_0000_0000), true);
  out.set(encoder.encode(OVERLAY_MAGIC), 8);
  return out;
}

/** The overlay length a footer ending at `end` names, or undefined. */
function overlayBefore(read: Read, end: number): number | undefined {
  if (end < FOOTER) return undefined;
  const bytes = read(end - FOOTER, FOOTER);
  if (decoder.decode(bytes.subarray(8)) !== OVERLAY_MAGIC) return undefined;
  const length = u32(bytes, 0) + u32(bytes, 4) * 0x1_0000_0000;
  return length + FOOTER <= end ? length : undefined;
}

function txikiLayout(read: Read, size: number): TxikiLayout | undefined {
  if (size < 12 + 16) return undefined;
  const trailer = read(size - 12, 12);
  if (decoder.decode(trailer.subarray(0, 8)) !== TXIKI_MAGIC) return undefined;
  const payloadOffset = u32(trailer, 8);
  if (payloadOffset < 16 || payloadOffset > size - 12) return undefined;
  const header = read(payloadOffset - 16, 16);
  if (decoder.decode(header.subarray(8)) !== BLOB_MAGIC) return undefined;
  const indexStart = payloadOffset - 16 - u32(header, 0);
  const index = JSON.parse(decoder.decode(read(indexStart, u32(header, 0)))) as TxikiIndexEntry[];
  const hostEnd = index.reduce((first, entry) => Math.min(first, entry.offset), indexStart);
  return { hostEnd, index, indexStart, payloadOffset, end: size };
}

/**
 * Where a PE file's data ends: before its Authenticode certificate table when that table closes
 * the file (signtool puts it there), else at the end of the file.
 */
function peDataEnd(read: Read, size: number): number {
  if (size < 0x40) return size;
  const dos = read(0, 0x40);
  if (dos[0] !== 0x4d || dos[1] !== 0x5a) return size;
  const pe = u32(dos, 0x3c);
  // The optional header up to the certificate table entry (data directory 4) of a PE32+ image.
  if (pe + 0x18 + 0xa0 > size) return size;
  const optional = read(pe + 0x18, 0xa0);
  const directories = optional[0] === 0x0b && optional[1] === 0x02 ? 0x70 : 0x60;
  const certificateOffset = u32(optional, directories + 4 * 8);
  const certificateSize = u32(optional, directories + 4 * 8 + 4);
  return certificateSize > 0 && certificateOffset + certificateSize === size ? certificateOffset : size;
}

/** The layout of the overlay region of a file, if it has one. */
interface Located {
  /** Overlay data: offset and length. */
  offset: number;
  length: number;
  /** The region's whole span (data and footer). */
  regionStart: number;
  regionEnd: number;
  txiki?: TxikiLayout;
  /** PE: where the data ends (before a certificate table), and whether one follows. */
  dataEnd: number;
  signed: boolean;
}

function locate(read: Read, size: number): Located | undefined {
  const txiki = txikiLayout(read, size);
  if (txiki) {
    const length = overlayBefore(read, txiki.hostEnd);
    if (length === undefined) return undefined;
    const regionStart = txiki.hostEnd - FOOTER - length;
    return { offset: regionStart, length, regionStart, regionEnd: txiki.hostEnd, txiki, dataEnd: size, signed: false };
  }
  const dataEnd = peDataEnd(read, size);
  const length = overlayBefore(read, dataEnd);
  if (length === undefined) return undefined;
  const regionStart = dataEnd - FOOTER - length;
  return { offset: regionStart, length, regionStart, regionEnd: dataEnd, dataEnd, signed: dataEnd !== size };
}

function concat(parts: readonly Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0));
  let offset = 0;
  for (const part of parts) { out.set(part, offset); offset += part.length; }
  return out;
}

/** The txiki.js tail (index, header, bytecode, trailer) with every offset moved by `delta`. */
function txikiTail(layout: TxikiLayout, bytecode: Uint8Array, delta: number): Uint8Array {
  const index = encoder.encode(JSON.stringify(layout.index.map(entry => ({ ...entry, offset: entry.offset + delta }))));
  const header = new Uint8Array(16);
  new DataView(header.buffer).setUint32(0, index.length, true);
  header.set(encoder.encode(BLOB_MAGIC), 8);
  const trailer = new Uint8Array(12);
  trailer.set(encoder.encode(TXIKI_MAGIC));
  const filesLength = layout.indexStart - layout.hostEnd;
  new DataView(trailer.buffer).setUint32(8, layout.hostEnd + delta + filesLength + index.length + header.length, true);
  return concat([index, header, bytecode, trailer]);
}

/** `executable` (a Bun, Node.js or txiki.js build, unsigned) carrying `data` as its overlay. */
export function addOverlay(executable: Uint8Array, data: Uint8Array): Uint8Array {
  const read: Read = (position, length) => executable.subarray(position, position + length);
  if (locate(read, executable.length)) throw new Error("This executable already carries an overlay");
  const region = concat([data, footer(data.length)]);
  const txiki = txikiLayout(read, executable.length);
  if (!txiki) {
    if (peDataEnd(read, executable.length) !== executable.length) throw new Error("Add the overlay before signing the executable");
    return concat([executable, region]);
  }
  const bytecode = executable.subarray(txiki.payloadOffset, executable.length - 12);
  return concat([
    executable.subarray(0, txiki.hostEnd), region, executable.subarray(txiki.hostEnd, txiki.indexStart),
    txikiTail(txiki, bytecode, region.length),
  ]);
}

function withFile<T>(path: string, use: (fd: number, size: number, read: Read) => T): T {
  const fd = openSync(path, "r");
  try {
    const size = statSync(path).size;
    const read: Read = (position, length) => {
      const out = new Uint8Array(length);
      let done = 0;
      while (done < length) {
        const count = readSync(fd, out, done, length - done, position + done);
        if (count <= 0) throw new Error(`${path}: unexpected end of file`);
        done += count;
      }
      return out;
    };
    return use(fd, size, read);
  } finally {
    closeSync(fd);
  }
}

/** Copies `length` bytes at `position` of `fd` to `out` at `at`, a chunk at a time. */
function copyRange(fd: number, position: number, length: number, out: number, at: number): void {
  const buffer = new Uint8Array(Math.min(CHUNK, Math.max(1, length)));
  for (let done = 0; done < length;) {
    const count = readSync(fd, buffer, 0, Math.min(buffer.length, length - done), position + done);
    if (count <= 0) throw new Error("unexpected end of file");
    writeSync(out, buffer, 0, count, at + done);
    done += count;
  }
}

/** Whether the executable at `path` carries an overlay. */
export function hasOverlay(path: string): boolean {
  return withFile(path, (_fd, size, read) => locate(read, size) !== undefined);
}

/** Writes the overlay of the executable at `path` to `to`; false when it has none. */
export function extractOverlay(path: string, to: string): boolean {
  return withFile(path, (fd, size, read) => {
    const located = locate(read, size);
    if (!located) return false;
    const out = openSync(to, "w");
    try { copyRange(fd, located.offset, located.length, out, 0); } finally { closeSync(out); }
    return true;
  });
}

/**
 * Writes the executable at `path` without its overlay to `to`: the runtime image as it was built.
 * A signed PE loses its signature with the overlay (the signature covered both), so the
 * certificate table entry and the PE checksum are cleared. Returns false when there is no overlay.
 */
export function writeWithoutOverlay(path: string, to: string): boolean {
  return withFile(path, (fd, size, read) => {
    const located = locate(read, size);
    if (!located) return false;
    const out = openSync(to, "w");
    try {
      if (located.txiki) {
        const layout = located.txiki;
        const regionLength = located.regionEnd - located.regionStart;
        copyRange(fd, 0, located.regionStart, out, 0);
        copyRange(fd, layout.hostEnd, layout.indexStart - layout.hostEnd, out, located.regionStart);
        const tail = txikiTail(layout, read(layout.payloadOffset, size - 12 - layout.payloadOffset), -regionLength);
        writeSync(out, tail, 0, tail.length, located.regionStart + layout.indexStart - layout.hostEnd);
      } else {
        copyRange(fd, 0, located.regionStart, out, 0);
        if (located.signed) {
          const pe = u32(read(0x3c, 4), 0);
          const optional = read(pe + 0x18, 2);
          const directories = optional[0] === 0x0b && optional[1] === 0x02 ? 0x70 : 0x60;
          const zero = new Uint8Array(8);
          writeSync(out, zero, 0, 8, pe + 0x18 + directories + 4 * 8);
          writeSync(out, zero, 0, 4, pe + 0x18 + 64);
        }
      }
    } finally {
      closeSync(out);
    }
    return true;
  });
}
