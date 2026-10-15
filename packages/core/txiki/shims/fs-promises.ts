/** node:fs/promises over the asynchronous tjs file API. */
import { Buffer } from "./buffer";

type Encoding = BufferEncoding | { encoding?: BufferEncoding | null } | null | undefined;

function encodingOf(options: Encoding): BufferEncoding | undefined {
  return typeof options === "string" ? options : options?.encoding ?? undefined;
}

interface TjsFiles {
  readFile(path: string): Promise<Uint8Array>;
  writeFile(path: string, data: Uint8Array): Promise<void>;
  makeDir(path: string, options?: { recursive?: boolean }): Promise<void>;
  makeTempDir(template: string): Promise<string>;
  remove(path: string): Promise<void>;
  rename(from: string, to: string): Promise<void>;
  copyFile(from: string, to: string): Promise<void>;
  stat(path: string): Promise<{ size: number; isFile: boolean; isDirectory: boolean; mtim: Date }>;
  readDir(path: string): Promise<AsyncIterable<{ name: string; isFile: boolean; isDirectory: boolean }> & { close(): Promise<void> }>;
}
const files = tjs as unknown as TjsFiles;

export async function readFile(path: string, options?: Encoding): Promise<any> {
  const bytes = Buffer.from(await files.readFile(path));
  const encoding = encodingOf(options);
  return encoding ? bytes.toString(encoding as "utf8") : bytes;
}

export async function writeFile(path: string, data: string | Uint8Array): Promise<void> {
  await files.writeFile(path, typeof data === "string" ? Buffer.from(data) : data);
}

export async function mkdir(path: string, options?: { recursive?: boolean }): Promise<void> {
  await files.makeDir(path, options);
}

export async function mkdtemp(prefix: string): Promise<string> {
  return files.makeTempDir(`${prefix}XXXXXX`);
}

export async function rm(path: string, options?: { force?: boolean; recursive?: boolean }): Promise<void> {
  try {
    await files.stat(path);
  } catch (error) {
    if (options?.force) return;
    throw error;
  }
  await files.remove(path);
}

export const unlink = (path: string) => files.remove(path);
export const rename = (from: string, to: string) => files.rename(from, to);
export const copyFile = (from: string, to: string) => files.copyFile(from, to);

export async function stat(path: string) {
  const info = await files.stat(path);
  return { size: info.size, mtimeMs: info.mtim.getTime(), mtime: info.mtim, isFile: () => info.isFile, isDirectory: () => info.isDirectory };
}

export async function access(path: string): Promise<void> {
  await files.stat(path);
}

export async function readdir(path: string, options?: { withFileTypes?: boolean }): Promise<any[]> {
  const directory = await files.readDir(path);
  const entries: any[] = [];
  try {
    for await (const entry of directory) {
      entries.push(options?.withFileTypes ? { name: entry.name, isFile: () => entry.isFile, isDirectory: () => entry.isDirectory } : entry.name);
    }
  } finally {
    await directory.close();
  }
  return entries;
}

export default { access, copyFile, mkdir, mkdtemp, readFile, readdir, rename, rm, stat, unlink, writeFile };
