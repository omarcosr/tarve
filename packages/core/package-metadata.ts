import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, dirname, extname, join, relative, resolve } from "node:path";
import { decodePng, encodeIco, encodePng, isIco, isPng, largestIcoPng, resizeSquare } from "./src/png";

/**
 * What a Tarve app is called and how it looks to the OS: the executable's
 * version resource and icon, the window and taskbar icon, the Windows app
 * identity (media controls, notifications) and the Linux desktop entry.
 */
export interface AppMetadata {
  name: string;
  version?: string;
  description?: string;
  publisher?: string;
  copyright?: string;
  /** Absolute path to a .png (square, ideally 256 px or more) or .ico. */
  icon?: string;
  /** Windows AppUserModelID / Linux app id, e.g. `Acme.Notes`. */
  appId?: string;
}

export type AppMetadataOverrides = Partial<AppMetadata>;

const FIELDS = ["name", "version", "description", "publisher", "copyright", "icon", "appId"] as const;
type Fields = Partial<Record<typeof FIELDS[number], string>>;

function fields(value: unknown, where: string): Fields {
  if (value === undefined) return {};
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new TypeError(`${where} must be an object`);
  const out: Fields = {};
  for (const key of FIELDS) {
    const field = (value as Record<string, unknown>)[key];
    if (field === undefined) continue;
    if (typeof field !== "string" || !field.trim()) throw new TypeError(`${where}.${key} must be a non-empty string`);
    out[key] = field.trim();
  }
  return out;
}

function author(value: unknown): string | undefined {
  if (typeof value === "string") return value.replace(/\s*[<(].*$/, "").trim() || undefined;
  if (value && typeof value === "object" && typeof (value as { name?: unknown }).name === "string") return (value as { name: string }).name;
  return undefined;
}

/** Same rule the Windows shell applies to AppUserModelIDs. */
export function validAppId(id: string): boolean {
  return id.length > 0 && id.length <= 128 && !/[\s\\]/.test(id);
}

/**
 * Reads the `tarve` field of the package.json nearest the entrypoint
 * (`tarve.apps["<entry path>"]` overrides it for one entrypoint of a
 * multi-app package), then applies `overrides` (CLI flags). Without a
 * `tarve` field the app is named after its entry file, as before.
 */
export function resolveAppMetadata(entrypoint: string, overrides: AppMetadataOverrides = {}): AppMetadata {
  const entry = resolve(entrypoint);
  let directory = dirname(entry);
  let manifest: Record<string, unknown> | undefined;
  let root = directory;
  for (;;) {
    const path = join(directory, "package.json");
    if (existsSync(path)) {
      manifest = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
      root = directory;
      break;
    }
    const parent = dirname(directory);
    if (parent === directory) break;
    directory = parent;
  }
  const tarve = manifest?.tarve as Record<string, unknown> | undefined;
  const shared = fields(tarve === undefined ? undefined : Object.fromEntries(Object.entries(tarve).filter(([key]) => key !== "apps")), "package.json tarve");
  const apps = tarve?.apps as Record<string, unknown> | undefined;
  const key = relative(root, entry).replaceAll("\\", "/");
  const own = fields(apps?.[key] ?? apps?.["./" + key], `package.json tarve.apps["${key}"]`);
  const fromPackage: Fields = tarve === undefined ? {} : {
    ...(typeof manifest?.version === "string" ? { version: manifest.version } : {}),
    ...(typeof manifest?.description === "string" ? { description: manifest.description } : {}),
    ...(author(manifest?.author) ? { publisher: author(manifest?.author)! } : {}),
  };
  // Paths in package.json are relative to it; CLI paths to the working directory.
  const configured = { ...fromPackage, ...shared, ...own };
  if (configured.icon) configured.icon = resolve(root, configured.icon);
  const flags = fields(Object.fromEntries(Object.entries(overrides).filter(([, value]) => value !== undefined)), "option");
  if (flags.icon) flags.icon = resolve(flags.icon);
  const merged = { ...configured, ...flags };
  const metadata: AppMetadata = { name: merged.name ?? basename(entry).replace(/\.[^.]+$/, "") };
  for (const field of FIELDS) if (field !== "name" && merged[field] !== undefined) metadata[field] = merged[field];
  if (metadata.appId !== undefined && !validAppId(metadata.appId)) {
    throw new TypeError(`appId must be 1-128 characters without spaces or backslashes: ${metadata.appId}`);
  }
  if (metadata.icon !== undefined) {
    if (!existsSync(metadata.icon)) throw new Error(`App icon not found: ${metadata.icon}`);
    if (![".png", ".ico"].includes(extname(metadata.icon).toLowerCase())) throw new TypeError(`App icon must be a .png or .ico file: ${metadata.icon}`);
  }
  return metadata;
}

export interface AppIconImages {
  /** Multi-size .ico (16–256 px) for the Windows executable. */
  ico: Uint8Array;
  /** The largest square PNG (at most 256 px), for the window icon and Linux. */
  png: Uint8Array;
}

const ICO_SIZES = [16, 20, 24, 32, 40, 48, 64, 96, 128, 256];

/** Converts an app icon to every form a build needs. An .ico is used as it is. */
export function appIconImages(path: string): AppIconImages {
  const bytes = new Uint8Array(readFileSync(path));
  if (isIco(bytes)) {
    const png = largestIcoPng(bytes);
    if (!png) throw new Error(`${path} has no PNG-compressed image; Linux builds and the window icon need one. Use a .png icon instead.`);
    return { ico: bytes, png };
  }
  if (!isPng(bytes)) throw new TypeError(`${path} is not a PNG or ICO file`);
  let image;
  try {
    image = decodePng(bytes);
  } catch (error) {
    throw new Error(`App icon ${path}: ${error instanceof Error ? error.message : String(error)}`);
  }
  const side = Math.max(image.width, image.height);
  const sizes = ICO_SIZES.filter(size => size <= side);
  if (!sizes.length) sizes.push(16);
  const entries = sizes.map(size => ({ size, png: encodePng(resizeSquare(image, size), size, size) }));
  return { ico: encodeIco(entries), png: entries.at(-1)!.png };
}

export interface BuildMetadata {
  metadata: AppMetadata;
  images?: AppIconImages;
  /** `process.env.TARVE_APP_METADATA` for the bundler's define. */
  define: Record<string, string>;
}

/** Metadata, icon images and the runtime define for `tarve build` (Bun and Node alike). */
export function buildMetadata(entrypoint: string, overrides: AppMetadataOverrides): BuildMetadata {
  const metadata = resolveAppMetadata(entrypoint, overrides);
  const images = metadata.icon ? appIconImages(metadata.icon) : undefined;
  const icon = images ? `data:image/png;base64,${Buffer.from(images.png).toString("base64")}` : undefined;
  return { metadata, images, define: { "process.env.TARVE_APP_METADATA": JSON.stringify(runtimeMetadata(metadata, icon)) } };
}

/** The metadata an app reads at run time (see src/app-metadata.ts), as a JSON string. */
export function runtimeMetadata(metadata: AppMetadata, icon: string | undefined): string {
  return JSON.stringify({
    name: metadata.name,
    ...(metadata.version ? { version: metadata.version } : {}),
    ...(metadata.appId ? { appId: metadata.appId } : {}),
    ...(icon ? { icon } : {}),
  });
}

/**
 * Linux, when the app has an icon or id: a freedesktop entry and its icon next to the executable. Copy them to
 * ~/.local/share/applications and ~/.local/share/icons/hicolor/256x256/apps to install.
 */
export function writeLinuxDesktopEntry(outfile: string, metadata: AppMetadata, png: Uint8Array | undefined): string {
  const id = metadata.appId ?? basename(outfile);
  const escape = (value: string) => value.replace(/[\\\n\r\t]/g, match => ({ "\\": "\\\\", "\n": "\\n", "\r": "\\r", "\t": "\\t" })[match]!);
  const lines = [
    "[Desktop Entry]",
    "Type=Application",
    `Name=${escape(metadata.name)}`,
    ...(metadata.description ? [`Comment=${escape(metadata.description)}`] : []),
    `Exec="${outfile.replaceAll('"', '\\"')}" %U`,
    ...(png ? [`Icon=${id}`] : []),
    `StartupWMClass=${id}`,
    "Terminal=false",
    "",
  ];
  mkdirSync(dirname(outfile), { recursive: true });
  const desktop = join(dirname(outfile), `${id}.desktop`);
  writeFileSync(desktop, lines.join("\n"));
  if (png) writeFileSync(join(dirname(outfile), `${id}.png`), png);
  return desktop;
}
