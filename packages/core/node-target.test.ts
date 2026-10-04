import { afterEach, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gzipSync } from "node:zlib";
import { assertNodeVersion, extractTarMember, targetNodeExecutable } from "./node-target";

const version = "99.1.0";
const directories: string[] = [];
const saved = { mirror: process.env.NODEJS_ORG_MIRROR, cache: process.env.TARVE_CACHE_DIR };

afterEach(() => {
  process.env.NODEJS_ORG_MIRROR = saved.mirror;
  process.env.TARVE_CACHE_DIR = saved.cache;
  if (saved.mirror === undefined) delete process.env.NODEJS_ORG_MIRROR;
  if (saved.cache === undefined) delete process.env.TARVE_CACHE_DIR;
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function tar(entries: Array<{ name: string; body: Buffer; type?: string }>): Buffer {
  const blocks: Buffer[] = [];
  for (const { name, body, type = "0" } of entries) {
    const header = Buffer.alloc(512);
    header.write(name.slice(0, 100), 0);
    header.write(body.length.toString(8).padStart(11, "0"), 124);
    header.write(type, 156);
    header.write("ustar", 257);
    blocks.push(header, body, Buffer.alloc((512 - (body.length % 512)) % 512));
  }
  return Buffer.concat([...blocks, Buffer.alloc(1024)]);
}

function serve(files: Record<string, Buffer>) {
  const hits: string[] = [];
  const server = Bun.serve({
    port: 0,
    fetch(request) {
      const path = new URL(request.url).pathname;
      hits.push(path);
      const file = files[path];
      return file ? new Response(new Uint8Array(file)) : new Response("missing", { status: 404 });
    },
  });
  process.env.NODEJS_ORG_MIRROR = `http://localhost:${server.port}/dist`;
  const cache = mkdtempSync(join(tmpdir(), "tarve-node-cache-"));
  directories.push(cache);
  process.env.TARVE_CACHE_DIR = cache;
  return { server, hits };
}

const sha = (data: Buffer) => createHash("sha256").update(data).digest("hex");

test("extracts a member through GNU long names and skips other entries", () => {
  const long = `node-v${version}-linux-x64/${"x".repeat(120)}/bin/node`;
  const archive = tar([
    { name: "README.md", body: Buffer.from("readme") },
    { name: "././@LongLink", body: Buffer.from(`${long}\0`), type: "L" },
    { name: "truncated", body: Buffer.from("long") },
    { name: `node-v${version}-linux-x64/bin/node`, body: Buffer.from("binary") },
  ]);
  expect(extractTarMember(archive, long).toString()).toBe("long");
  expect(extractTarMember(archive, `node-v${version}-linux-x64/bin/node`).toString()).toBe("binary");
  expect(() => extractTarMember(archive, "missing")).toThrow("not found");
});

test("downloads, verifies and caches the Linux Node.js binary", async () => {
  const binary = Buffer.from(`ELF node-v${version} payload`);
  const archive = gzipSync(tar([{ name: `node-v${version}-linux-x64/bin/node`, body: binary }]));
  const file = `node-v${version}-linux-x64.tar.gz`;
  const { server, hits } = serve({
    [`/dist/v${version}/SHASUMS256.txt`]: Buffer.from(`${sha(archive)}  ${file}\n`),
    [`/dist/v${version}/${file}`]: archive,
  });
  try {
    const path = await targetNodeExecutable("linux-x64", version);
    expect(readFileSync(path)).toEqual(binary);
    const downloads = hits.length;
    expect(await targetNodeExecutable("linux-x64", version)).toBe(path);
    expect(hits.length).toBe(downloads);
    expect(() => assertNodeVersion(path, version)).not.toThrow();
  } finally {
    server.stop(true);
  }
});

test("downloads the Windows node.exe directly", async () => {
  const binary = Buffer.from(`MZ node-v${version}`);
  const { server } = serve({
    [`/dist/v${version}/SHASUMS256.txt`]: Buffer.from(`${sha(binary)}  win-x64/node.exe\n`),
    [`/dist/v${version}/win-x64/node.exe`]: binary,
  });
  try {
    const path = await targetNodeExecutable("windows-x64", version);
    expect(path.endsWith("node.exe")).toBe(true);
    expect(readFileSync(path)).toEqual(binary);
  } finally {
    server.stop(true);
  }
});

test("rejects a download whose checksum does not match and caches nothing", async () => {
  const binary = Buffer.from("tampered");
  const { server } = serve({
    [`/dist/v${version}/SHASUMS256.txt`]: Buffer.from(`${"0".repeat(64)}  win-x64/node.exe\n`),
    [`/dist/v${version}/win-x64/node.exe`]: binary,
  });
  try {
    await expect(targetNodeExecutable("windows-x64", version)).rejects.toThrow("Checksum mismatch");
    await expect(targetNodeExecutable("windows-x64", version)).rejects.toThrow("Checksum mismatch");
  } finally {
    server.stop(true);
  }
});

test("a target executable from another Node.js version is rejected", () => {
  const directory = mkdtempSync(join(tmpdir(), "tarve-node-version-"));
  directories.push(directory);
  const path = join(directory, "node");
  writeFileSync(path, "node-v26.9.0");
  expect(() => assertNodeVersion(path, "26.10.0")).toThrow("is not Node.js v26.10.0");
});
