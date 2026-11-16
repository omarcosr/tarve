import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fuse } from "../txiki-build";
import { addOverlay, extractOverlay, hasOverlay, writeWithoutOverlay } from "./exe-overlay";

const root = mkdtempSync(join(tmpdir(), "tarve-overlay-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));

/** A PE32+ header with an empty certificate table, then filler. */
function pe(size = 4096): Uint8Array {
  const bytes = new Uint8Array(size).fill(0x42);
  const view = new DataView(bytes.buffer);
  bytes.set([0x4d, 0x5a]);
  view.setUint32(0x3c, 0x80, true);
  bytes.set([0x50, 0x45, 0, 0], 0x80);
  bytes.set([0x0b, 0x02], 0x98);
  view.setUint32(0x98 + 64, 0x1234, true);
  view.setBigUint64(0x98 + 0x70 + 32, 0n, true);
  return bytes;
}

/** What signtool does: the certificate table appended and named in the data directory. */
function sign(bytes: Uint8Array): Uint8Array {
  const certificate = new Uint8Array(512).fill(0xcc);
  const out = new Uint8Array(bytes.length + certificate.length);
  out.set(bytes);
  out.set(certificate, bytes.length);
  const view = new DataView(out.buffer);
  view.setUint32(0x98 + 0x70 + 32, bytes.length, true);
  view.setUint32(0x98 + 0x70 + 36, certificate.length, true);
  return out;
}

function roundTrip(name: string, executable: Uint8Array, signed = false) {
  const data = new Uint8Array(70_000).map((_, index) => index * 7);
  const path = join(root, name);
  const built = addOverlay(executable, data);
  writeFileSync(path, signed ? sign(built) : built);
  expect(hasOverlay(path)).toBe(true);
  expect(extractOverlay(path, path + ".data")).toBe(true);
  expect(new Uint8Array(readFileSync(path + ".data"))).toEqual(data);
  expect(writeWithoutOverlay(path, path + ".bare")).toBe(true);
  return new Uint8Array(readFileSync(path + ".bare"));
}

describe("executable overlays", () => {
  test("Bun and Node.js executables: appended, and taken off to the byte", () => {
    const executable = pe();
    expect<Uint8Array>(roundTrip("pe.exe", executable)).toEqual(executable);
  });

  test("a signed PE: found before the certificate table; stripping clears the signature entry and checksum", () => {
    const bare = roundTrip("signed.exe", pe(), true);
    const view = new DataView(bare.buffer);
    expect(bare.length).toBe(4096);
    expect(view.getBigUint64(0x98 + 0x70 + 32, true)).toBe(0n);
    expect(view.getUint32(0x98 + 64, true)).toBe(0);
  });

  test("txiki.js executables: between the host and its files, every offset moved and moved back", () => {
    const host = pe(3000);
    const files = [{ name: "tarve_native.dll", data: new Uint8Array(5000).fill(9), gzip: false }, { name: "icon.png", data: new Uint8Array(300).fill(4), gzip: false }];
    const executable = fuse(host, files, new Uint8Array(900).fill(0x77));
    const path = join(root, "txiki.exe");
    const built = addOverlay(executable, new Uint8Array(70_000).fill(1));
    writeFileSync(path, built);
    // What tjs and the prelude read: the trailer's bytecode offset and the files' offsets.
    const view = new DataView(built.buffer);
    const payloadOffset = view.getUint32(built.length - 4, true);
    expect(built.subarray(payloadOffset, built.length - 12)).toEqual(new Uint8Array(900).fill(0x77));
    const indexLength = view.getUint32(payloadOffset - 16, true);
    const index = JSON.parse(new TextDecoder().decode(built.subarray(payloadOffset - 16 - indexLength, payloadOffset - 16))) as { offset: number; length: number }[];
    expect(built.subarray(index[0]!.offset, index[0]!.offset + index[0]!.length)).toEqual(files[0]!.data);
    expect(built.subarray(index[1]!.offset, index[1]!.offset + index[1]!.length)).toEqual(files[1]!.data);
    expect<Uint8Array>(roundTrip("txiki2.exe", executable)).toEqual(executable);
  });

  test("txiki.js without embedded files", () => {
    const executable = fuse(pe(2000), [], new Uint8Array(100).fill(3));
    expect<Uint8Array>(roundTrip("txiki-bare.exe", executable)).toEqual(executable);
  });

  test("plain executables carry none; a second overlay and a signed input are refused", () => {
    const path = join(root, "plain.exe");
    writeFileSync(path, pe());
    expect(hasOverlay(path)).toBe(false);
    expect(extractOverlay(path, path + ".data")).toBe(false);
    expect(writeWithoutOverlay(path, path + ".bare")).toBe(false);
    expect(() => addOverlay(addOverlay(pe(), new Uint8Array(4)), new Uint8Array(4))).toThrow(/already/);
    expect(() => addOverlay(sign(pe()), new Uint8Array(4))).toThrow(/before signing/);
  });
});
