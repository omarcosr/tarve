import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { gunzipSync } from "node:zlib";
import { assertAvailable, fuse, txikiPayload } from "./txiki-build";
import { Buffer as ShimBuffer } from "./txiki/shims/buffer";

const text = (bytes: Uint8Array) => new TextDecoder().decode(bytes);
const u32 = (bytes: Uint8Array, offset: number) => new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(offset, true);

function compiledBy(host: Uint8Array, payload: Uint8Array): Uint8Array {
  const out = new Uint8Array(host.length + payload.length + 12);
  out.set(host);
  out.set(payload, host.length);
  out.set(new TextEncoder().encode("tx1k1.js"), host.length + payload.length);
  new DataView(out.buffer).setUint32(out.length - 4, host.length, true);
  return out;
}

describe("txiki.js executable layout", () => {
  test("extracts the bytecode tjs compile appended and rejects other layouts", () => {
    const host = new Uint8Array(100).fill(7);
    const payload = new Uint8Array([1, 2, 3, 4, 5]);
    expect([...txikiPayload(compiledBy(host, payload), host.length)]).toEqual([...payload]);
    expect(() => txikiPayload(compiledBy(host, payload), host.length + 1)).toThrow("Unrecognized");
  });

  test("fuses files before the payload where the prelude finds them", () => {
    const base = new Uint8Array(64).fill(9);
    const payload = new Uint8Array([42, 43]);
    const library = new TextEncoder().encode("native ".repeat(500));
    const asset = new Uint8Array([137, 80, 78, 71]);
    const exe = fuse(base, [{ name: "tarve_native.dll", data: library, gzip: true }, { name: "abc-icon.png", data: asset, gzip: false }], payload);

    expect([...exe.subarray(0, base.length)]).toEqual([...base]);
    // The prelude: tjs trailer -> payload offset -> blob header -> index -> files.
    expect(text(exe.subarray(exe.length - 12, exe.length - 4))).toBe("tx1k1.js");
    const payloadStart = u32(exe, exe.length - 4);
    expect([...exe.subarray(payloadStart, exe.length - 12)]).toEqual([...payload]);
    const header = exe.subarray(payloadStart - 16, payloadStart);
    expect(text(header.subarray(8))).toBe("TARVEBLB");
    const indexLength = u32(header, 0);
    const index = JSON.parse(text(exe.subarray(payloadStart - 16 - indexLength, payloadStart - 16))) as { name: string; offset: number; length: number; size: number; sha256: string; gzip: boolean }[];
    expect(index.map(file => file.name)).toEqual(["tarve_native.dll", "abc-icon.png"]);
    for (const [file, data] of [[index[0]!, library], [index[1]!, asset]] as const) {
      const stored = exe.subarray(file.offset, file.offset + file.length);
      const bytes = file.gzip ? gunzipSync(stored) : stored;
      expect(file.size).toBe(data.length);
      expect([...bytes]).toEqual([...data]);
      expect(file.sha256).toBe(createHash("sha256").update(data).digest("hex"));
    }
    expect(index[0]!.length).toBeLessThan(library.length);
  });
});

describe("txiki.js build guard", () => {
  test("passes bundles without placeholders and guarded Bun checks", () => {
    expect(() => assertAvailable('const a=1;typeof Bun<"u"&&Bun.main;throw new Error("needs Bun.")')).not.toThrow();
  });

  test("rejects a reachable unavailable API or an unguarded Bun global", () => {
    expect(() => assertAvailable('x=unavailable("tarve-txiki-unavailable:node:fs.watch")')).toThrow("node:fs.watch");
    expect(() => assertAvailable("await Bun.sleep(1)")).toThrow("Bun.sleep");
  });
});

describe("txiki.js Buffer shim", () => {
  test("matches Node's Buffer for the encodings and writers the core uses", () => {
    for (const value of ["", "a", "héllo wörld ✓", "\u{1F600} emoji"]) {
      const bytes = ShimBuffer.from(value);
      expect(bytes.toString()).toBe(value);
      expect(bytes.toString("base64")).toBe(Buffer.from(value).toString("base64"));
      expect(ShimBuffer.from(bytes.toString("base64"), "base64").toString()).toBe(value);
      expect(bytes.toString("hex")).toBe(Buffer.from(value).toString("hex"));
    }
    expect(ShimBuffer.from("aGk", "base64").toString()).toBe("hi");
    const shim = ShimBuffer.alloc(12);
    const node = Buffer.alloc(12);
    for (const target of [shim, node]) {
      target.writeUInt32BE(0xdeadbeef, 0);
      target.writeUInt16LE(0x1234, 4);
      target.writeUInt32LE(7, 6);
      target.write("IH", 10, "ascii");
    }
    expect([...shim]).toEqual([...node]);
    expect([...ShimBuffer.concat([ShimBuffer.from([1, 2]), new Uint8Array([3])])]).toEqual([1, 2, 3]);
    const source = new Uint8Array([0, 1, 2, 3, 4]);
    expect([...ShimBuffer.from(source.buffer, 1, 3)]).toEqual([1, 2, 3]);
  });
});
