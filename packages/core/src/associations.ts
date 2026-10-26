// Deep links (`myapp://…`) and file associations: which launch arguments are links or
// files the app was asked to open, and the per-user registration that makes the system
// launch the app for them (Windows: HKCU\Software\Classes through reg.exe; Linux: a
// desktop entry, xdg-mime and shared-mime-info). The text generators are pure so the
// installers (package-installer.ts, android-build.ts) and tests share them.
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, isAbsolute, join, resolve } from "node:path";

import { runtimeAppMetadata } from "./app-metadata";

/** A file type the app opens: double-clicking `*.ext` launches it with the file's path. */
export interface FileTypeAssociation {
  /** The extension, with or without the dot: `"tarvenote"`, `".md"`. */
  ext: string;
  /** What the system calls these files ("Tarve note"). */
  name: string;
  /** Icon for these files: an .ico/.exe,0 (Windows registry) or a .png (packages). */
  icon?: string;
  /** MIME type (Linux, MSIX, Android). Default `application/x-<ext>`, declared by the package's shared-mime-info XML. */
  mime?: string;
}

const SCHEME = /^[a-z][a-z0-9+.-]*$/i;
const EXTENSION = /^[a-z0-9][a-z0-9_+-]*(\.[a-z0-9_+-]+)*$/;
const MIME = /^[a-z0-9][a-z0-9.+-]*\/[a-z0-9][a-z0-9.+_-]*$/i;
const URL_ARGUMENT = /^([a-z][a-z0-9+.-]+):/i;

/** A URL scheme as registered: lowercase; throws on an invalid one (or a one-letter drive). */
export function normalizeScheme(scheme: string): string {
  if (!SCHEME.test(scheme) || scheme.length < 2) throw new TypeError(`Invalid URL scheme: ${scheme}`);
  return scheme.toLowerCase();
}

/** `".MD"` → `"md"`; throws on an invalid extension. */
export function normalizeExtension(ext: string): string {
  const value = ext.trim().replace(/^\./, "").toLowerCase();
  if (!EXTENSION.test(value)) throw new TypeError(`Invalid file extension: ${ext}`);
  return value;
}

/** The type's MIME type: its own, else `application/x-<ext>`. */
export function fileTypeMime(type: FileTypeAssociation): string {
  const mime = type.mime ?? `application/x-${normalizeExtension(type.ext).replaceAll(".", "-")}`;
  if (!MIME.test(mime)) throw new TypeError(`Invalid MIME type: ${mime}`);
  return mime.toLowerCase();
}

/** Types whose MIME type the package declares itself (no explicit mime, or an `x-`/`vnd.` one). */
export function customFileTypes(types: readonly FileTypeAssociation[] = []): FileTypeAssociation[] {
  return types.filter(type => !type.mime || /^[^/]+\/(x-|vnd\.)/i.test(type.mime));
}

/** Arguments that are URLs of `schemes` (default: every `scheme://` argument), as an OS opens a link. */
export function urlsOf(args: readonly string[], schemes?: readonly string[]): string[] {
  const wanted = schemes?.length ? schemes.map(scheme => scheme.toLowerCase()) : undefined;
  return args.filter(arg => {
    const scheme = URL_ARGUMENT.exec(arg)?.[1]?.toLowerCase();
    // One letter is a Windows drive (C:\…), `file:` a path.
    if (!scheme || scheme === "file") return false;
    return wanted ? wanted.includes(scheme) : arg.includes("://");
  });
}

export interface OpenRequest {
  /** Links of the app's schemes. */
  urls: string[];
  /** Absolute paths of files to open. */
  files: string[];
}

export interface OpenArgsOptions {
  protocols?: readonly string[];
  /** With types, only files with their extensions; without, every argument naming an existing file. */
  fileTypes?: readonly FileTypeAssociation[];
  /** Relative paths resolve against it (the launch's working directory). */
  cwd?: string;
  exists?: (path: string) => boolean;
}

function isFile(path: string): boolean {
  try { return statSync(path).isFile(); } catch { return false; }
}

/**
 * `file:///home/a/b%20c.txt` → `/home/a/b c.txt` (`C:\…` and `\\host\…` on Windows), like
 * node:url's fileURLToPath, which the Android (QuickJS) runtime does not provide.
 */
export function fileUrlPath(url: string, windows = process.platform === "win32"): string {
  const match = /^file:(?:\/\/([^/?#]*))?([^?#]*)/i.exec(url);
  if (!match) throw new TypeError(`Not a file URL: ${url}`);
  const host = match[1] && match[1].toLowerCase() !== "localhost" ? match[1] : "";
  const pathname = match[2] || "/";
  if (/%2f/i.test(pathname) || (windows && /%5c/i.test(pathname))) throw new TypeError(`File URL path must not include encoded separators: ${url}`);
  const path = decodeURIComponent(pathname);
  if (!windows) {
    if (host) throw new TypeError(`File URL host must be "localhost" or empty: ${url}`);
    return path;
  }
  if (host) return `\\\\${host}${path.replaceAll("/", "\\")}`;
  if (!/^\/[A-Za-z]:/.test(path)) throw new TypeError(`File URL path must be absolute: ${url}`);
  return path.slice(1).replaceAll("/", "\\");
}

/**
 * The links and files in launch arguments: `myapp://…` of the app's protocols, and
 * paths (or `file://` URLs, as Linux desktops pass `%U`) of its file types. Options
 * (`-x`, `--x`) are skipped, with the value after a `--tarve-*` option.
 */
export function parseOpenArgs(args: readonly string[], options: OpenArgsOptions = {}): OpenRequest {
  const urls = urlsOf(args, options.protocols);
  const extensions = options.fileTypes?.length ? options.fileTypes.map(type => `.${normalizeExtension(type.ext)}`) : undefined;
  const exists = options.exists ?? isFile;
  const cwd = options.cwd ?? process.cwd();
  const files: string[] = [];
  for (let index = 0; index < args.length; index++) {
    const arg = args[index]!;
    if (!arg || arg === "-") continue;
    if (arg.startsWith("-")) {
      if (arg.startsWith("--tarve-") && !arg.includes("=")) index++;
      continue;
    }
    let path: string;
    if (/^file:/i.test(arg)) {
      try { path = fileUrlPath(arg); } catch { continue; }
    } else if (URL_ARGUMENT.test(arg)) {
      continue;
    } else {
      path = isAbsolute(arg) ? arg : resolve(cwd, arg);
    }
    const wanted = extensions ? extensions.some(ext => path.toLowerCase().endsWith(ext)) : exists(path);
    if (wanted && !files.includes(path)) files.push(path);
  }
  return { urls, files };
}

// ---- command lines ---------------------------------------------------------------

/** A Windows command-line argument, quoted for `CommandLineToArgvW`. */
export function quote(part: string): string {
  return `"${part.replace(/(\\*)"/g, '$1$1\\"').replace(/(\\+)$/, "$1$1")}"`;
}

/** A desktop entry `Exec` argument: quoted, with `"`, `\``, `$` and `\\` escaped, `%` doubled. */
export function desktopQuote(part: string): string {
  return `"${part.replace(/(["\`$\\])/g, "\\$1").replace(/%/g, "%%")}"`;
}

const RUNTIMES = /^(bun|node|tjs|txiki)(\.exe)?$/i;

/** This executable (and its script when a runtime runs one): what the system should launch. */
export function launchCommand(): string[] {
  return RUNTIMES.test(basename(process.execPath)) ? [process.execPath, process.argv[1] ?? ""] : [process.execPath];
}

// ---- Windows registry (HKCU\Software\Classes) ------------------------------------

const CLASSES = "HKCU\\Software\\Classes";

export interface RegistrationOptions {
  /** Shown by the system for the scheme or as the handler's name. Default the app name. */
  name?: string;
  /** The command the system runs with the URL or file appended; default this executable (and script under a runtime). */
  command?: string[];
  /** Windows: the icon (`C:\…\app.ico` or `app.exe,0`). */
  icon?: string;
}

/** A Windows ProgID for an app's file type: `Acme.Notes.tarvenote` (at most 39 characters). */
export function fileTypeProgId(appId: string, ext: string): string {
  const app = appId.replace(/[^A-Za-z0-9.]+/g, "").replace(/^[^A-Za-z]+/, "") || "TarveApp";
  const suffix = normalizeExtension(ext).replace(/[^a-z0-9]/g, "");
  return `${app.slice(0, Math.max(1, 38 - suffix.length))}.${suffix}`.slice(0, 39);
}

/** `reg.exe` argument lists that register `scheme://` for the user. */
export function protocolRegistryCommands(scheme: string, options: { name: string; command: readonly string[]; icon?: string }): string[][] {
  const key = `${CLASSES}\\${normalizeScheme(scheme)}`;
  return [
    ["add", key, "/ve", "/d", `URL:${options.name}`, "/f"],
    ["add", key, "/v", "URL Protocol", "/d", "", "/f"],
    ...(options.icon ? [["add", `${key}\\DefaultIcon`, "/ve", "/d", options.icon, "/f"]] : []),
    ["add", `${key}\\shell\\open\\command`, "/ve", "/d", [...options.command.map(quote), '"%1"'].join(" "), "/f"],
  ];
}

export function protocolUnregistryCommands(scheme: string): string[][] {
  return [["delete", `${CLASSES}\\${normalizeScheme(scheme)}`, "/f"]];
}

/**
 * `reg.exe` argument lists that associate `*.ext` with the app for the user: a ProgID
 * (name, icon, open command), the extension's OpenWithProgids entry and, with
 * `setDefault`, the extension's default (Windows still lets the user's own choice win).
 */
export function fileTypeRegistryCommands(type: FileTypeAssociation, options: { progId: string; command: readonly string[]; setDefault?: boolean }): string[][] {
  const ext = normalizeExtension(type.ext);
  const progKey = `${CLASSES}\\${options.progId}`;
  const extKey = `${CLASSES}\\.${ext}`;
  return [
    ["add", progKey, "/ve", "/d", type.name, "/f"],
    ...(type.icon ? [["add", `${progKey}\\DefaultIcon`, "/ve", "/d", type.icon, "/f"]] : []),
    ["add", `${progKey}\\shell\\open\\command`, "/ve", "/d", [...options.command.map(quote), '"%1"'].join(" "), "/f"],
    ["add", `${extKey}\\OpenWithProgids`, "/v", options.progId, "/t", "REG_NONE", "/f"],
    ...(options.setDefault === false ? [] : [["add", extKey, "/ve", "/d", options.progId, "/f"]]),
    ...(type.mime ? [["add", extKey, "/v", "Content Type", "/d", fileTypeMime(type), "/f"]] : []),
  ];
}

export function fileTypeUnregistryCommands(type: FileTypeAssociation, progId: string): string[][] {
  return [
    ["delete", `${CLASSES}\\${progId}`, "/f"],
    ["delete", `${CLASSES}\\.${normalizeExtension(type.ext)}\\OpenWithProgids`, "/v", progId, "/f"],
  ];
}

function reg(args: string[], check = true): string {
  const result = spawnSync("reg.exe", args, { encoding: "utf8", windowsHide: true });
  if (check && (result.error || result.status !== 0)) throw new Error(`reg ${args[0]} failed: ${result.error?.message ?? (result.stderr || result.stdout).trim()}`);
  return result.stdout ?? "";
}

// ---- Linux (freedesktop) ----------------------------------------------------------

function xml(value: string): string {
  return value.replace(/[<>&"']/g, match => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;", '"': "&quot;", "'": "&apos;" })[match]!);
}

/** The desktop entry `MimeType=` value: `x-scheme-handler/<scheme>;` and each file type's MIME type. */
export function desktopMimeTypes(protocols: readonly string[] = [], fileTypes: readonly FileTypeAssociation[] = []): string | undefined {
  const types = [...new Set([...protocols.map(scheme => `x-scheme-handler/${normalizeScheme(scheme)}`), ...fileTypes.map(fileTypeMime)])];
  return types.length ? types.map(type => `${type};`).join("") : undefined;
}

/** shared-mime-info XML (`/usr/share/mime/packages/<id>.xml`) declaring the app's own file types. */
export function sharedMimeInfo(fileTypes: readonly FileTypeAssociation[]): string | undefined {
  const types = customFileTypes(fileTypes);
  if (!types.length) return undefined;
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<mime-info xmlns="http://www.freedesktop.org/standards/shared-mime-info">',
    ...types.flatMap(type => [
      `  <mime-type type="${xml(fileTypeMime(type))}">`,
      `    <comment>${xml(type.name)}</comment>`,
      `    <glob pattern="*.${xml(normalizeExtension(type.ext))}"/>`,
      "  </mime-type>",
    ]),
    "</mime-info>",
    "",
  ].join("\n");
}

/** The freedesktop icon name of a MIME type (`application/x-foo` → `application-x-foo`). */
export function mimeIconName(mime: string): string {
  return mime.replace("/", "-");
}

function dataHome(): string {
  return process.env.XDG_DATA_HOME ?? join(homedir(), ".local", "share");
}

function handlerDesktopFile(kind: string): string {
  return join(dataHome(), "applications", `tarve-${kind.toLowerCase().replace(/[^a-z0-9.-]+/g, "-")}-handler.desktop`);
}

function writeHandlerEntry(file: string, name: string, command: readonly string[], field: "%u" | "%F", mime: string): void {
  mkdirSync(join(file, ".."), { recursive: true });
  const exec = [...command.map(desktopQuote), field].join(" ");
  writeFileSync(file, `[Desktop Entry]\nType=Application\nName=${name.replace(/[\r\n]/g, " ")}\nExec=${exec}\nNoDisplay=true\nMimeType=${mime};\n`);
  const result = spawnSync("xdg-mime", ["default", basename(file), mime], { encoding: "utf8" });
  if (result.error || result.status !== 0) throw new Error(`xdg-mime failed: ${result.error?.message ?? result.stderr.trim()}`);
}

// ---- registration ------------------------------------------------------------------

/**
 * Makes links `scheme://…` open this app, for the current user: Windows registers
 * the scheme under HKCU\Software\Classes (reg.exe), Linux writes a desktop entry and
 * makes it the default handler (`xdg-mime`). The link arrives as an argument:
 * `app.onOpenUrl`, `requestSingleInstance`'s `launch.urls`, or `onSecondInstance`
 * when the app is already running. macOS reads URL schemes from the app bundle's
 * Info.plist and delivers links as Apple events, which Tarve does not handle yet:
 * this throws there.
 */
export function registerProtocol(scheme: string, options: RegistrationOptions = {}): void {
  const normalized = normalizeScheme(scheme);
  const command = options.command ?? launchCommand();
  const name = options.name ?? runtimeAppMetadata().name ?? scheme;
  if (process.platform === "win32") {
    for (const args of protocolRegistryCommands(normalized, { name, command, icon: options.icon })) reg(args);
    return;
  }
  if (process.platform === "linux") {
    writeHandlerEntry(handlerDesktopFile(normalized), name, command, "%u", `x-scheme-handler/${normalized}`);
    return;
  }
  throw new Error(`URL schemes are not supported on ${process.platform} yet`);
}

/** Removes what `registerProtocol` registered for `scheme`. */
export function unregisterProtocol(scheme: string): void {
  const normalized = normalizeScheme(scheme);
  if (process.platform === "win32") {
    for (const args of protocolUnregistryCommands(normalized)) reg(args, false);
    return;
  }
  if (process.platform === "linux") rmSync(handlerDesktopFile(normalized), { force: true });
}

export interface FileTypeRegistrationOptions extends Omit<RegistrationOptions, "name" | "icon"> {
  /** Windows ProgID; default `<appId>.<ext>`. */
  progId?: string;
  /** Windows: make the app the extension's default handler (default true; the user's own choice still wins). */
  setDefault?: boolean;
}

function appIdOf(): string {
  const metadata = runtimeAppMetadata();
  return metadata.appId ?? metadata.name ?? basename(launchCommand().at(-1) ?? "TarveApp").replace(/\.[^.]+$/, "");
}

/**
 * Associates `*.ext` with this app for the current user: Windows writes a ProgID and the
 * extension's OpenWithProgids under HKCU\Software\Classes (reg.exe; Explorer may need a
 * moment, or a sign-out, to show the new icon); Linux declares the MIME type
 * (shared-mime-info under ~/.local/share/mime) and a desktop entry handling it.
 * The file's path arrives as an argument: `app.onOpenFiles`.
 */
export function registerFileType(type: FileTypeAssociation, options: FileTypeRegistrationOptions = {}): void {
  const ext = normalizeExtension(type.ext);
  const command = options.command ?? launchCommand();
  if (process.platform === "win32") {
    const progId = options.progId ?? fileTypeProgId(appIdOf(), ext);
    for (const args of fileTypeRegistryCommands(type, { progId, command, setDefault: options.setDefault })) reg(args);
    return;
  }
  if (process.platform === "linux") {
    const mime = fileTypeMime(type);
    const declaration = sharedMimeInfo([type]);
    if (declaration) {
      const packages = join(dataHome(), "mime", "packages");
      mkdirSync(packages, { recursive: true });
      writeFileSync(join(packages, `tarve-${ext}.xml`), declaration);
      spawnSync("update-mime-database", [join(dataHome(), "mime")], { encoding: "utf8" });
    }
    writeHandlerEntry(handlerDesktopFile(`file-${ext}`), type.name, command, "%F", mime);
    return;
  }
  throw new Error(`File associations are not supported on ${process.platform} yet`);
}

/** Removes what `registerFileType` registered for the type. */
export function unregisterFileType(type: FileTypeAssociation, options: Pick<FileTypeRegistrationOptions, "progId"> = {}): void {
  const ext = normalizeExtension(type.ext);
  if (process.platform === "win32") {
    const progId = options.progId ?? fileTypeProgId(appIdOf(), ext);
    for (const args of fileTypeUnregistryCommands(type, progId)) reg(args, false);
    // The extension's default only when it is still ours.
    const current = reg(["query", `${CLASSES}\\.${ext}`, "/ve"], false);
    if (current.includes(progId)) reg(["delete", `${CLASSES}\\.${ext}`, "/ve", "/f"], false);
    return;
  }
  if (process.platform === "linux") {
    rmSync(handlerDesktopFile(`file-${ext}`), { force: true });
    const declaration = join(dataHome(), "mime", "packages", `tarve-${ext}.xml`);
    if (existsSync(declaration)) {
      rmSync(declaration, { force: true });
      spawnSync("update-mime-database", [join(dataHome(), "mime")], { encoding: "utf8" });
    }
  }
}

// ---- package manifests -----------------------------------------------------------

/** The MSIX `<Extensions>` of the Application: uap:Protocol and uap:FileTypeAssociation. */
export function msixExtensions(protocols: readonly string[] = [], fileTypes: readonly (FileTypeAssociation & { logo?: string })[] = [], indent = "      "): string {
  if (!protocols.length && !fileTypes.length) return "";
  const lines = [`${indent}<Extensions>`];
  for (const scheme of protocols) {
    lines.push(
      `${indent}  <uap:Extension Category="windows.protocol">`,
      `${indent}    <uap:Protocol Name="${xml(normalizeScheme(scheme))}" />`,
      `${indent}  </uap:Extension>`,
    );
  }
  for (const type of fileTypes) {
    const ext = normalizeExtension(type.ext);
    lines.push(
      `${indent}  <uap:Extension Category="windows.fileTypeAssociation">`,
      `${indent}    <uap:FileTypeAssociation Name="${xml(ext.replace(/[^a-z0-9.-]/g, "-"))}">`,
      `${indent}      <uap:DisplayName>${xml(type.name)}</uap:DisplayName>`,
      ...(type.logo ? [`${indent}      <uap:Logo>${xml(type.logo)}</uap:Logo>`] : []),
      `${indent}      <uap:SupportedFileTypes>`,
      `${indent}        <uap:FileType ContentType="${xml(fileTypeMime(type))}">.${xml(ext)}</uap:FileType>`,
      `${indent}      </uap:SupportedFileTypes>`,
      `${indent}    </uap:FileTypeAssociation>`,
      `${indent}  </uap:Extension>`,
    );
  }
  lines.push(`${indent}</Extensions>`);
  return lines.join("\n") + "\n";
}

/** Android VIEW intent-filters opening `scheme://…` links in the activity. */
export function androidIntentFilters(protocols: readonly string[] = [], indent = "      "): string {
  return protocols.map(scheme => [
    `${indent}<intent-filter>`,
    `${indent}  <action android:name="android.intent.action.VIEW"/>`,
    `${indent}  <category android:name="android.intent.category.DEFAULT"/>`,
    `${indent}  <category android:name="android.intent.category.BROWSABLE"/>`,
    `${indent}  <data android:scheme="${xml(normalizeScheme(scheme))}"/>`,
    `${indent}</intent-filter>`,
  ].join("\n") + "\n").join("");
}

/**
 * Android VIEW intent-filters for documents (`content://`, `file://`) of `fileTypes`: by MIME
 * type when the type declares one (what file managers and mail apps send), otherwise by the
 * name's extension (`pathPattern`, which only matches when the URI ends in the file name).
 * The runtime copies the document into the app's cache and reports that path to `onOpenFiles`.
 */
export function androidFileIntentFilters(fileTypes: readonly FileTypeAssociation[] = [], indent = "      "): string {
  return fileTypes.map(type => {
    const ext = normalizeExtension(type.ext);
    const match = type.mime
      ? [`${indent}  <data android:mimeType="${xml(type.mime)}"/>`]
      : [`${indent}  <data android:host="*"/>`, `${indent}  <data android:mimeType="*/*"/>`, `${indent}  <data android:pathPattern=".*\\\\.${xml(ext)}"/>`];
    return [
      `${indent}<intent-filter>`,
      `${indent}  <action android:name="android.intent.action.VIEW"/>`,
      `${indent}  <category android:name="android.intent.category.DEFAULT"/>`,
      `${indent}  <data android:scheme="content"/>`,
      `${indent}  <data android:scheme="file"/>`,
      ...match,
      `${indent}</intent-filter>`,
    ].join("\n") + "\n";
  }).join("");
}
