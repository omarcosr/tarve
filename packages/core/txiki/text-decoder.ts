/**
 * TextDecoder for UTF-16LE and windows-1252 ("latin1", "ascii", …) where the runtime's knows only
 * UTF-8 (txiki.js, the Android host): Windows strings (shortcuts, registry, window text) decode
 * as on Bun and Node.js. Every other label goes to the runtime's own decoder.
 */
type Input = ArrayBuffer | SharedArrayBuffer | ArrayBufferView | undefined;
interface DecoderOptions { fatal?: boolean; ignoreBOM?: boolean }
interface Decoder { readonly encoding: string; readonly fatal: boolean; readonly ignoreBOM: boolean; decode(input?: Input, options?: { stream?: boolean }): string }
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- each runtime types its decode input its own way
type DecoderClass = new (label?: string, options?: DecoderOptions) => { readonly encoding: string; decode(input?: any, options?: { stream?: boolean }): string };

/** The WHATWG labels of UTF-16LE and windows-1252. */
const UTF16LE = new Set(["utf-16le", "utf-16", "ucs-2", "unicode", "csunicode", "iso-10646-ucs-2", "unicodefeff"]);
const WINDOWS_1252 = new Set(["windows-1252", "latin1", "iso-8859-1", "ascii", "us-ascii", "l1", "iso8859-1", "iso88591", "iso_8859-1", "iso_8859-1:1987", "iso-ir-100", "ibm819", "cp819", "cp1252", "x-cp1252", "csisolatin1", "ansi_x3.4-1968"]);
/** windows-1252 0x80–0x9F (0 where WHATWG maps the byte to its C1 control). */
const HIGH = [0x20ac, 0x81, 0x201a, 0x192, 0x201e, 0x2026, 0x2020, 0x2021, 0x2c6, 0x2030, 0x160, 0x2039, 0x152, 0x8d, 0x17d, 0x8f,
  0x90, 0x2018, 0x2019, 0x201c, 0x201d, 0x2022, 0x2013, 0x2014, 0x2dc, 0x2122, 0x161, 0x203a, 0x153, 0x9d, 0x17e, 0x178];

function bytesOf(input: Input): Uint8Array {
  if (!input) return new Uint8Array(0);
  if (input instanceof Uint8Array) return input;
  if (ArrayBuffer.isView(input)) return new Uint8Array(input.buffer, input.byteOffset, input.byteLength);
  return new Uint8Array(input);
}

/** UTF-16LE code units as a string; a trailing odd byte is left out. */
export function decodeUtf16le(bytes: Uint8Array): string {
  let text = "";
  const end = bytes.length & ~1;
  for (let at = 0; at < end; at += 0x10000) {
    const units = new Uint16Array(Math.min(end - at, 0x10000) >> 1);
    for (let index = 0; index < units.length; index++) units[index] = bytes[at + index * 2]! | (bytes[at + index * 2 + 1]! << 8);
    text += String.fromCharCode.apply(null, units as unknown as number[]);
  }
  return text;
}

/** Unpaired surrogates become U+FFFD, as the WHATWG decoder does (or throw when `fatal`). */
function wellFormed(text: string, fatal: boolean): string {
  for (let index = 0; index < text.length; index++) {
    const unit = text.charCodeAt(index);
    if (unit < 0xd800 || unit > 0xdfff) continue;
    const next = text.charCodeAt(index + 1);
    if (unit <= 0xdbff && next >= 0xdc00 && next <= 0xdfff) {
      index++;
      continue;
    }
    if (fatal) throw new TypeError("The encoded data was not valid utf-16le");
    text = text.slice(0, index) + "\ufffd" + text.slice(index + 1);
  }
  return text;
}

/** A TextDecoder class that adds UTF-16LE and windows-1252 to `Native`. */
export function withWindowsEncodings(Native: DecoderClass): DecoderClass {
  return class TextDecoder implements Decoder {
    readonly encoding: string;
    readonly fatal: boolean;
    readonly ignoreBOM: boolean;
    private readonly native?: InstanceType<DecoderClass>;
    /** UTF-16LE streaming: an odd byte or a high surrogate waiting for the next chunk. */
    private pending = new Uint8Array(0);
    private started = false;

    constructor(label = "utf-8", options: DecoderOptions = {}) {
      const name = String(label).trim().toLowerCase();
      this.fatal = !!options.fatal;
      this.ignoreBOM = !!options.ignoreBOM;
      if (UTF16LE.has(name)) this.encoding = "utf-16le";
      else if (WINDOWS_1252.has(name)) this.encoding = "windows-1252";
      else {
        this.native = new Native(label, options);
        this.encoding = this.native.encoding;
      }
    }

    decode(input?: Input, options: { stream?: boolean } = {}): string {
      if (this.native) return this.native.decode(input, options);
      const bytes = bytesOf(input);
      if (this.encoding === "windows-1252") {
        let text = "";
        for (let at = 0; at < bytes.length; at += 0x8000) {
          const chunk = bytes.subarray(at, at + 0x8000);
          const units = new Uint16Array(chunk.length);
          for (let index = 0; index < chunk.length; index++) {
            const byte = chunk[index]!;
            units[index] = byte >= 0x80 && byte <= 0x9f ? HIGH[byte - 0x80]! : byte;
          }
          text += String.fromCharCode.apply(null, units as unknown as number[]);
        }
        return text;
      }
      let all = bytes;
      if (this.pending.length) {
        all = new Uint8Array(this.pending.length + bytes.length);
        all.set(this.pending);
        all.set(bytes, this.pending.length);
      }
      let end = all.length & ~1;
      // A high surrogate at the end of a streamed chunk waits for its low half.
      if (options.stream && end >= 2) {
        const last = all[end - 2]! | (all[end - 1]! << 8);
        if (last >= 0xd800 && last <= 0xdbff) end -= 2;
      }
      if (!options.stream) end = all.length;
      this.pending = options.stream ? all.slice(end) : new Uint8Array(0);
      let text = decodeUtf16le(all.subarray(0, end));
      if (!options.stream && end & 1) {
        if (this.fatal) throw new TypeError("The encoded data was not valid utf-16le");
        text += "\ufffd";
      }
      if (!this.started && !this.ignoreBOM && text.charCodeAt(0) === 0xfeff) text = text.slice(1);
      this.started = options.stream ? this.started || text.length > 0 : false;
      return wellFormed(text, this.fatal);
    }
  };
}
