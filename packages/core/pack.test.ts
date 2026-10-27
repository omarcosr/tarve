import { afterEach, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildPack, hostPackConfig } from "./pack-build";
import { encodePack, importPackContentKey, importPackPublicKey, inspectPack, openPack, packCompatible, readPackFile, validatePackHeader, type PackHeader, type PackSource } from "./src/pack";
import { bootPack, packFile, packMarker, type PackHostConfig } from "./src/pack-host";
import { checkForUpdate, downloadUpdate, installUpdate, updatePlatform } from "./src/updates";
import { generateUpdateKeys, release } from "./updates-build";

const keys = generateUpdateKeys();
const other = generateUpdateKeys();
const root = mkdtempSync(join(tmpdir(), "tarve-pack-"));
const HOST = Symbol.for("tarve.packHost");
const COMPAT = "a".repeat(64);
const contentKey = Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString("base64");
const signer = async (privateKey: string) => {
  const key = await crypto.subtle.importKey("pkcs8", Buffer.from(privateKey, "base64"), { name: "Ed25519" }, false, ["sign"]);
  return async (bytes: Uint8Array) => new Uint8Array(await crypto.subtle.sign({ name: "Ed25519" }, key, bytes as Uint8Array<ArrayBuffer>));
};
const globals = globalThis as Record<string | symbol, unknown>;
let counter = 0;

afterEach(() => {
  delete process.env.TARVE_PACK_DIRECTORY;
  delete globals[HOST];
  delete globals.__packRuns;
});

function config(overrides: Partial<PackHostConfig> = {}): PackHostConfig {
  return {
    name: "App", version: "1.0.0", runtime: "bun", platform: updatePlatform(), publicKey: keys.publicKey,
    contentKey, compat: COMPAT, features: ["net", "media"], ...overrides,
  };
}

async function pack(options: { version?: string; code?: string; files?: PackSource[]; features?: string[]; privateKey?: string; key?: string } = {}): Promise<Uint8Array> {
  return encodePack({
    name: "App", version: options.version ?? "1.1.0", runtime: "bun", platform: updatePlatform(),
    requires: { compat: COMPAT, features: options.features ?? ["net"] }, entry: "app.js",
    files: [{ path: "app.js", data: new TextEncoder().encode(options.code ?? "(globalThis.__packRuns ??= []).push('ran');") }, ...options.files ?? []],
    contentKey: await importPackContentKey(options.key ?? contentKey),
    sign: await signer(options.privateKey ?? keys.privateKey),
  });
}

const reader = (bytes: Uint8Array) => (offset: number, length: number) => {
  if (offset + length > bytes.length) throw new Error("short");
  return bytes.subarray(offset, offset + length);
};

function directory(): string {
  const path = join(root, `packs-${++counter}`);
  mkdirSync(path, { recursive: true });
  process.env.TARVE_PACK_DIRECTORY = path;
  return path;
}

const bindings = { runtime: {}, require: (id: string) => process.getBuiltinModule(id), dirname: root, url: "file:///app" };

test("a pack round-trips: files are gzipped when it pays, encrypted and authenticated", async () => {
  const text = new TextEncoder().encode("hello ".repeat(5000));
  const noise = crypto.getRandomValues(new Uint8Array(4096));
  const bytes = await pack({ files: [{ path: "a-text.txt", data: text }, { path: "b-noise.bin", data: noise }] });
  const opened = await openPack(reader(bytes), bytes.length, await importPackPublicKey(keys.publicKey));
  expect(opened.header.files["a-text.txt"]!.gzip).toBe(true);
  expect(opened.header.files["a-text.txt"]!.size).toBeLessThan(text.length / 10);
  expect(opened.header.files["b-noise.bin"]!.gzip).toBe(false);
  const key = await importPackContentKey(contentKey);
  expect(await readPackFile(opened, reader(bytes), key, "a-text.txt")).toEqual(text);
  expect(await readPackFile(opened, reader(bytes), key, "b-noise.bin")).toEqual(noise);
  // The plain text appears nowhere in the file.
  expect(Buffer.from(bytes).includes(Buffer.from("hello hello"))).toBe(false);
});

test("a pack is rejected when its header, a file, the signer or the content key differ", async () => {
  const bytes = await pack();
  const publicKey = await importPackPublicKey(keys.publicKey);
  const header = bytes.slice();
  header[30] ^= 1;
  await expect(openPack(reader(header), header.length, publicKey)).rejects.toThrow(/signature|JSON|Invalid/);
  const body = bytes.slice();
  body[body.length - 1] ^= 1;
  const opened = await openPack(reader(body), body.length, publicKey);
  await expect(readPackFile(opened, reader(body), await importPackContentKey(contentKey), "app.js")).rejects.toThrow("signed hash");
  await expect(openPack(reader(bytes), bytes.length, await importPackPublicKey(other.publicKey))).rejects.toThrow("signature");
  const good = await openPack(reader(bytes), bytes.length, publicKey);
  const wrongKey = Buffer.from(new Uint8Array(32).fill(7)).toString("base64");
  await expect(readPackFile(good, reader(bytes), await importPackContentKey(wrongKey), "app.js")).rejects.toThrow();
  await expect(openPack(reader(bytes), 20, publicKey)).rejects.toThrow("truncated");
  await expect(openPack(reader(new TextEncoder().encode("MZ".padEnd(200))), 200, publicKey)).rejects.toThrow("not a .tarve");
});

test("pack headers are validated: names, ranges, entry", () => {
  const entry = { offset: 0, size: 10, length: 10, sha256: "b".repeat(64), iv: Buffer.alloc(12).toString("base64"), gzip: false };
  const header = (overrides: Partial<PackHeader>): unknown => ({
    name: "App", version: "1.0.0", runtime: "bun", platform: "win32-x64", requires: { compat: COMPAT, features: [] },
    entry: "app.js", files: { "app.js": entry }, ...overrides,
  });
  expect(validatePackHeader(header({}), 10).entry).toBe("app.js");
  expect(() => validatePackHeader(header({}), 9)).toThrow("range");
  expect(() => validatePackHeader(header({ files: { "../app.js": entry } }), 10)).toThrow("file name");
  expect(() => validatePackHeader(header({ files: { "a\\b": entry } }), 10)).toThrow("file name");
  expect(() => validatePackHeader(header({ files: { "app.js": entry, "b.js": entry } }), 10)).toThrow("overlapping");
  expect(() => validatePackHeader(header({ entry: "main.js" }), 10)).toThrow("entry");
  expect(() => validatePackHeader(header({ requires: { compat: "x", features: [] } }), 10)).toThrow("requires");
  expect(packCompatible({ compat: COMPAT, features: ["net"] }, COMPAT, ["net", "media"])).toBe(true);
  expect(packCompatible({ compat: COMPAT, features: ["syntax"] }, COMPAT, ["net"])).toBe(false);
  expect(packCompatible({ compat: COMPAT, features: [] }, "c".repeat(64), [])).toBe(false);
});

test("bootPack runs the newest valid pack, extracts its files and removes older ones", async () => {
  const dir = directory();
  const asset = { path: "0123456789ab-logo.png", data: crypto.getRandomValues(new Uint8Array(2048)) };
  writeFileSync(packFile(dir, "1.1.0"), await pack({ version: "1.1.0" }));
  writeFileSync(packFile(dir, "1.2.0"), await pack({
    version: "1.2.0",
    files: [asset],
    code: "(globalThis.__packRuns ??= []).push(readFileSync_(globalThis.__tarveAssets['0123456789ab-logo.png']).length, __tarvePackHost.meta.main);"
      .replace("readFileSync_", "__tarvePackHost.require('node:fs').readFileSync"),
  }));
  writeFileSync(packFile(dir, "0.9.0"), await pack({ version: "0.9.0" }));
  expect(await bootPack(config(), bindings)).toBe(true);
  expect(globals.__packRuns).toEqual([2048, true]);
  expect((globals[HOST] as { active?: string }).active).toBe("1.2.0");
  expect(existsSync(packMarker(dir, "1.2.0", "boot"))).toBe(false);
  expect(readdirSync(dir).sort()).toEqual(["1.2.0.tarve"]);
});

test("bootPack skips tampered, foreign and incompatible packs and falls back to the embedded app", async () => {
  const dir = directory();
  const tampered = await pack({ version: "1.3.0" });
  tampered[tampered.length - 1] ^= 1;
  writeFileSync(packFile(dir, "1.3.0"), tampered);
  writeFileSync(packFile(dir, "1.2.0"), await pack({ version: "1.2.0", privateKey: other.privateKey }));
  writeFileSync(packFile(dir, "1.1.0"), await pack({ version: "1.1.0", features: ["syntax"] }));
  writeFileSync(packFile(dir, "1.0.5"), await pack({ version: "1.0.4" }));
  expect(await bootPack(config(), bindings)).toBe(false);
  expect(globals.__packRuns).toBeUndefined();
  expect(readdirSync(dir)).toEqual([]);
  expect(await bootPack(config({ version: "1.0.0" }), bindings)).toBe(false);
});

test("a pack that stopped while starting is marked bad and the previous one runs", async () => {
  const dir = directory();
  writeFileSync(packFile(dir, "1.1.0"), await pack({ version: "1.1.0" }));
  writeFileSync(packFile(dir, "1.2.0"), await pack({ version: "1.2.0" }));
  writeFileSync(packMarker(dir, "1.2.0", "boot"), "");
  expect(await bootPack(config(), bindings)).toBe(true);
  expect((globals[HOST] as { active?: string }).active).toBe("1.1.0");
  expect(existsSync(packMarker(dir, "1.2.0", "bad"))).toBe(true);
  expect(existsSync(packFile(dir, "1.2.0"))).toBe(false);
});

test("tarve pack bundles an app for an executable built with --packs, and the update flow installs it", async () => {
  const app = join(root, "app");
  mkdirSync(app, { recursive: true });
  writeFileSync(join(app, "logo.png"), Buffer.from("89504e470d0a1a0a", "hex"));
  writeFileSync(join(app, "app.ts"), [
    `import { readFileSync } from "node:fs";`,
    `import logo from "./logo.png";`,
    `const version: string = JSON.parse(process.env.TARVE_APP_METADATA!).version;`,
    `(globalThis as any).__packRuns = [version, readFileSync(logo).length, typeof import.meta.url];`,
  ].join("\n"));
  const keyFile = join(root, "update.key");
  writeFileSync(keyFile, keys.privateKey);
  const options = { entrypoint: join(app, "app.ts"), name: "Packed", runtime: "bun" as const, nativeFeatures: "net", updateKey: keyFile };
  const host = await hostPackConfig({ ...options, version: "1.0.0" }, "bun", ["net", "media"]);
  const built = await buildPack({ ...options, version: "1.0.1", outfile: join(root, "out", "Packed.tarve") });
  const bytes = new Uint8Array(readFileSync(built));
  expect(inspectPack(reader(bytes), bytes.length).header.requires).toEqual({ compat: host.compat, features: ["net"] });
  expect(Buffer.from(bytes).includes(Buffer.from("__packRuns"))).toBe(false);

  const dir = directory();
  expect(await bootPack(host, bindings)).toBe(false);
  const published = join(root, "published");
  release({ version: "1.0.1", artifacts: [], packs: [built], privateKey: keys.privateKey, outDir: published });
  const files = Object.fromEntries(readdirSync(published).map(name => [name, new Uint8Array(readFileSync(join(published, name)))]));
  const fetch = (async (input: string | URL | Request) => {
    const body = files[decodeURIComponent(new URL(String(input)).pathname.split("/").pop()!)];
    return body ? new Response(body) : new Response("missing", { status: 404 });
  }) as typeof globalThis.fetch;
  const update = await checkForUpdate({ url: "https://example.test/latest.json", publicKey: keys.publicKey, currentVersion: "1.0.0", name: "Packed", fetch });
  expect(update?.kind).toBe("pack");
  expect(update?.size).toBe(bytes.length);
  const file = await downloadUpdate(update!, { fetch });
  installUpdate(file, { restart: false });
  expect(existsSync(packFile(dir, "1.0.1"))).toBe(true);

  delete globals[HOST];
  expect(await bootPack(host, bindings)).toBe(true);
  expect(globals.__packRuns).toEqual(["1.0.1", 8, "string"]);

  // A pack that failed here is never offered again: the whole executable is.
  writeFileSync(packMarker(dir, "1.0.1", "bad"), "");
  expect(await checkForUpdate({ url: "https://example.test/latest.json", publicKey: keys.publicKey, currentVersion: "1.0.0", name: "Packed", fetch })).toBeNull();
  // Another executable (different Tarve, runtime or plugins) gets the executable, not the pack.
  (globals[HOST] as PackHostConfig).compat = "d".repeat(64);
  rmSync(packMarker(dir, "1.0.1", "bad"));
  expect(await checkForUpdate({ url: "https://example.test/latest.json", publicKey: keys.publicKey, currentVersion: "1.0.0", name: "Packed", fetch })).toBeNull();
  expect(createHash("sha256").update(bytes).digest("hex")).toBe(update!.sha256);
}, 60_000);
