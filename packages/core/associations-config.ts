// The deep links and file types an app declares for its packages (`tarve package`,
// `tarve build --target android`): package.json `tarve.protocols` / `tarve.fileTypes`
// (and `tarve.apps["<entry>"]` for one entry of a multi-app package), plus CLI flags.
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileTypeMime, normalizeExtension, normalizeScheme, type FileTypeAssociation } from "./src/associations";

export type { FileTypeAssociation } from "./src/associations";

export interface AppAssociations {
  protocols: string[];
  fileTypes: FileTypeAssociation[];
}

function readTypes(value: unknown, where: string, root: string): FileTypeAssociation[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) throw new TypeError(`${where} must be an array of { ext, name, icon?, mime? }`);
  return value.map((item, index) => {
    const type = item as Partial<FileTypeAssociation>;
    if (!type || typeof type.ext !== "string" || typeof type.name !== "string" || !type.name.trim()) {
      throw new TypeError(`${where}[${index}] needs "ext" and "name" strings`);
    }
    for (const key of ["icon", "mime"] as const) {
      if (type[key] !== undefined && typeof type[key] !== "string") throw new TypeError(`${where}[${index}].${key} must be a string`);
    }
    const out: FileTypeAssociation = { ext: normalizeExtension(type.ext), name: type.name.trim() };
    if (type.icon) out.icon = resolve(root, type.icon);
    if (type.mime) out.mime = type.mime;
    fileTypeMime(out);
    return out;
  });
}

function readProtocols(value: unknown, where: string): string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.some(item => typeof item !== "string")) throw new TypeError(`${where} must be an array of URL schemes`);
  return (value as string[]).map(normalizeScheme);
}

/** `--file-type tarvenote=Tarve note` (`ext=Name`, the name defaulting to the extension). */
export function parseFileTypeFlag(value: string): FileTypeAssociation {
  const [ext = "", ...rest] = value.split("=");
  const name = rest.join("=").trim();
  const normalized = normalizeExtension(ext);
  return { ext: normalized, name: name || `${normalized.toUpperCase()} file` };
}

/** The app's protocols and file types: package.json, then `overrides` (flags) added on top. */
export function resolveAppAssociations(entrypoint: string, overrides: Partial<AppAssociations> = {}): AppAssociations {
  const entry = resolve(entrypoint);
  const protocols: string[] = [];
  const fileTypes: FileTypeAssociation[] = [];
  for (let directory = dirname(entry); ; directory = dirname(directory)) {
    const path = join(directory, "package.json");
    if (existsSync(path)) {
      const tarve = (JSON.parse(readFileSync(path, "utf8")) as { tarve?: Record<string, unknown> }).tarve;
      const key = relative(directory, entry).replaceAll("\\", "/");
      const apps = tarve?.apps as Record<string, Record<string, unknown>> | undefined;
      const own = apps?.[key] ?? apps?.["./" + key];
      protocols.push(...readProtocols(tarve?.protocols, "package.json tarve.protocols"), ...readProtocols(own?.protocols, `package.json tarve.apps["${key}"].protocols`));
      fileTypes.push(...readTypes(tarve?.fileTypes, "package.json tarve.fileTypes", directory), ...readTypes(own?.fileTypes, `package.json tarve.apps["${key}"].fileTypes`, directory));
      break;
    }
    if (dirname(directory) === directory) break;
  }
  protocols.push(...(overrides.protocols ?? []).map(normalizeScheme));
  fileTypes.push(...readTypes(overrides.fileTypes ?? [], "fileTypes", process.cwd()));
  const byExt = new Map<string, FileTypeAssociation>();
  for (const type of fileTypes) byExt.set(type.ext, type);
  return { protocols: [...new Set(protocols)], fileTypes: [...byExt.values()] };
}
