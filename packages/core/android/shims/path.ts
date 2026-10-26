/** node:path on Android: POSIX paths; the working directory is the app's files directory. */
import { host } from "../host";

export const sep = "/";
export const delimiter = ":";

export function normalize(path: string): string {
  if (!path) return ".";
  const absolute = path.startsWith("/");
  const trailing = path.endsWith("/");
  const out: string[] = [];
  for (const part of path.split("/")) {
    if (!part || part === ".") continue;
    if (part === "..") {
      if (out.length && out[out.length - 1] !== "..") out.pop();
      else if (!absolute) out.push("..");
    } else {
      out.push(part);
    }
  }
  const joined = out.join("/");
  if (absolute) return `/${joined}${trailing && joined ? "/" : ""}`;
  return (joined || ".") + (trailing && joined ? "/" : "");
}

export function join(...parts: string[]): string {
  const joined = parts.filter(part => part !== "").join("/");
  return joined ? normalize(joined) : ".";
}

export function resolve(...parts: string[]): string {
  let path = "";
  for (let index = parts.length - 1; index >= 0 && !path.startsWith("/"); index--) {
    const part = parts[index]!;
    if (part) path = path ? `${part}/${path}` : part;
  }
  if (!path.startsWith("/")) path = `${host.filesDir}/${path}`;
  const normalized = normalize(path);
  return normalized.length > 1 ? normalized.replace(/\/$/, "") : normalized;
}

export function isAbsolute(path: string): boolean {
  return path.startsWith("/");
}

export function dirname(path: string): string {
  if (!path) return ".";
  const trimmed = path.replace(/\/+$/, "") || "/";
  const index = trimmed.lastIndexOf("/");
  if (index < 0) return ".";
  return index === 0 ? "/" : trimmed.slice(0, index);
}

export function basename(path: string, suffix?: string): string {
  const name = path.replace(/\/+$/, "").split("/").pop() ?? "";
  return suffix && name.endsWith(suffix) && name !== suffix ? name.slice(0, -suffix.length) : name;
}

export function extname(path: string): string {
  const name = basename(path);
  const index = name.lastIndexOf(".");
  return index <= 0 ? "" : name.slice(index);
}

export function relative(from: string, to: string): string {
  const a = resolve(from).split("/").filter(Boolean);
  const b = resolve(to).split("/").filter(Boolean);
  let common = 0;
  while (common < a.length && common < b.length && a[common] === b[common]) common++;
  return [...Array(a.length - common).fill(".."), ...b.slice(common)].join("/");
}

export interface ParsedPath { root: string; dir: string; base: string; ext: string; name: string }

export function parse(path: string): ParsedPath {
  const base = basename(path);
  const ext = extname(path);
  const dir = path.includes("/") ? dirname(path) : "";
  return { root: path.startsWith("/") ? "/" : "", dir, base, ext, name: ext ? base.slice(0, -ext.length) : base };
}

export function format(path: Partial<ParsedPath>): string {
  const base = path.base ?? `${path.name ?? ""}${path.ext ?? ""}`;
  const dir = path.dir ?? path.root ?? "";
  return dir ? (dir.endsWith("/") ? dir + base : `${dir}/${base}`) : base;
}

export function toNamespacedPath(path: string): string {
  return path;
}

const path = { sep, delimiter, normalize, join, resolve, isAbsolute, dirname, basename, extname, relative, parse, format, toNamespacedPath };
export const posix = path;
export const win32 = path;
export default { ...path, posix, win32 };
