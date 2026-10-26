// `tarve package`: wraps a built Tarve executable (`tarve build`) into installers and
// portable archives without external tools: a Debian package (.deb), a Linux .tar.gz with a
// desktop entry and a per-user install script, a Windows portable .zip, an MSIX layout
// (packed into .msix when makeappx is available) and a zipped macOS .app (`app-zip`).
// A .dmg needs hdiutil on a Mac and is not written yet. Node.js and Bun alike: node: modules only.
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, readSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { appIconImages, resolveAppMetadata, type AppMetadata } from "./package-metadata";
import { createAr, createTarGz, createZip, type ArchiveEntry } from "./archive-formats";
import { decodePng, encodePng, resizeSquare } from "./src/png";
import { macAppZipEntries, readMacAppBundle } from "./macos-bundle";
import { machOArch } from "./src/macho";
import { customFileTypes, desktopMimeTypes, fileTypeMime, mimeIconName, msixExtensions, normalizeExtension, sharedMimeInfo, type FileTypeAssociation } from "./src/associations";
import { resolveAppAssociations, type AppAssociations } from "./associations-config";

export { createAr, createTar, createTarGz, createZip, crc32, type ArchiveEntry } from "./archive-formats";

export const PACKAGE_FORMATS = ["deb", "tar", "zip", "msix", "app-zip"] as const;
export type PackageFormat = typeof PACKAGE_FORMATS[number];

export interface PackageOptions {
  /** A Tarve executable from `tarve build` (Linux ELF or Windows .exe), or a macOS `.app` bundle. */
  executable: string;
  /** One format or several; defaults to deb + tar for a Linux executable, zip for a Windows one and app-zip for a .app. */
  format?: PackageFormat | readonly PackageFormat[];
  /** Output directory (default: the executable's directory). */
  outDir?: string;
  /** Where to look up package.json `tarve` metadata (default: the executable's path). */
  entrypoint?: string;
  name?: string;
  version?: string;
  description?: string;
  publisher?: string;
  copyright?: string;
  /** .png (square, 256 px or more) or .ico. */
  icon?: string;
  appId?: string;
  /** freedesktop menu categories, e.g. "Utility;Development" (default: Utility). */
  categories?: string | readonly string[];
  /** Debian `Maintainer` (default: the publisher). */
  maintainer?: string;
  /** makeappx.exe path, or false to only write the MSIX folder (default: TARVE_MAKEAPPX, PATH, Windows SDK). */
  makeappx?: string | false;
  /** Archive timestamps in seconds (default: SOURCE_DATE_EPOCH or now). */
  mtime?: number;
  /** URL schemes (`myapp` for `myapp://…`) the app opens, beside package.json `tarve.protocols`. */
  protocols?: readonly string[];
  /** File types the app opens, beside package.json `tarve.fileTypes`. */
  fileTypes?: readonly FileTypeAssociation[];
}

export interface PackageArtifact {
  format: PackageFormat;
  /** The package file, or the MSIX folder when it could not be packed. */
  path: string;
  /** msix: whether makeappx packed the folder into a .msix. */
  packed?: boolean;
  /** Follow-up steps (signing, installing). */
  note?: string;
}

export interface ExecutableInfo {
  platform: "linux" | "win32" | "darwin";
  arch: "x64" | "arm64" | "universal";
}

export function isPackageFormat(value: string): value is PackageFormat {
  return (PACKAGE_FORMATS as readonly string[]).includes(value);
}

/** Parses `--format deb,tar` (comma separated). */
export function parsePackageFormats(value: string | undefined): PackageFormat[] | undefined {
  if (value === undefined) return undefined;
  const formats = value.split(",").map(item => item.trim().toLowerCase()).filter(Boolean);
  for (const format of formats) {
    if (format === "dmg") throw new Error("--format dmg is not supported yet: a .dmg needs hdiutil on macOS. Use --format app-zip (a zipped .app, what notarytool and Tarve updates take).");
    if (!isPackageFormat(format)) throw new Error(`Unsupported package format: ${format}. Expected ${PACKAGE_FORMATS.join(", ")}.`);
  }
  return [...new Set(formats)] as PackageFormat[];
}

/** The OS a package format installs on: deb/tar are Linux, zip/msix Windows, app-zip macOS. */
export function packageFormatPlatform(format: PackageFormat): "linux" | "win32" | "darwin" {
  return format === "deb" || format === "tar" ? "linux" : format === "app-zip" ? "darwin" : "win32";
}

/** Reads the executable header: ELF (Linux), PE (Windows) or Mach-O (macOS, also a .app bundle's main executable) and its machine. */
export function executableInfo(path: string): ExecutableInfo {
  if (statSync(path).isDirectory()) {
    if (!/\.app$/i.test(path)) throw new Error(`${path} is a folder; tarve package takes an executable or a macOS .app bundle.`);
    path = readMacAppBundle(path).executable;
  }
  const header = new Uint8Array(512);
  const fd = openSync(path, "r");
  let length: number;
  try { length = readSync(fd, header, 0, header.length, 0); } finally { closeSync(fd); }
  const view = new DataView(header.buffer);
  if (length >= 20 && header[0] === 0x7f && header[1] === 0x45 && header[2] === 0x4c && header[3] === 0x46) {
    return { platform: "linux", arch: view.getUint16(18, true) === 0xb7 ? "arm64" : "x64" };
  }
  if (length >= 64 && header[0] === 0x4d && header[1] === 0x5a) {
    const pe = view.getUint32(0x3c, true);
    const machine = pe + 6 <= length ? view.getUint16(pe + 4, true) : 0x8664;
    return { platform: "win32", arch: machine === 0xaa64 ? "arm64" : "x64" };
  }
  const mac = machOArch(header.subarray(0, length));
  if (mac) return { platform: "darwin", arch: mac };
  throw new Error(`${path} is not a Linux (ELF), Windows (PE) or macOS (Mach-O) executable. Build it first with tarve build.`);
}

/** Debian package name: lowercase letters, digits, `+ - .`, starting with a letter or digit. */
export function debianPackageName(name: string): string {
  const slug = name.toLowerCase().replace(/[^a-z0-9+.-]+/g, "-").replace(/^[^a-z0-9]+|[-.+]+$/g, "");
  return slug.length >= 2 ? slug : slug ? `${slug}-app` : "app";
}

function requireVersion(metadata: AppMetadata, format: string): string {
  if (!metadata.version) throw new Error(`tarve package --format ${format} needs --version (or "version" in package.json with a "tarve" field).`);
  return metadata.version;
}

function debianVersion(version: string): string {
  const normalized = version.replace(/^v/, "").replace(/-/g, "~");
  if (!/^[0-9][A-Za-z0-9.+~]*$/.test(normalized)) throw new Error(`Version ${version} is not a valid Debian version (it must start with a digit).`);
  return normalized;
}

/** MSIX versions are four numbers (0-65535): 1.2.3-beta becomes 1.2.3.0. */
export function msixVersion(version: string): string {
  const numbers = version.replace(/^v/, "").split(/[-+]/)[0]!.split(".").map(part => Number.parseInt(part, 10));
  if (!numbers.length || numbers.some(part => !Number.isInteger(part) || part < 0 || part > 65535)) throw new Error(`Version ${version} cannot be an MSIX version (four numbers 0-65535).`);
  while (numbers.length < 4) numbers.push(0);
  return numbers.slice(0, 4).join(".");
}

function fileSlug(value: string): string {
  return value.replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "") || "app";
}

function xml(value: string): string {
  return value.replace(/[<>&"']/g, match => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;", '"': "&quot;", "'": "&apos;" })[match]!);
}

function desktopValue(value: string): string {
  return value.replace(/[\\\n\r\t]/g, match => ({ "\\": "\\\\", "\n": "\\n", "\r": "\\r", "\t": "\\t" })[match]!);
}

function categoryList(categories: PackageOptions["categories"]): string {
  const list = (typeof categories === "string" ? categories.split(/[;,]/) : categories ?? ["Utility"]).map(item => item.trim()).filter(Boolean);
  return (list.length ? list : ["Utility"]).join(";") + ";";
}

/** A freedesktop .desktop entry. */
export function desktopEntry(fields: { name: string; exec: string; icon?: string; comment?: string; wmClass: string; categories?: PackageOptions["categories"]; mimeTypes?: string }): string {
  return [
    "[Desktop Entry]",
    "Type=Application",
    `Name=${desktopValue(fields.name)}`,
    ...(fields.comment ? [`Comment=${desktopValue(fields.comment)}`] : []),
    `Exec=${fields.exec}`,
    ...(fields.icon ? [`Icon=${fields.icon}`] : []),
    `StartupWMClass=${fields.wmClass}`,
    `Categories=${categoryList(fields.categories)}`,
    ...(fields.mimeTypes ? [`MimeType=${fields.mimeTypes}`] : []),
    "Terminal=false",
    "",
  ].join("\n");
}

interface Context {
  executable: string;
  bytes: Uint8Array;
  info: ExecutableInfo;
  metadata: AppMetadata;
  outDir: string;
  options: PackageOptions;
  /** Square PNG (at most 256 px) and its side, when the app has an icon. */
  icon?: { png: Uint8Array; size: number };
  /** Deep links and file types the app opens. */
  associations: AppAssociations;
}

const encoder = new TextEncoder();

function linuxIds(context: Context) {
  const exe = basename(context.executable);
  const pkg = debianPackageName(context.metadata.name);
  // Same window class the Linux build's own desktop entry uses (package-metadata.ts).
  const wmClass = context.metadata.appId ?? exe;
  return { exe, pkg, wmClass, iconId: fileSlug(wmClass) };
}

/** A file type's .png icon, square and at most `max` px; undefined without a .png icon. */
function typeIcon(type: FileTypeAssociation, max: number): { png: Uint8Array; size: number } | undefined {
  if (!type.icon?.toLowerCase().endsWith(".png")) return undefined;
  if (!existsSync(type.icon)) throw new Error(`File type icon not found: ${type.icon}`);
  const image = decodePng(new Uint8Array(readFileSync(type.icon)));
  const size = Math.min(max, Math.max(image.width, image.height));
  return { png: encodePng(resizeSquare(image, size), size, size), size };
}

/**
 * Linux files declaring the app's deep links and file types, relative to the data directory
 * (/usr/share or ~/.local/share): shared-mime-info XML and the file types' icons.
 */
function linuxAssociationFiles(context: Context, iconId: string): ArchiveEntry[] {
  const mime = sharedMimeInfo(context.associations.fileTypes);
  return [
    ...(mime ? [{ path: `mime/packages/${iconId}.xml`, data: encoder.encode(mime) }] : []),
    ...customFileTypes(context.associations.fileTypes).flatMap(type => {
      const icon = typeIcon(type, 256);
      return icon ? [{ path: `icons/hicolor/${icon.size}x${icon.size}/mimetypes/${mimeIconName(fileTypeMime(type))}.png`, data: icon.png }] : [];
    }),
  ];
}

function linuxMimeTypes(context: Context): string | undefined {
  return desktopMimeTypes(context.associations.protocols, context.associations.fileTypes);
}

function directories(paths: readonly string[]): ArchiveEntry[] {
  const seen = new Set<string>();
  const out: ArchiveEntry[] = [];
  for (const path of paths) {
    const parts = path.split("/").slice(0, -1);
    for (let index = 1; index <= parts.length; index++) {
      const directory = parts.slice(0, index).join("/") + "/";
      if (!seen.has(directory)) { seen.add(directory); out.push({ path: directory, type: "directory" }); }
    }
  }
  return out;
}

/** Debian package: /opt/<pkg>/<exe>, /usr/bin/<pkg> symlink, desktop entry and hicolor icon. */
function packageDeb(context: Context): PackageArtifact {
  if (context.info.platform !== "linux") throw new Error("--format deb needs a Linux executable (tarve build --target linux-x64).");
  const { exe, pkg, wmClass, iconId } = linuxIds(context);
  const version = debianVersion(requireVersion(context.metadata, "deb"));
  const arch = context.info.arch === "arm64" ? "arm64" : "amd64";
  const files: ArchiveEntry[] = [
    { path: `./opt/${pkg}/${exe}`, data: context.bytes, mode: 0o755 },
    { path: `./usr/share/applications/${iconId}.desktop`, data: encoder.encode(desktopEntry({
      name: context.metadata.name, comment: context.metadata.description, exec: `/usr/bin/${pkg} %U`,
      icon: context.icon ? iconId : undefined, wmClass, categories: context.options.categories, mimeTypes: linuxMimeTypes(context),
    })) },
    ...(context.icon ? [{ path: `./usr/share/icons/hicolor/${context.icon.size}x${context.icon.size}/apps/${iconId}.png`, data: context.icon.png }] : []),
    ...linuxAssociationFiles(context, iconId).map(file => ({ ...file, path: `./usr/share/${file.path}` })),
  ];
  const declaresMime = files.some(file => file.path.startsWith("./usr/share/mime/"));
  const link: ArchiveEntry = { path: `./usr/bin/${pkg}`, type: "symlink", target: `/opt/${pkg}/${exe}`, mode: 0o777 };
  const data = [{ path: "./", type: "directory" as const }, ...directories([...files, link].map(file => file.path)).filter(dir => dir.path !== "./"), ...files, link];
  const installedSize = Math.ceil(files.reduce((total, file) => total + (file.data?.length ?? 0), 0) / 1024);
  const maintainer = context.options.maintainer ?? context.metadata.publisher ?? "Unknown <unknown@localhost>";
  const summary = (context.metadata.description ?? context.metadata.name).split(/\r?\n/)[0]!;
  const control = [
    `Package: ${pkg}`,
    `Version: ${version}`,
    `Architecture: ${arch}`,
    `Maintainer: ${maintainer.replace(/\r?\n/g, " ")}`,
    `Installed-Size: ${installedSize}`,
    "Section: utils",
    "Priority: optional",
    `Description: ${summary}`,
    ` ${context.metadata.name} (a Tarve application)${context.metadata.copyright ? `, ${context.metadata.copyright.replace(/\r?\n/g, " ")}` : ""}.`,
    "",
  ].join("\n");
  const md5sums = files.map(file => `${createHash("md5").update(file.data!).digest("hex")}  ${file.path.slice(2)}\n`).join("");
  const refresh = [
    "#!/bin/sh",
    "set -e",
    "command -v update-desktop-database >/dev/null 2>&1 && update-desktop-database -q /usr/share/applications || true",
    "command -v gtk-update-icon-cache >/dev/null 2>&1 && gtk-update-icon-cache -q -t -f /usr/share/icons/hicolor || true",
    ...(declaresMime ? ["command -v update-mime-database >/dev/null 2>&1 && update-mime-database /usr/share/mime || true"] : []),
    "",
  ].join("\n");
  const controlTar = createTarGz([
    { path: "./", type: "directory" },
    { path: "./control", data: encoder.encode(control) },
    { path: "./md5sums", data: encoder.encode(md5sums) },
    { path: "./postinst", data: encoder.encode(refresh), mode: 0o755 },
    { path: "./postrm", data: encoder.encode(refresh), mode: 0o755 },
  ], context.options.mtime);
  const deb = createAr([
    { name: "debian-binary", data: encoder.encode("2.0\n") },
    { name: "control.tar.gz", data: controlTar },
    { name: "data.tar.gz", data: createTarGz(data, context.options.mtime) },
  ], context.options.mtime);
  const path = join(context.outDir, `${pkg}_${version}_${arch}.deb`);
  writeFileSync(path, deb);
  return { format: "deb", path, note: `install: sudo apt install ./${basename(path)}` };
}

/** Linux .tar.gz: the executable, desktop entry, icon and install.sh (per-user, ~/.local). */
function packageTar(context: Context): PackageArtifact {
  if (context.info.platform === "darwin") throw new Error("--format tar is for Linux; package a macOS app with --format app-zip.");
  const { exe, pkg, wmClass, iconId } = linuxIds(context);
  const version = context.metadata.version;
  const root = version ? `${pkg}-${version}` : pkg;
  const platform = `${context.info.platform === "win32" ? "windows" : "linux"}-${context.info.arch}`;
  const iconPath = context.icon ? `icons/hicolor/${context.icon.size}x${context.icon.size}/apps/${iconId}.png` : undefined;
  const q = (value: string) => `'${value.replaceAll("'", `'\\''`)}'`;
  const associations = context.info.platform === "linux" ? linuxAssociationFiles(context, iconId) : [];
  const mimeXml = associations.find(file => file.path.startsWith("mime/"))?.path;
  const install = [
    "#!/bin/sh",
    `# Installs ${context.metadata.name.replace(/\r?\n/g, " ")} for the current user (~/.local). ./install.sh --uninstall removes it.`,
    "set -e",
    'here="$(cd "$(dirname "$0")" && pwd)"',
    'data="${XDG_DATA_HOME:-$HOME/.local/share}"',
    `app="$HOME/.local/opt/${pkg}"`,
    'bin="$HOME/.local/bin"',
    'if [ "$1" = "--uninstall" ]; then',
    `  rm -rf "$app" "$bin/${pkg}" "$data/applications/${iconId}.desktop"${iconPath ? ` "$data/${iconPath}"` : ""}${associations.map(file => ` "$data/${file.path}"`).join("")}`,
    ...(mimeXml ? ['  command -v update-mime-database >/dev/null 2>&1 && update-mime-database "$data/mime" || true'] : []),
    "  exit 0",
    "fi",
    `mkdir -p "$app" "$bin" "$data/applications"${iconPath ? ` "$data/${dirname(iconPath)}"` : ""}${[...new Set(associations.map(file => dirname(file.path)))].map(directory => ` "$data/${directory}"`).join("")}`,
    `cp "$here/"${q(exe)} "$app/"${q(exe)}`,
    `chmod 755 "$app/"${q(exe)}`,
    `ln -sf "$app/"${q(exe)} "$bin/${pkg}"`,
    ...(iconPath ? [`cp "$here/${iconId}.png" "$data/${iconPath}"`] : []),
    ...associations.map(file => `cp "$here/share/${file.path}" "$data/${file.path}"`),
    ...(mimeXml ? ['command -v update-mime-database >/dev/null 2>&1 && update-mime-database "$data/mime" || true'] : []),
    `sed "s|^Exec=.*|Exec=\\"$app/${exe.replaceAll('"', "").replaceAll("|", "")}\\" %U|" "$here/${iconId}.desktop" > "$data/applications/${iconId}.desktop"`,
    'command -v update-desktop-database >/dev/null 2>&1 && update-desktop-database -q "$data/applications" || true',
    `echo "Installed to $app (run: ${pkg})"`,
    "",
  ].join("\n");
  const entries: ArchiveEntry[] = [
    { path: `${root}/`, type: "directory" },
    { path: `${root}/${exe}`, data: context.bytes, mode: 0o755 },
    ...(context.info.platform === "linux" ? [
      { path: `${root}/${iconId}.desktop`, data: encoder.encode(desktopEntry({
        name: context.metadata.name, comment: context.metadata.description, exec: `${pkg} %U`,
        icon: context.icon ? iconId : undefined, wmClass, categories: context.options.categories, mimeTypes: linuxMimeTypes(context),
      })) },
      ...(context.icon ? [{ path: `${root}/${iconId}.png`, data: context.icon.png }] : []),
      ...associations.map(file => ({ ...file, path: `${root}/share/${file.path}` })),
      { path: `${root}/install.sh`, data: encoder.encode(install), mode: 0o755 },
    ] : []),
  ];
  const path = join(context.outDir, `${root}-${platform}.tar.gz`);
  writeFileSync(path, createTarGz(entries, context.options.mtime));
  return { format: "tar", path, note: context.info.platform === "linux" ? "install: tar xzf, then ./install.sh (per-user, ~/.local)" : undefined };
}

/** Portable .zip: one folder with the executable (and the icon). */
function packageZip(context: Context): PackageArtifact {
  if (context.info.platform === "darwin") throw new Error("--format zip is for Windows and Linux executables; package a macOS app with --format app-zip.");
  const exe = basename(context.executable);
  const root = fileSlug(context.metadata.version ? `${context.metadata.name}-${context.metadata.version}` : context.metadata.name);
  const platform = `${context.info.platform === "win32" ? "windows" : "linux"}-${context.info.arch}`;
  const path = join(context.outDir, `${root}-${platform}.zip`);
  writeFileSync(path, createZip([
    { path: `${root}/`, type: "directory" },
    { path: `${root}/${exe}`, data: context.bytes, mode: 0o755 },
  ], context.options.mtime));
  return { format: "zip", path };
}

/** A solid square placeholder logo, for MSIX packages of apps without an icon. */
function placeholderLogo(size: number): Uint8Array {
  const rgba = new Uint8Array(size * size * 4);
  for (let index = 0; index < rgba.length; index += 4) rgba.set([0x2b, 0x57, 0x9a, 0xff], index);
  return encodePng(rgba, size, size);
}

function logo(context: Context, size: number): Uint8Array {
  if (!context.icon) return placeholderLogo(size);
  return encodePng(resizeSquare(decodePng(context.icon.png), size), size, size);
}

/** The MSIX AppxManifest.xml for a full-trust desktop app. */
export function appxManifest(fields: { identity: string; publisher: string; publisherDisplayName: string; version: string; arch: "x64" | "arm64"; displayName: string; description: string; executable: string; applicationId: string; protocols?: readonly string[]; fileTypes?: readonly (FileTypeAssociation & { logo?: string })[] }): string {
  return `<?xml version="1.0" encoding="utf-8"?>
<Package xmlns="http://schemas.microsoft.com/appx/manifest/foundation/windows10"
  xmlns:uap="http://schemas.microsoft.com/appx/manifest/uap/windows10"
  xmlns:rescap="http://schemas.microsoft.com/appx/manifest/foundation/windows10/restrictedcapabilities"
  IgnorableNamespaces="uap rescap">
  <Identity Name="${xml(fields.identity)}" Publisher="${xml(fields.publisher)}" Version="${fields.version}" ProcessorArchitecture="${fields.arch}" />
  <Properties>
    <DisplayName>${xml(fields.displayName)}</DisplayName>
    <PublisherDisplayName>${xml(fields.publisherDisplayName)}</PublisherDisplayName>
    <Logo>Assets\\StoreLogo.png</Logo>
  </Properties>
  <Dependencies>
    <TargetDeviceFamily Name="Windows.Desktop" MinVersion="10.0.17763.0" MaxVersionTested="10.0.26100.0" />
  </Dependencies>
  <Resources>
    <Resource Language="en-us" />
  </Resources>
  <Applications>
    <Application Id="${xml(fields.applicationId)}" Executable="${xml(fields.executable)}" EntryPoint="Windows.FullTrustApplication">
      <uap:VisualElements DisplayName="${xml(fields.displayName)}" Description="${xml(fields.description)}" BackgroundColor="transparent"
        Square150x150Logo="Assets\\Square150x150Logo.png" Square44x44Logo="Assets\\Square44x44Logo.png" />
${msixExtensions(fields.protocols, fields.fileTypes)}    </Application>
  </Applications>
  <Capabilities>
    <rescap:Capability Name="runFullTrust" />
  </Capabilities>
</Package>
`;
}

/** makeappx.exe: the option, TARVE_MAKEAPPX, PATH, then the newest Windows 10/11 SDK. */
export function findMakeAppx(explicit?: string | false): string | undefined {
  if (explicit === false) return undefined;
  if (explicit) return explicit;
  if (process.env.TARVE_MAKEAPPX) return process.env.TARVE_MAKEAPPX;
  if (process.platform !== "win32") return undefined;
  for (const directory of (process.env.PATH ?? "").split(";")) {
    if (directory && existsSync(join(directory, "makeappx.exe"))) return join(directory, "makeappx.exe");
  }
  const kits = join(process.env["ProgramFiles(x86)"] ?? "C:\\Program Files (x86)", "Windows Kits", "10", "bin");
  if (!existsSync(kits)) return undefined;
  const versions = readdirSync(kits).filter(name => /^\d+\./.test(name))
    .sort((a, b) => b.localeCompare(a, undefined, { numeric: true }));
  for (const version of versions) {
    const candidate = join(kits, version, "x64", "makeappx.exe");
    if (existsSync(candidate)) return candidate;
  }
  return undefined;
}

/** MSIX: the package folder (AppxManifest.xml, logos, executable), packed by makeappx when available. */
function packageMsix(context: Context): PackageArtifact {
  if (context.info.platform !== "win32") throw new Error("--format msix needs a Windows executable (tarve build --target windows-x64).");
  const { metadata } = context;
  const version = msixVersion(requireVersion(metadata, "msix"));
  const exe = basename(context.executable);
  const identity = (metadata.appId ?? metadata.name).replace(/[^A-Za-z0-9.-]+/g, "-").replace(/^[-.]+|[-.]+$/g, "").slice(0, 50).padEnd(3, "0");
  const publisherName = metadata.publisher ?? "Unknown";
  const publisher = /^[A-Za-z]+\s*=/.test(publisherName) ? publisherName : `CN=${/[,+="<>#;]/.test(publisherName) ? `"${publisherName.replaceAll('"', "")}"` : publisherName}`;
  const applicationId = (metadata.name.replace(/[^A-Za-z0-9.]+/g, "").replace(/^[^A-Za-z]+/, "") || "App").slice(0, 64);
  const root = fileSlug(`${metadata.name}-${metadata.version}`);
  const folder = join(context.outDir, `${root}-msix`);
  rmSync(folder, { recursive: true, force: true });
  mkdirSync(join(folder, "Assets"), { recursive: true });
  writeFileSync(join(folder, exe), context.bytes);
  writeFileSync(join(folder, "Assets", "StoreLogo.png"), logo(context, 50));
  writeFileSync(join(folder, "Assets", "Square44x44Logo.png"), logo(context, 44));
  writeFileSync(join(folder, "Assets", "Square150x150Logo.png"), logo(context, 150));
  const fileTypes = context.associations.fileTypes.map(type => {
    const icon = typeIcon(type, 44);
    if (!icon) return type;
    const name = `FileType-${normalizeExtension(type.ext).replace(/[^a-z0-9]/g, "-")}.png`;
    writeFileSync(join(folder, "Assets", name), icon.png);
    return { ...type, logo: `Assets\\${name}` };
  });
  writeFileSync(join(folder, "AppxManifest.xml"), appxManifest({
    identity, publisher, publisherDisplayName: publisherName.replace(/^CN=/i, ""), version, arch: context.info.arch === "arm64" ? "arm64" : "x64",
    displayName: metadata.name, description: metadata.description ?? metadata.name, executable: exe, applicationId,
    protocols: context.associations.protocols, fileTypes,
  }));
  const signing = `sign with: signtool sign /fd SHA256 /a /f cert.pfx /p <password> <file>.msix (the certificate subject must be exactly ${publisher})`;
  const makeappx = findMakeAppx(context.options.makeappx);
  if (!makeappx) {
    return {
      format: "msix", path: folder, packed: false,
      note: `makeappx was not found (Windows SDK; or set TARVE_MAKEAPPX). Pack it with: makeappx pack /o /d "${folder}" /p "${folder.replace(/-msix$/, "")}-${context.info.arch}.msix", then ${signing}`,
    };
  }
  const path = join(context.outDir, `${root}-${context.info.arch}.msix`);
  const result = spawnSync(makeappx, ["pack", "/o", "/d", folder, "/p", path], { encoding: "utf8" });
  if (result.error || result.status !== 0) {
    throw new Error(`makeappx failed (${makeappx}): ${result.error?.message ?? (result.stdout + result.stderr).trim()}`);
  }
  return { format: "msix", path, packed: true, note: `unsigned; ${signing}` };
}

/**
 * A zipped macOS .app (`<name>-<version>-macos-<arch>.zip`): what users unzip into /Applications,
 * notarytool takes and Tarve updates install. Sign and notarize on a Mac (tarve release --sign).
 */
function packageAppZip(context: Context): PackageArtifact {
  if (context.info.platform !== "darwin" || !/\.app$/i.test(context.executable)) {
    throw new Error("--format app-zip needs a macOS .app bundle (tarve build --target darwin-arm64).");
  }
  const root = fileSlug(context.metadata.version ? `${context.metadata.name}-${context.metadata.version}` : context.metadata.name);
  const path = join(context.outDir, `${root}-macos-${context.info.arch}.zip`);
  writeFileSync(path, createZip(macAppZipEntries(context.executable), context.options.mtime));
  return {
    format: "app-zip", path,
    note: "unsigned: Gatekeeper blocks it on other Macs until it is signed and notarized (tarve release --sign on macOS).",
  };
}

function pngSize(png: Uint8Array): number {
  return new DataView(png.buffer, png.byteOffset, png.byteLength).getUint32(16);
}

/** Packages a built executable into each requested format; returns the written files. */
export function packageApp(options: PackageOptions): PackageArtifact[] {
  const executable = resolve(options.executable);
  if (!existsSync(executable)) throw new Error(`Executable not found: ${executable}. Build it first with tarve build.`);
  const info = executableInfo(executable);
  const bundle = statSync(executable).isDirectory() ? readMacAppBundle(executable) : undefined;
  const metadata = resolveAppMetadata(options.entrypoint ?? executable, {
    name: options.name, version: options.version, description: options.description, publisher: options.publisher,
    copyright: options.copyright, icon: options.icon, appId: options.appId,
  });
  const formats = options.format === undefined
    ? (info.platform === "linux" ? ["deb", "tar"] as PackageFormat[] : info.platform === "darwin" ? ["app-zip"] as PackageFormat[] : ["zip"] as PackageFormat[])
    : typeof options.format === "string" ? [options.format] : [...options.format];
  for (const format of formats) if (!isPackageFormat(format)) throw new Error(`Unsupported package format: ${String(format)}. Expected ${PACKAGE_FORMATS.join(", ")}.`);
  const outDir = resolve(options.outDir ?? dirname(executable));
  mkdirSync(outDir, { recursive: true });
  const png = metadata.icon ? appIconImages(metadata.icon).png : undefined;
  const context: Context = {
    executable, bytes: new Uint8Array(readFileSync(bundle?.executable ?? executable)), info, metadata, outDir, options,
    icon: png ? { png, size: pngSize(png) } : undefined,
    associations: resolveAppAssociations(options.entrypoint ?? executable, { protocols: options.protocols ? [...options.protocols] : undefined, fileTypes: options.fileTypes ? [...options.fileTypes] : undefined }),
  };
  const writers: Record<PackageFormat, (context: Context) => PackageArtifact> = { deb: packageDeb, tar: packageTar, zip: packageZip, msix: packageMsix, "app-zip": packageAppZip };
  return formats.map(format => writers[format](context));
}
