/** node:fs/promises on Android: the synchronous calls (files are local and small), as promises. */
import * as fs from "./fs";

const later = <T>(call: () => T): Promise<T> => new Promise((resolve, reject) => {
  try {
    resolve(call());
  } catch (error) {
    reject(error);
  }
});

export const readFile = (path: string, options?: Parameters<typeof fs.readFileSync>[1]) => later(() => fs.readFileSync(path, options));
export const writeFile = (path: string, data: string | Uint8Array, options?: Parameters<typeof fs.writeFileSync>[2]) => later(() => fs.writeFileSync(path, data, options));
export const appendFile = (path: string, data: string | Uint8Array) => later(() => fs.appendFileSync(path, data));
export const mkdir = (path: string, options?: { recursive?: boolean }) => later(() => fs.mkdirSync(path, options));
export const mkdtemp = (prefix: string) => later(() => fs.mkdtempSync(prefix));
export const rm = (path: string, options?: { force?: boolean; recursive?: boolean }) => later(() => fs.rmSync(path, options));
export const rmdir = (path: string, options?: { recursive?: boolean }) => later(() => fs.rmdirSync(path, options));
export const unlink = (path: string) => later(() => fs.unlinkSync(path));
export const rename = (from: string, to: string) => later(() => fs.renameSync(from, to));
export const copyFile = (from: string, to: string) => later(() => fs.copyFileSync(from, to));
export const stat = (path: string) => later(() => fs.statSync(path));
export const lstat = stat;
export const access = (path: string) => later(() => fs.accessSync(path));
export const readdir = (path: string, options?: Parameters<typeof fs.readdirSync>[1]) => later(() => fs.readdirSync(path, options));
export const realpath = (path: string) => later(() => fs.realpathSync(path));

export default { access, appendFile, copyFile, lstat, mkdir, mkdtemp, readFile, readdir, realpath, rename, rm, rmdir, stat, unlink, writeFile };
