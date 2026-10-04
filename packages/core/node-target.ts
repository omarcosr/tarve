import { createHash, randomUUID } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { gunzipSync } from "node:zlib";
import type { BuildTarget } from "./targets";

/** Where an official Node.js binary for a target lives inside a release. */
function distribution(target: BuildTarget, version: string): { file: string; member?: string; executable: string } {
  return target === "windows-x64"
    ? { file: "win-x64/node.exe", executable: "node.exe" }
    : { file: `node-v${version}-linux-x64.tar.gz`, member: `node-v${version}-linux-x64/bin/node`, executable: "node" };
}

function cacheRoot(): string {
  if (process.env.TARVE_CACHE_DIR) return process.env.TARVE_CACHE_DIR;
  if (process.platform === "win32") return join(process.env.LOCALAPPDATA ?? join(homedir(), "AppData", "Local"), "tarve", "cache");
  return join(process.env.XDG_CACHE_HOME ?? join(homedir(), ".cache"), "tarve");
}

function mirror(): string {
  return (process.env.NODEJS_ORG_MIRROR ?? "https://nodejs.org/dist").replace(/\/+$/, "");
}

async function download(url: string): Promise<Buffer> {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`Could not download ${url}: HTTP ${response.status}`);
  return Buffer.from(await response.arrayBuffer());
}

/** Extract one regular file from a tar archive (ustar/pax/GNU long names). */
export function extractTarMember(archive: Buffer, member: string): Buffer {
  let offset = 0;
  let longName: string | undefined;
  while (offset + 512 <= archive.length) {
    const header = archive.subarray(offset, offset + 512);
    if (header.every(byte => byte === 0)) break;
    const field = (start: number, length: number) => header.toString("utf8", start, start + length).replace(/\0.*$/s, "");
    const size = Number.parseInt(field(124, 12).trim() || "0", 8);
    const type = field(156, 1) || "0";
    const prefix = field(345, 155);
    const name = longName ?? (prefix ? `${prefix}/${field(0, 100)}` : field(0, 100));
    const body = archive.subarray(offset + 512, offset + 512 + size);
    longName = undefined;
    if (type === "L") longName = body.toString("utf8").replace(/\0.*$/s, "");
    else if (type === "x") longName = /\d+ path=([^\n]*)\n/.exec(body.toString("utf8"))?.[1];
    else if ((type === "0" || type === "\0") && name.replace(/^\.\//, "") === member) return Buffer.from(body);
    offset += 512 + Math.ceil(size / 512) * 512;
  }
  throw new Error(`${member} not found in the Node.js archive`);
}

/** Throw unless an executable is the Node.js release the SEA blob is built with. */
export function assertNodeVersion(executable: string, version: string): void {
  if (!readFileSync(executable).includes(`node-v${version}`)) {
    throw new Error(`${executable} is not Node.js v${version}; the target executable must match the Node.js that builds the app`);
  }
}

/**
 * Return an official Node.js binary for `target`, downloading it from nodejs.org
 * (or NODEJS_ORG_MIRROR) on first use, verified against the release SHASUMS256.
 */
export async function targetNodeExecutable(target: BuildTarget, version: string): Promise<string> {
  const { file, member, executable } = distribution(target, version);
  const directory = join(cacheRoot(), "node", `v${version}`, target);
  const path = join(directory, executable);
  if (existsSync(path)) return path;
  const base = `${mirror()}/v${version}`;
  const sums = (await download(`${base}/SHASUMS256.txt`)).toString("utf8");
  const expected = sums.split(/\r?\n/).find(line => line.endsWith(`  ${file}`))?.split(/\s+/)[0];
  if (!expected) throw new Error(`${file} is not listed in the Node.js v${version} SHASUMS256.txt`);
  const payload = await download(`${base}/${file}`);
  const actual = createHash("sha256").update(payload).digest("hex");
  if (actual !== expected) throw new Error(`Checksum mismatch for ${file}: expected ${expected}, got ${actual}`);
  const binary = member ? extractTarMember(gunzipSync(payload), member) : payload;
  mkdirSync(directory, { recursive: true });
  const temporary = join(directory, `${executable}.${randomUUID()}.tmp`);
  try {
    writeFileSync(temporary, binary, { mode: 0o755 });
    try { renameSync(temporary, path); }
    catch (error) { if (!existsSync(path)) throw error; }
  } finally {
    rmSync(temporary, { force: true });
  }
  if (process.platform !== "win32") chmodSync(path, 0o755);
  return path;
}
