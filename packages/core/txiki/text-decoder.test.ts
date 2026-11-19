import { expect, test } from "bun:test";
import { Buffer as ShimBuffer } from "./shims/buffer";
import { withWindowsEncodings } from "./text-decoder";

// A runtime decoder that knows only UTF-8, as txiki.js's and the Android host's.
class Utf8Only {
  readonly encoding = "utf-8";
  private readonly inner: TextDecoder;
  constructor(label = "utf-8") {
    if (!/^utf-?8$/i.test(label.trim())) throw new RangeError(`Unsupported encoding: ${label}`);
    this.inner = new TextDecoder();
  }
  decode(input?: Uint8Array, options?: { stream?: boolean }): string { return this.inner.decode(input, options); }
}
const Decoder = withWindowsEncodings(Utf8Only);
const samples = [
  new Uint8Array([0x68, 0, 0xe9, 0, 0xac, 0x20, 0x3d, 0xd8, 0x00, 0xde]),
  new Uint8Array([0xff, 0xfe, 0x41, 0, 0x00, 0xd8, 0x42, 0]),
  new Uint8Array([0x41, 0, 0x42]),
  new Uint8Array([0x68, 0x80, 0x81, 0x9f, 0xe9, 0xff]),
];

test("UTF-16LE and windows-1252 decode as the built-in TextDecoder does", () => {
  for (const label of ["utf-16le", "UTF-16", "ucs-2", "latin1", "windows-1252", "ascii"]) {
    const ours = new Decoder(label);
    const builtIn = new TextDecoder(label);
    expect(ours.encoding).toBe(builtIn.encoding);
    for (const bytes of samples) expect(ours.decode(bytes)).toBe(builtIn.decode(bytes));
  }
  expect(new Decoder("utf-16le", { ignoreBOM: true }).decode(samples[1])).toBe(new TextDecoder("utf-16le", { ignoreBOM: true }).decode(samples[1]));
  expect(() => new Decoder("utf-16le", { fatal: true }).decode(samples[1])).toThrow(TypeError);
  expect(new Decoder().decode(new TextEncoder().encode("héllo"))).toBe("héllo");
  expect(() => new Decoder("shift_jis")).toThrow(RangeError);
});

test("streamed UTF-16LE keeps split bytes and surrogate pairs whole", () => {
  const bytes = samples[0]!;
  for (let cut = 0; cut <= bytes.length; cut++) {
    const ours = new Decoder("utf-16le");
    const builtIn = new TextDecoder("utf-16le");
    const expected = builtIn.decode(bytes.subarray(0, cut), { stream: true }) + builtIn.decode(bytes.subarray(cut));
    expect(ours.decode(bytes.subarray(0, cut), { stream: true }) + ours.decode(bytes.subarray(cut))).toBe(expected);
  }
});

test("Buffer utf16le / ucs2 match Node.js", () => {
  const text = "hé€😀";
  for (const encoding of ["utf16le", "utf-16le", "ucs2", "ucs-2"] as const) {
    expect([...ShimBuffer.from(text, encoding)]).toEqual([...Buffer.from(text, encoding)]);
    expect(ShimBuffer.byteLength(text, encoding)).toBe(Buffer.byteLength(text, encoding));
    for (const bytes of samples) expect(ShimBuffer.from(bytes).toString(encoding)).toBe(Buffer.from(bytes).toString(encoding));
    const target = ShimBuffer.alloc(5);
    expect(target.write(text, 0, encoding)).toBe(Buffer.alloc(5).write(text, 0, encoding));
  }
});
