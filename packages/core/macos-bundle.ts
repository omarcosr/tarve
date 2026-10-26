// macOS `.app` bundles without Apple tools: Info.plist, an .icns icon generated from the app's
// PNG, the executable in Contents/MacOS and the Tarve runtime in Contents/Frameworks, plus a
// zip of the bundle. Signing and notarization need a Mac (macos-sign.ts); a .dmg needs
// `hdiutil`, so it is not written here (see reports/gap/macos-ts.md).
// Node.js and Bun alike: node: modules only.
import { chmodSync, existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { createZip, type ArchiveEntry } from "./archive-formats";
import type { AppMetadata } from "./package-metadata";
import { decodePng, encodePng, isIco, isPng, largestIcoPng, resizeSquare } from "./src/png";

/** Oldest macOS the bundle declares (LSMinimumSystemVersion); scripts/native.ts builds with the same MACOSX_DEPLOYMENT_TARGET. */
export const MACOS_MINIMUM_SYSTEM_VERSION = "11.0";
export const MACOS_ICON_FILE = "AppIcon.icns";
export const MACOS_NATIVE_NAME = "libtarve_native.dylib";

// ---- property lists ---------------------------------------------------------

export type PlistValue = string | number | boolean | readonly PlistValue[] | { readonly [key: string]: PlistValue };

function xml(value: string): string {
  return value.replace(/[<>&]/g, match => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;" })[match]!);
}

function plistValue(value: PlistValue, indent: string): string {
  if (typeof value === "string") return `${indent}<string>${xml(value)}</string>`;
  if (typeof value === "boolean") return `${indent}<${value}/>`;
  if (typeof value === "number") return Number.isInteger(value) ? `${indent}<integer>${value}</integer>` : `${indent}<real>${value}</real>`;
  if (Array.isArray(value)) {
    return value.length ? [`${indent}<array>`, ...value.map(item => plistValue(item, indent + "\t")), `${indent}</array>`].join("\n") : `${indent}<array/>`;
  }
  const entries = Object.entries(value as Record<string, PlistValue>);
  if (!entries.length) return `${indent}<dict/>`;
  return [
    `${indent}<dict>`,
    ...entries.flatMap(([key, item]) => [`${indent}\t<key>${xml(key)}</key>`, plistValue(item, indent + "\t")]),
    `${indent}</dict>`,
  ].join("\n");
}

/** An XML property list (the format `plutil -convert xml1` writes). */
export function encodePlist(root: { readonly [key: string]: PlistValue }): string {
  return [
    `<?xml version="1.0" encoding="UTF-8"?>`,
    `<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">`,
    `<plist version="1.0">`,
    plistValue(root, ""),
    `</plist>`,
    "",
  ].join("\n");
}

function unxml(value: string): string {
  return value.replace(/&(lt|gt|amp|quot|apos);/g, (_, name: string) => ({ lt: "<", gt: ">", amp: "&", quot: '"', apos: "'" })[name]!);
}

/** Reads an XML property list (dict, array, string, integer, real, true/false; not data/date). */
export function parsePlist(text: string): Record<string, PlistValue> {
  const tokens = [...text.replace(/<\?xml[^>]*\?>|<!DOCTYPE[^>]*>|<!--[\s\S]*?-->/g, "").matchAll(/<(\/?)([A-Za-z0-9]+)(\s[^>]*?)?(\/?)>|([^<]+)/g)];
  let index = 0;
  const next = () => {
    while (index < tokens.length && tokens[index]![5] !== undefined && !tokens[index]![5]!.trim()) index++;
    return tokens[index++];
  };
  const textUntil = (tag: string): string => {
    let value = "";
    for (;;) {
      const token = tokens[index++];
      if (!token) throw new Error(`plist: unterminated <${tag}>`);
      if (token[5] !== undefined) value += token[5];
      else if (token[1] === "/" && token[2] === tag) return unxml(value);
      else throw new Error(`plist: unexpected <${token[2]}> in <${tag}>`);
    }
  };
  const value = (token: RegExpExecArray | RegExpMatchArray | undefined): PlistValue => {
    if (!token || token[5] !== undefined || token[1] === "/") throw new Error("plist: expected a value");
    const [, , tag, , selfClosing] = token;
    if (tag === "true" || tag === "false") return tag === "true";
    if (tag === "string") return selfClosing ? "" : textUntil("string");
    if (tag === "integer" || tag === "real") return Number(textUntil(tag!));
    if (tag === "array") {
      const items: PlistValue[] = [];
      if (selfClosing) return items;
      for (;;) {
        const item = next();
        if (item?.[1] === "/" && item[2] === "array") return items;
        items.push(value(item));
      }
    }
    if (tag === "dict") {
      const dict: Record<string, PlistValue> = {};
      if (selfClosing) return dict;
      for (;;) {
        const key = next();
        if (key?.[1] === "/" && key[2] === "dict") return dict;
        if (!key || key[2] !== "key") throw new Error("plist: expected <key>");
        const name = textUntil("key");
        dict[name] = value(next());
      }
    }
    throw new Error(`plist: unsupported <${tag}>`);
  };
  const open = next();
  if (!open || open[2] !== "plist") throw new Error("plist: missing <plist>");
  const root = value(next());
  if (typeof root !== "object" || Array.isArray(root)) throw new Error("plist: the root is not a dict");
  return root as Record<string, PlistValue>;
}

// ---- Info.plist -------------------------------------------------------------

export interface InfoPlistFields {
  /** CFBundleName / CFBundleDisplayName. */
  name: string;
  /** CFBundleExecutable: the file in Contents/MacOS. */
  executable: string;
  /** CFBundleIdentifier, reverse DNS (`bundleIdentifier`). */
  identifier: string;
  /** CFBundleShortVersionString and CFBundleVersion (`bundleVersion`). */
  version: string;
  /** CFBundleIconFile, in Contents/Resources. */
  iconFile?: string;
  minimumSystemVersion?: string;
  copyright?: string;
  /** LSApplicationCategoryType, e.g. `public.app-category.productivity`. */
  category?: string;
}

/** The Info.plist of a Tarve app bundle. */
export function infoPlist(fields: InfoPlistFields): string {
  return encodePlist({
    CFBundleDevelopmentRegion: "en",
    CFBundleDisplayName: fields.name,
    CFBundleExecutable: fields.executable,
    ...(fields.iconFile ? { CFBundleIconFile: fields.iconFile } : {}),
    CFBundleIdentifier: fields.identifier,
    CFBundleInfoDictionaryVersion: "6.0",
    CFBundleName: fields.name,
    CFBundlePackageType: "APPL",
    CFBundleShortVersionString: fields.version,
    CFBundleVersion: fields.version,
    ...(fields.category ? { LSApplicationCategoryType: fields.category } : {}),
    LSMinimumSystemVersion: fields.minimumSystemVersion ?? MACOS_MINIMUM_SYSTEM_VERSION,
    NSHighResolutionCapable: true,
    ...(fields.copyright ? { NSHumanReadableCopyright: fields.copyright } : {}),
    NSSupportsAutomaticGraphicsSwitching: true,
  });
}

/** CFBundleIdentifier: the app id with characters outside `A-Z a-z 0-9 . -` replaced, else `dev.tarve.<name>`. */
export function bundleIdentifier(metadata: Pick<AppMetadata, "name" | "appId">): string {
  const clean = (value: string) => value.replace(/[^A-Za-z0-9.-]+/g, "-").replace(/^[.-]+|[.-]+$/g, "");
  const id = metadata.appId ? clean(metadata.appId) : "";
  if (id) return id;
  return `dev.tarve.${clean(metadata.name).toLowerCase() || "app"}`;
}

/** CFBundleVersion: one to three integers. `v1.2.3-beta.1+5` becomes `1.2.3`; no version is `1.0.0`. */
export function bundleVersion(version: string | undefined): string {
  if (version === undefined) return "1.0.0";
  const match = /^v?(\d+(?:\.\d+){0,2})/.exec(version.trim());
  if (!match) throw new Error(`Version ${version} cannot be a macOS bundle version (one to three integers, e.g. 1.2.3).`);
  return match[1]!;
}

/** A file name for Contents/MacOS: the app name without path separators or control characters. */
export function bundleExecutableName(name: string): string {
  return name.replace(/[/\\:\u0000-\u001f]+/g, "-").replace(/^\.+/, "").trim() || "App";
}

// ---- .icns ------------------------------------------------------------------

/** PNG-compressed icon types, smallest first: ic07 128 px, ic08 256, ic09 512, ic10 1024 (512@2x). */
export const ICNS_ICON_TYPES = [
  { type: "ic07", size: 128 },
  { type: "ic08", size: 256 },
  { type: "ic09", size: 512 },
  { type: "ic10", size: 1024 },
] as const;

export interface IcnsEntry {
  /** Four-character OSType, e.g. `ic10`. */
  type: string;
  data: Uint8Array;
}

/** An .icns container: `icns` + total length, then `type` + length (header included) + data per entry, big-endian. */
export function encodeIcns(entries: readonly IcnsEntry[]): Uint8Array {
  const total = 8 + entries.reduce((sum, entry) => sum + 8 + entry.data.length, 0);
  const out = new Uint8Array(total);
  const view = new DataView(out.buffer);
  const ascii = (text: string, offset: number) => {
    if (!/^[\x20-\x7e]{4}$/.test(text)) throw new Error(`Invalid icns type: ${text}`);
    for (let index = 0; index < 4; index++) out[offset + index] = text.charCodeAt(index);
  };
  ascii("icns", 0);
  view.setUint32(4, total);
  let offset = 8;
  for (const entry of entries) {
    ascii(entry.type, offset);
    view.setUint32(offset + 4, 8 + entry.data.length);
    out.set(entry.data, offset + 8);
    offset += 8 + entry.data.length;
  }
  return out;
}

/** The entries of an .icns file; throws on a truncated or malformed container. */
export function parseIcns(bytes: Uint8Array): IcnsEntry[] {
  const text = (offset: number) => String.fromCharCode(...bytes.subarray(offset, offset + 4));
  if (bytes.length < 8 || text(0) !== "icns") throw new Error("not an icns file");
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const total = view.getUint32(4);
  if (total !== bytes.length) throw new Error(`icns length ${total} does not match the file (${bytes.length} bytes)`);
  const entries: IcnsEntry[] = [];
  let offset = 8;
  while (offset < total) {
    if (offset + 8 > total) throw new Error("icns entry header is truncated");
    const length = view.getUint32(offset + 4);
    if (length < 8 || offset + length > total) throw new Error(`icns entry ${text(offset)} has an invalid length`);
    entries.push({ type: text(offset), data: bytes.slice(offset + 8, offset + length) });
    offset += length;
  }
  return entries;
}

/**
 * An .icns from a PNG (or a PNG-compressed .ico): ic07 always, and each larger size up to the
 * image's own, so macOS never shows an upscaled icon it could have drawn sharper.
 */
export function icnsFromImage(bytes: Uint8Array): Uint8Array {
  const png = isIco(bytes) ? largestIcoPng(bytes) : bytes;
  if (!png || !isPng(png)) throw new Error("The app icon must be a PNG (or an .ico with PNG images) to make an .icns");
  const image = decodePng(png);
  const side = Math.max(image.width, image.height);
  const types = ICNS_ICON_TYPES.filter((icon, index) => index === 0 || icon.size <= side);
  return encodeIcns(types.map(({ type, size }) => ({ type, data: encodePng(resizeSquare(image, size), size, size) })));
}

// ---- the bundle -------------------------------------------------------------

export interface MacAppBundleInput {
  /** The compiled Mach-O executable. */
  executable: Uint8Array;
  /** Tarve's libtarve_native.dylib for the same architecture. */
  nativeLibrary: Uint8Array;
  metadata: AppMetadata;
  /** The icon file's bytes (PNG, or .ico with PNG images); omitted: no CFBundleIconFile. */
  icon?: Uint8Array;
  minimumSystemVersion?: string;
  category?: string;
}

/** The files of `<Name>.app`, relative to the bundle: Info.plist, PkgInfo, MacOS/<exe>, Frameworks/<dylib>, Resources/AppIcon.icns. */
export function macAppBundleEntries(input: MacAppBundleInput): ArchiveEntry[] {
  const executable = bundleExecutableName(input.metadata.name);
  const encoder = new TextEncoder();
  const plist = infoPlist({
    name: input.metadata.name,
    executable,
    identifier: bundleIdentifier(input.metadata),
    version: bundleVersion(input.metadata.version),
    iconFile: input.icon ? MACOS_ICON_FILE : undefined,
    minimumSystemVersion: input.minimumSystemVersion,
    copyright: input.metadata.copyright,
    category: input.category,
  });
  return [
    { path: "Contents/", type: "directory" },
    { path: "Contents/Info.plist", data: encoder.encode(plist) },
    { path: "Contents/PkgInfo", data: encoder.encode("APPL????") },
    { path: "Contents/MacOS/", type: "directory" },
    { path: `Contents/MacOS/${executable}`, data: input.executable, mode: 0o755 },
    { path: "Contents/Frameworks/", type: "directory" },
    { path: `Contents/Frameworks/${MACOS_NATIVE_NAME}`, data: input.nativeLibrary, mode: 0o755 },
    ...(input.icon ? [
      { path: "Contents/Resources/", type: "directory" as const },
      { path: `Contents/Resources/${MACOS_ICON_FILE}`, data: icnsFromImage(input.icon) },
    ] : []),
  ];
}

/** `<name>.app` for an output path: the path itself when it already ends in `.app`. */
export function macAppPath(outfile: string): string {
  return /\.app$/i.test(outfile) ? outfile : `${outfile}.app`;
}

/** Writes the bundle at `appPath` (replacing an older one); returns `appPath`. */
export function writeMacAppBundle(appPath: string, input: MacAppBundleInput): string {
  rmSync(appPath, { recursive: true, force: true });
  for (const entry of macAppBundleEntries(input)) {
    const path = join(appPath, ...entry.path.split("/").filter(Boolean));
    if (entry.type === "directory") { mkdirSync(path, { recursive: true }); continue; }
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, entry.data ?? new Uint8Array());
    if (process.platform !== "win32") chmodSync(path, entry.mode ?? 0o644);
  }
  return appPath;
}

export interface MacAppBundleInfo {
  /** The `.app` directory. */
  path: string;
  plist: Record<string, PlistValue>;
  /** Contents/MacOS/<CFBundleExecutable>. */
  executable: string;
}

/** Reads an existing bundle's Info.plist and main executable path. */
export function readMacAppBundle(appPath: string): MacAppBundleInfo {
  const plistPath = join(appPath, "Contents", "Info.plist");
  if (!existsSync(plistPath)) throw new Error(`${appPath} is not a macOS app bundle: Contents/Info.plist is missing.`);
  const plist = parsePlist(readFileSync(plistPath, "utf8"));
  const name = plist.CFBundleExecutable;
  if (typeof name !== "string" || !name || basename(name) !== name) throw new Error(`${plistPath} has no valid CFBundleExecutable.`);
  const executable = join(appPath, "Contents", "MacOS", name);
  if (!existsSync(executable)) throw new Error(`${appPath} is missing its executable Contents/MacOS/${name}.`);
  return { path: appPath, plist, executable };
}

/**
 * Zip entries for a bundle on disk, under `<Name>.app/`. Unix modes come from the files, except
 * on Windows (no exec bit): Contents/MacOS and Frameworks binaries get 0755 there.
 * Symlinks (versioned .framework folders) are refused: zip them with `ditto -c -k --keepParent` on a Mac.
 */
export function macAppZipEntries(appPath: string): ArchiveEntry[] {
  const root = basename(appPath);
  const entries: ArchiveEntry[] = [{ path: `${root}/`, type: "directory" }];
  const walk = (directory: string, relative: string) => {
    for (const name of readdirSync(directory).sort()) {
      const path = join(directory, name);
      const inner = `${relative}${name}`;
      const stat = lstatSync(path);
      if (stat.isSymbolicLink()) throw new Error(`${path} is a symlink; zip this bundle with ditto -c -k --keepParent on macOS.`);
      if (stat.isDirectory()) {
        entries.push({ path: `${root}/${inner}/`, type: "directory" });
        walk(path, `${inner}/`);
      } else {
        const executable = /^Contents\/(MacOS|Frameworks)\//.test(inner);
        const mode = process.platform === "win32" ? (executable ? 0o755 : 0o644) : stat.mode & 0o777;
        entries.push({ path: `${root}/${inner}`, data: new Uint8Array(readFileSync(path)), mode });
      }
    }
  };
  walk(appPath, "");
  return entries;
}

/** Zips the bundle at `appPath` into `zipPath` (the form notarytool and macOS updates take); returns `zipPath`. */
export function zipMacApp(appPath: string, zipPath: string, mtime?: number): string {
  mkdirSync(dirname(zipPath), { recursive: true });
  writeFileSync(zipPath, createZip(macAppZipEntries(appPath), mtime));
  return zipPath;
}
