import { expect, test } from "bun:test";
import { createHash, createPrivateKey, sign as edSign } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  assertUpdateUrl, checkForUpdate, compareVersions, downloadUpdate, installUpdate, isValidVersion, updatePlatform,
  validateUpdateManifest, verifyUpdateManifest, type Update,
} from "./src/updates";
import { generateUpdateKeys, release, signUpdateManifest, updatePublicKey } from "./updates-build";

const keys = generateUpdateKeys();
const dir = mkdtempSync(join(tmpdir(), "tarve-updates-"));
const PE = (text: string) => "MZ" + text;
const ELF = (text: string) => "\x7fELF" + text;
const host = updatePlatform();
/** A stub executable for this platform: its magic number (Mach-O 64-bit on macOS), then `text`. */
const native = (text: string): Buffer<ArrayBuffer> => Buffer.concat([
  host.startsWith("win32") ? Buffer.from("MZ") : host.startsWith("darwin") ? Buffer.from([0xcf, 0xfa, 0xed, 0xfe]) : Buffer.from("\x7fELF", "latin1"),
  Buffer.from(text),
]);
const sha = (data: string | Uint8Array) => createHash("sha256").update(data).digest("hex");
const URL_ = "https://example.test/u/latest.json";

function serve(files: Record<string, string | Uint8Array>, headers: Record<string, string> = {}): typeof fetch {
  return (async (input: string | URL | Request) => {
    const name = decodeURIComponent(new URL(String(input)).pathname.split("/").pop()!);
    const body = files[name];
    return body === undefined ? new Response("missing", { status: 404 }) : new Response(body as BodyInit, { headers });
  }) as typeof fetch;
}

function manifest(overrides: Record<string, unknown> = {}) {
  return { version: "1.1.0", pubDate: new Date().toISOString(), platforms: { [host]: { url: "a.bin", sha256: sha("x"), size: 1 } }, ...overrides };
}

const signedJson = (value: object) => JSON.stringify(signUpdateManifest(value as never, keys.privateKey));
const check = (body: string, extra: object = {}) =>
  checkForUpdate({ url: URL_, publicKey: keys.publicKey, currentVersion: "1.0.0", fetch: serve({ "latest.json": body }), ...extra });

test("compareVersions orders releases and pre-releases", () => {
  expect(compareVersions("1.2.0", "1.10.0")).toBe(-1);
  expect(compareVersions("v2.0.0", "2.0")).toBe(0);
  expect(compareVersions("1.0.0-beta.2", "1.0.0-beta.10")).toBe(-1);
  expect(compareVersions("1.0.0", "1.0.0-rc.1")).toBe(1);
  expect(compareVersions("1.0.0+build.2", "1.0.0+build.1")).toBe(0);
});

test("versions and URLs are validated", () => {
  for (const ok of ["1", "1.2.3", "v1.2", "1.0.0-beta.1+sha.5"]) expect(isValidVersion(ok)).toBe(true);
  for (const bad of ["", "latest", "1..2", "1.2.3.4.5", "1.0.0-", "../1.0"]) expect(isValidVersion(bad)).toBe(false);
  expect(assertUpdateUrl("https://x.test/a").href).toBe("https://x.test/a");
  expect(assertUpdateUrl("http://localhost:3000/a").protocol).toBe("http:");
  expect(assertUpdateUrl("http://127.0.0.1/a").protocol).toBe("http:");
  expect(() => assertUpdateUrl("http://x.test/a")).toThrow("HTTPS");
  expect(assertUpdateUrl("http://x.test/a", true).protocol).toBe("http:");
  expect(() => assertUpdateUrl("file:///C:/a.exe", true)).toThrow("HTTPS");
  expect(() => assertUpdateUrl("not a url")).toThrow("Invalid update URL");
});

test("manifest shape is validated field by field", () => {
  expect(validateUpdateManifest(manifest()).version).toBe("1.1.0");
  const bad: [object, string][] = [
    [manifest({ version: "soon" }), "version"],
    [manifest({ pubDate: "yesterday" }), "pubDate"],
    [manifest({ platforms: [] }), "platforms"],
    [manifest({ platforms: { "Windows x64": { url: "a", sha256: sha("x"), size: 1 } } }), "platform Windows x64"],
    [manifest({ platforms: { [host]: { url: "", sha256: sha("x"), size: 1 } } }), ".url"],
    [manifest({ platforms: { [host]: { url: "a", sha256: "abc", size: 1 } } }), ".sha256"],
    [manifest({ platforms: { [host]: { url: "a", sha256: sha("x"), size: 0 } } }), ".size"],
    [manifest({ platforms: { [host]: { url: "a", sha256: sha("x"), size: 1.5 } } }), ".size"],
  ];
  for (const [value, field] of bad) expect(() => validateUpdateManifest(value)).toThrow(field);
});

test("signatures: tampering, other keys and malformed input are rejected", () => {
  const signed = signUpdateManifest(manifest() as never, keys.privateKey);
  expect(verifyUpdateManifest(signed, keys.publicKey).version).toBe("1.1.0");
  expect(() => verifyUpdateManifest({ ...signed, payload: signed.payload.replace("1.1.0", "9.0.0") }, keys.publicKey)).toThrow("signature");
  expect(() => verifyUpdateManifest(signed, generateUpdateKeys().publicKey)).toThrow("signature");
  expect(() => verifyUpdateManifest({ ...signed, signature: "AAAA" }, keys.publicKey)).toThrow("signature");
  expect(() => verifyUpdateManifest(signed, "c2hvcnQ=")).toThrow("32 bytes");
  expect(() => verifyUpdateManifest({ payload: 1 } as never, keys.publicKey)).toThrow("payload, signature");
  const notJson = { payload: "nope", signature: sign("nope") };
  expect(() => verifyUpdateManifest(notJson, keys.publicKey)).toThrow("not JSON");
  expect(updatePublicKey(keys.privateKey)).toBe(keys.publicKey);
  expect(() => signUpdateManifest(manifest() as never, "garbage")).toThrow("Invalid update private key");
});

function sign(payload: string): string {
  return edSign(null, Buffer.from(payload), createPrivateKey({ key: Buffer.from(keys.privateKey, "base64"), format: "der", type: "pkcs8" })).toString("base64");
}

test("checkForUpdate rejects insecure URLs, other apps, bad responses and invalid current versions", async () => {
  await expect(check(signedJson(manifest()), { url: "http://example.test/latest.json" })).rejects.toThrow("HTTPS");
  await expect(check(signedJson(manifest({ name: "Other" })), { name: "Mine" })).rejects.toThrow("is for Other");
  expect((await check(signedJson(manifest({ name: "Mine" })), { name: "Mine" }))?.version).toBe("1.1.0");
  await expect(check("<html>")).rejects.toThrow("not JSON");
  await expect(check(signedJson(manifest()), { currentVersion: "dev" })).rejects.toThrow("Invalid current version");
  await expect(checkForUpdate({ url: URL_, publicKey: keys.publicKey, currentVersion: "1.0.0", fetch: serve({}) })).rejects.toThrow("HTTP 404");
  const http = manifest({ platforms: { [host]: { url: "http://cdn.test/a.bin", sha256: sha("x"), size: 1 } } });
  await expect(check(signedJson(http))).rejects.toThrow("HTTPS");
  expect(await check(signedJson(manifest({ version: "0.9.0" })))).toBeNull();
});

test("release → check → download → install", async () => {
  const app = join(dir, "App.exe");
  writeFileSync(app, native("new build"));
  const out = join(dir, "out");
  const path = release({ version: "1.1.0", artifacts: [`${host}=${app}`], privateKey: keys.privateKey, publicKey: keys.publicKey, outDir: out, name: "App" });
  const artifact = `App-1.1.0-${host}.exe`;
  const files = { "latest.json": readFileSync(path, "utf8"), [artifact]: readFileSync(join(out, artifact)) };
  const options = { url: URL_, publicKey: keys.publicKey, fetch: serve(files), name: "App" };

  expect(await checkForUpdate({ ...options, currentVersion: "1.1.0" })).toBeNull();
  expect(await checkForUpdate({ ...options, currentVersion: "1.0.0", platform: "plan9-x64" })).toBeNull();
  const update = (await checkForUpdate({ ...options, currentVersion: "1.0.0" }))!;
  expect(update.url).toBe(`https://example.test/u/${artifact}`);

  const progress: number[] = [];
  const file = await downloadUpdate(update, { path: join(dir, "download"), fetch: options.fetch, onProgress: n => progress.push(n) });
  expect(progress.at(-1)).toBe(update.size);

  const installed = join(dir, "Installed.exe");
  writeFileSync(installed, native("old build"));
  installUpdate(file, { executable: installed, restart: false });
  expect(readFileSync(installed)).toEqual(native("new build"));
  expect(existsSync(file)).toBe(false);
});

test("downloadUpdate rejects tampered, short, oversized and non-executable files and leaves nothing behind", async () => {
  const body = native("payload");
  const update: Update = { kind: "executable", url: "https://cdn.test/a.bin", sha256: sha(body), size: body.length, version: "2.0.0", currentVersion: "1.0.0", pubDate: "", platform: host };
  const target = join(dir, "dl");
  const attempt = (data: string | Uint8Array, headers?: Record<string, string>, extra: Partial<Update> = {}) =>
    downloadUpdate({ ...update, ...extra }, { path: target, fetch: serve({ "a.bin": data }, headers) });
  await expect(attempt(Buffer.concat([Buffer.from("tampered"), body.subarray(8)]))).rejects.toThrow("SHA-256");
  await expect(attempt(body.subarray(0, 3))).rejects.toThrow("incomplete");
  await expect(attempt(Buffer.concat([body, Buffer.from("extra")]))).rejects.toThrow("larger");
  await expect(attempt(body, { "content-length": "999" })).rejects.toThrow("999 bytes");
  await expect(attempt("plain text", undefined, { sha256: sha("plain text"), size: 10 })).rejects.toThrow("not a");
  await expect(attempt(body, undefined, { url: "http://cdn.test/a.bin" })).rejects.toThrow("HTTPS");
  await expect(attempt(body, undefined, { sha256: "nope" })).rejects.toThrow("Invalid update");
  expect(existsSync(target)).toBe(false);
  expect(readFileSync(await attempt(body))).toEqual(body);
});

test("installUpdate refuses runtimes, missing files and non-executables", () => {
  const installed = join(dir, "Keep.exe");
  writeFileSync(installed, native("keep"));
  expect(() => installUpdate(join(dir, "x"), { executable: join(dir, "bun.exe"), restart: false })).toThrow("tarve build");
  expect(() => installUpdate(join(dir, "missing"), { executable: installed, restart: false })).toThrow("not found");
  const text = join(dir, "text.bin");
  writeFileSync(text, "hello");
  expect(() => installUpdate(text, { executable: installed, restart: false })).toThrow("not an executable");
  expect(readFileSync(installed)).toEqual(native("keep"));
});

test("release validates its inputs before writing anything", () => {
  const app = join(dir, "Rel.exe"), linux = join(dir, "Rel");
  writeFileSync(app, PE("x"));
  writeFileSync(linux, ELF("x"));
  const base = { version: "1.0.0", privateKey: keys.privateKey, outDir: join(dir, "rel-out") };
  expect(() => release({ ...base, artifacts: [] })).toThrow("at least one");
  expect(() => release({ ...base, version: "next", artifacts: [`win32-x64=${app}`] })).toThrow("Invalid --version");
  expect(() => release({ ...base, artifacts: [app] })).toThrow("platform=path");
  expect(() => release({ ...base, artifacts: [`Windows=${app}`] })).toThrow("Invalid platform");
  expect(() => release({ ...base, artifacts: [`win32-x64=${join(dir, "nope.exe")}`] })).toThrow("not found");
  expect(() => release({ ...base, artifacts: [`win32-x64=${linux}`] })).toThrow("not a win32-x64 executable");
  expect(() => release({ ...base, artifacts: [`linux-x64=${app}`] })).toThrow("not a linux-x64 executable");
  expect(() => release({ ...base, artifacts: [`win32-x64=${app}`, `win32-x64=${app}`] })).toThrow("twice");
  expect(() => release({ ...base, artifacts: [`win32-x64=${app}`], baseUrl: "http://cdn.test/" })).toThrow("HTTPS");
  expect(() => release({ ...base, artifacts: [`win32-x64=${app}`], publicKey: generateUpdateKeys().publicKey })).toThrow("does not match");
  expect(() => release({ ...base, artifacts: [`win32-x64=${app}`], privateKey: "garbage" })).toThrow("Invalid update private key");
  expect(existsSync(base.outDir)).toBe(false);
  const path = release({ ...base, artifacts: [`win32-x64=${app}`, `linux-x64=${linux}`], baseUrl: "https://cdn.test/v1" });
  const { platforms } = verifyUpdateManifest(JSON.parse(readFileSync(path, "utf8")), keys.publicKey);
  expect(platforms["win32-x64"]!.url).toBe("https://cdn.test/v1/Rel-1.0.0-win32-x64.exe");
  expect(platforms["linux-x64"]!.url).toBe("https://cdn.test/v1/Rel-1.0.0-linux-x64");
});

test("release signs Windows artifacts before hashing and checks the signer did its job", () => {
  const app = join(dir, "Signed.exe"), linux = join(dir, "Signed");
  writeFileSync(app, PE("unsigned"));
  writeFileSync(linux, ELF("unsigned"));
  const script = (name: string, body: string) => {
    const path = join(dir, name);
    writeFileSync(path, body);
    return `"${process.execPath}" "${path}" {file}`;
  };
  const signer = script("sign.ts", 'import { appendFileSync } from "node:fs"; appendFileSync(process.argv[2]!, "+sig");');
  const out = join(dir, "signed-out");
  const manifestPath = release({ version: "2.0.0", artifacts: [`win32-x64=${app}`, `linux-x64=${linux}`], privateKey: keys.privateKey, outDir: out, sign: signer });
  const { platforms } = verifyUpdateManifest(JSON.parse(readFileSync(manifestPath, "utf8")), keys.publicKey);
  const signed = readFileSync(join(out, "Signed-2.0.0-win32-x64.exe"));
  expect(signed.toString()).toBe(PE("unsigned+sig"));
  expect(platforms["win32-x64"]!.sha256).toBe(sha(signed));
  expect(platforms["win32-x64"]!.size).toBe(signed.length);
  expect(readFileSync(join(out, "Signed-2.0.0-linux-x64"), "utf8")).toBe(ELF("unsigned"));
  expect(readFileSync(app, "utf8")).toBe(PE("unsigned"));
  const base = { version: "2.0.0", artifacts: [`win32-x64=${app}`], privateKey: keys.privateKey, outDir: out };
  expect(() => release({ ...base, sign: `"${process.execPath}" -e "process.exit(3)"` })).toThrow("exit 3");
  expect(() => release({ ...base, sign: script("noop.ts", "") })).toThrow("unchanged");
  expect(() => release({ ...base, sign: script("break.ts", 'import { writeFileSync } from "node:fs"; writeFileSync(process.argv[2]!, "broken");') })).toThrow("no longer an executable");
});
