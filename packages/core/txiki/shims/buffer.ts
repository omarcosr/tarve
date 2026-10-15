/** The part of Node's Buffer the Tarve core uses, over Uint8Array. */
type Encoding = "utf8" | "utf-8" | "base64" | "hex" | "latin1" | "binary" | "ascii";

const encoder = new TextEncoder();
const decoder = new TextDecoder();

function encode(value: string, encoding: Encoding = "utf8"): Uint8Array {
  switch (encoding) {
    case "base64": return Uint8Array.fromBase64(value.replace(/[\s=]+$/g, "").replace(/\s/g, ""), { lastChunkHandling: "loose" });
    case "hex": return Uint8Array.fromHex(value);
    case "latin1": case "binary": case "ascii": return Uint8Array.from(value, character => character.charCodeAt(0) & 0xff);
    default: return encoder.encode(value);
  }
}

class BufferBytes extends Uint8Array {
  static fromValue(value: string | ArrayBufferLike | ArrayLike<number> | ArrayBufferView, encodingOrOffset?: Encoding | number, length?: number): BufferBytes {
    if (typeof value === "string") return BufferBytes.wrap(encode(value, encodingOrOffset as Encoding | undefined));
    if (value instanceof ArrayBuffer || value instanceof SharedArrayBuffer) {
      const offset = (encodingOrOffset as number | undefined) ?? 0;
      return new BufferBytes(value as ArrayBuffer, offset, length ?? value.byteLength - offset);
    }
    if (ArrayBuffer.isView(value)) {
      const copy = new BufferBytes(value.byteLength);
      copy.set(new Uint8Array(value.buffer, value.byteOffset, value.byteLength));
      return copy;
    }
    const copy = new BufferBytes(value.length);
    copy.set(value);
    return copy;
  }

  static alloc(size: number, fill = 0): BufferBytes {
    const buffer = new BufferBytes(size);
    if (fill) buffer.fill(fill);
    return buffer;
  }

  static concat(list: readonly Uint8Array[], totalLength?: number): BufferBytes {
    const total = totalLength ?? list.reduce((sum, item) => sum + item.length, 0);
    const out = new BufferBytes(total);
    let offset = 0;
    for (const item of list) {
      if (offset >= total) break;
      out.set(item.subarray(0, total - offset), offset);
      offset += item.length;
    }
    return out;
  }

  static isBuffer(value: unknown): value is BufferBytes {
    return value instanceof BufferBytes;
  }

  static byteLength(value: string | ArrayBufferView | ArrayBuffer, encoding?: Encoding): number {
    return typeof value === "string" ? encode(value, encoding).length : value.byteLength;
  }

  private static wrap(bytes: Uint8Array): BufferBytes {
    return new BufferBytes(bytes.buffer as ArrayBuffer, bytes.byteOffset, bytes.byteLength);
  }

  override toString(encoding: Encoding = "utf8", start = 0, end = this.length): string {
    const bytes = this.subarray(start, end);
    switch (encoding) {
      case "base64": return Uint8Array.prototype.toBase64.call(bytes);
      case "hex": return Uint8Array.prototype.toHex.call(bytes);
      case "latin1": case "binary": case "ascii": {
        let out = "";
        for (let index = 0; index < bytes.length; index += 0x8000) out += String.fromCharCode(...bytes.subarray(index, index + 0x8000));
        return out;
      }
      default: return decoder.decode(bytes);
    }
  }

  write(value: string, offset = 0, encoding: Encoding = "utf8"): number {
    const bytes = encode(value, encoding).subarray(0, this.length - offset);
    this.set(bytes, offset);
    return bytes.length;
  }

  private view(): DataView {
    return new DataView(this.buffer, this.byteOffset, this.byteLength);
  }

  writeUInt8(value: number, offset = 0): number { this[offset] = value; return offset + 1; }
  writeUInt16LE(value: number, offset = 0): number { this.view().setUint16(offset, value, true); return offset + 2; }
  writeUInt16BE(value: number, offset = 0): number { this.view().setUint16(offset, value); return offset + 2; }
  writeUInt32LE(value: number, offset = 0): number { this.view().setUint32(offset, value, true); return offset + 4; }
  writeUInt32BE(value: number, offset = 0): number { this.view().setUint32(offset, value); return offset + 4; }
  writeInt32LE(value: number, offset = 0): number { this.view().setInt32(offset, value, true); return offset + 4; }
  writeInt32BE(value: number, offset = 0): number { this.view().setInt32(offset, value); return offset + 4; }
  readUInt8(offset = 0): number { return this[offset]!; }
  readUInt16LE(offset = 0): number { return this.view().getUint16(offset, true); }
  readUInt16BE(offset = 0): number { return this.view().getUint16(offset); }
  readUInt32LE(offset = 0): number { return this.view().getUint32(offset, true); }
  readUInt32BE(offset = 0): number { return this.view().getUint32(offset); }
  readInt32LE(offset = 0): number { return this.view().getInt32(offset, true); }
  readInt32BE(offset = 0): number { return this.view().getInt32(offset); }
}

/** Node's Buffer: `Buffer.from` takes encodings and offsets, unlike Uint8Array.from. */
type BufferConstructor = Omit<typeof BufferBytes, "from" | "prototype"> & {
  from: typeof BufferBytes.fromValue;
  prototype: BufferBytes;
  new (length: number): BufferBytes;
  new (buffer: ArrayBuffer, byteOffset?: number, length?: number): BufferBytes;
};
export const Buffer = BufferBytes as unknown as BufferConstructor;
Object.defineProperty(Buffer, "from", { value: BufferBytes.fromValue, writable: true, configurable: true });
export type Buffer = BufferBytes;
