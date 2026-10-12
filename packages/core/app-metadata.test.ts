import { afterAll, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { deflateSync } from "node:zlib";
import { appIconImages, buildMetadata, resolveAppMetadata, writeLinuxDesktopEntry } from "./app-metadata";
import { decodePng, encodePng, isIco, largestIcoPng, pngSize } from "./src/png";

const root = mkdtempSync(join(tmpdir(), "tarve-metadata-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));

function project(name: string, manifest: object | undefined, files: Record<string, string | Uint8Array> = {}): string {
  const dir = join(root, name);
  mkdirSync(join(dir, "apps"), { recursive: true });
  if (manifest) writeFileSync(join(dir, "package.json"), JSON.stringify(manifest));
  for (const [path, content] of Object.entries(files)) writeFileSync(join(dir, path), content);
  writeFileSync(join(dir, "apps", "main.tsx"), "");
  return dir;
}

const red = encodePng(new Uint8Array(300 * 200 * 4).map((_, i) => (i % 4 === 0 || i % 4 === 3 ? 255 : 0)), 300, 200);

test("without a tarve field an app is named after its entry file", () => {
  const dir = project("plain", { name: "plain-package", version: "9.9.9" });
  expect(resolveAppMetadata(join(dir, "apps/main.tsx"))).toEqual({ name: "main" });
});

test("package.json tarve, per-entry apps and CLI flags merge in that order", () => {
  const dir = project("full", {
    name: "acme-notes", version: "1.4.0", description: "Notes", author: "Acme Inc. <hi@acme.dev>",
    tarve: { name: "Notes", appId: "Acme.Notes", icon: "icon.png", copyright: "© Acme", apps: { "apps/main.tsx": { name: "Notes Main" } } },
  }, { "icon.png": red });
  const metadata = resolveAppMetadata(join(dir, "apps/main.tsx"), { copyright: "© Override", version: undefined });
  expect(metadata).toEqual({
    name: "Notes Main", version: "1.4.0", description: "Notes", publisher: "Acme Inc.", copyright: "© Override",
    icon: join(dir, "icon.png"), appId: "Acme.Notes",
  });
});

test("invalid metadata fails with the field it is about", () => {
  const dir = project("bad", { tarve: { appId: "has space" } });
  expect(() => resolveAppMetadata(join(dir, "apps/main.tsx"))).toThrow("appId");
  const missing = project("missing", { tarve: { icon: "nope.png" } });
  expect(() => resolveAppMetadata(join(missing, "apps/main.tsx"))).toThrow("App icon not found");
  const wrong = project("wrong", { tarve: { name: 3 } });
  expect(() => resolveAppMetadata(join(wrong, "apps/main.tsx"))).toThrow("tarve.name");
});

test("a PNG becomes a multi-size ICO of square PNG entries, padded and downscaled", () => {
  const path = join(root, "red.png");
  writeFileSync(path, red);
  const { ico, png } = appIconImages(path);
  expect(isIco(ico)).toBe(true);
  const view = new DataView(ico.buffer, ico.byteOffset, ico.byteLength);
  const sizes = Array.from({ length: view.getUint16(4, true) }, (_, i) => ico[6 + i * 16] || 256);
  expect(sizes).toEqual([16, 20, 24, 32, 40, 48, 64, 96, 128, 256]);
  expect(pngSize(png)).toEqual({ width: 256, height: 256 });
  expect(largestIcoPng(ico)).toEqual(png);
  const decoded = decodePng(png);
  // 300x200 centred in a square: the middle is red, the top band transparent.
  const at = (x: number, y: number) => Array.from(decoded.rgba.subarray((y * 256 + x) * 4, (y * 256 + x) * 4 + 4));
  expect(at(128, 128)).toEqual([255, 0, 0, 255]);
  expect(at(128, 5)[3]).toBe(0);
});

test("the PNG decoder reads palette, grey and 16-bit images", () => {
  const chunk = (type: string, data: Uint8Array) => {
    const out = Buffer.alloc(12 + data.length);
    out.writeUInt32BE(data.length, 0); out.write(type, 4, "ascii"); out.set(data, 8);
    return out; // CRC is not checked by the decoder.
  };
  const png = (colour: number, depth: number, rows: number[][], extra: Buffer[] = []) => {
    const header = Buffer.alloc(13);
    header.writeUInt32BE(2, 0); header.writeUInt32BE(1, 4); header[8] = depth; header[9] = colour;
    return new Uint8Array(Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk("IHDR", header), ...extra,
      chunk("IDAT", deflateSync(Buffer.from(rows.flatMap(row => [0, ...row])))), chunk("IEND", new Uint8Array())]));
  };
  const palette = chunk("PLTE", Uint8Array.from([255, 0, 0, 0, 0, 255]));
  const alpha = chunk("tRNS", Uint8Array.from([255, 128]));
  expect(Array.from(decodePng(png(3, 8, [[0, 1]], [palette, alpha])).rgba)).toEqual([255, 0, 0, 255, 0, 0, 255, 128]);
  expect(Array.from(decodePng(png(3, 1, [[0b01000000]], [palette])).rgba)).toEqual([255, 0, 0, 255, 0, 0, 255, 255]);
  expect(Array.from(decodePng(png(0, 8, [[0, 200]])).rgba)).toEqual([0, 0, 0, 255, 200, 200, 200, 255]);
  expect(Array.from(decodePng(png(2, 16, [[1, 0, 2, 0, 3, 0, 4, 0, 5, 0, 6, 0]])).rgba)).toEqual([1, 2, 3, 255, 4, 5, 6, 255]);
});

test("build metadata bakes the name, id and a PNG data URL into the define", () => {
  const dir = project("baked", { tarve: { appId: "Acme.Baked", icon: "icon.png" } }, { "icon.png": red });
  const { define, images } = buildMetadata(join(dir, "apps/main.tsx"), { name: "Baked" });
  const runtime = JSON.parse(JSON.parse(define["process.env.TARVE_APP_METADATA"]!));
  expect(runtime.name).toBe("Baked");
  expect(runtime.appId).toBe("Acme.Baked");
  expect(runtime.icon).toBe(`data:image/png;base64,${Buffer.from(images!.png).toString("base64")}`);
});

test("Linux builds get a desktop entry and icon named after the app id", () => {
  const out = join(root, "linux", "Notes");
  const desktop = writeLinuxDesktopEntry(out, { name: "Notes", description: "Two\nlines", appId: "Acme.Notes" }, red);
  expect(desktop).toBe(join(root, "linux", "Acme.Notes.desktop"));
  const text = readFileSync(desktop, "utf8");
  expect(text).toContain("Name=Notes\n");
  expect(text).toContain("Comment=Two\\nlines\n");
  expect(text).toContain(`Exec="${out}" %U`);
  expect(text).toContain("Icon=Acme.Notes\n");
  expect(text).toContain("StartupWMClass=Acme.Notes\n");
  expect(readFileSync(join(root, "linux", "Acme.Notes.png"))).toEqual(Buffer.from(red));
});
