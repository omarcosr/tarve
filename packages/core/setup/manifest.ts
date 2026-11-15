// What `tarve package --format setup` bakes into a Windows installer, and the `tarve.installer`
// field of package.json it is read from. Shared by the packager (setup-build.ts) and the
// installer app (setup/app.tsx); node: modules only, so it runs in Bun, Node.js and txiki.js.
import type { FileTypeAssociation } from "../src/associations";

/** A wizard text in one language, or per language (`{ "en": "…", "pt-BR": "…" }`). */
export type Localized = string | Readonly<Record<string, string>>;

/** The languages the installer speaks on its own. An app can add strings for others. */
export const SETUP_LANGUAGES = ["en", "pt-BR"] as const;

/** A built-in choice of the wizard: shown or not, and its default. */
export interface SetupToggle {
  enabled: boolean;
  default: boolean;
  label?: Localized;
  description?: Localized;
}

/** An app-defined choice: a checkbox whose `command` runs the installed app when it is checked. */
export interface SetupCustomOption {
  id: string;
  label: Localized;
  description?: Localized;
  default: boolean;
  /** Arguments the installed executable is run with after the install when the option is checked. */
  command?: string[];
  /** Arguments it is run with (before the files go) on uninstall, when the option was checked at install time. */
  undo?: string[];
}

export interface SetupOptions {
  /** The "choose a folder" page (default true). */
  directory: boolean;
  /** The language picker on the first page (default true with two languages or more). */
  language: boolean;
  desktopShortcut: SetupToggle;
  /**
   * "Start with Windows": a Run entry under HKCU with `args`, or, with `command`, the installed
   * app run with those arguments (an app that manages its own startup task). Hidden by default.
   */
  startup: SetupToggle & { args: string[]; command?: string[]; undo?: string[] };
  /** "Open <app> when done": the app is started with `args` after the install (default on). */
  launch: SetupToggle & { args: string[] };
  custom: SetupCustomOption[];
}

/**
 * Commands the app's own executable runs at fixed points, each a list of argument lists run in
 * order (`[["--stop", "--wait"], ["--remove-startup"]]`). package.json may give one argument list
 * for a single command. A non-zero exit stops the install or uninstall.
 */
export interface SetupHooks {
  /** Run by the new executable (extracted to a temporary folder) before files are copied: stop a running instance, migrate settings. */
  beforeInstall?: string[][];
  /** Run by the installed executable after files, shortcuts and registry entries are in place. */
  afterInstall?: string[][];
  /** Run by the installed executable before it is removed. */
  beforeUninstall?: string[][];
}

/** A hook as package.json writes it: one argument list, or several. */
export type SetupHookConfig = readonly string[] | readonly (readonly string[])[];

/** Traces of an earlier installer of the same app (Inno Setup, NSIS) the setup removes when it installs over it. */
export interface SetupPrevious {
  /** Keys under HKCU\…\Uninstall (and HKLM, when writable) to delete, e.g. `Acme.Notes_is1`. */
  uninstallKeys: string[];
  /** Files in the install folder to delete, e.g. `unins000.exe`. */
  files: string[];
  /** Start menu shortcuts (`Old Name.lnk`) to delete. */
  shortcuts: string[];
}

/** Everything the installer executable knows about the app it installs. */
export interface SetupManifest {
  name: string;
  version: string;
  /** Registry key of the uninstall entry, AppUserModelID of the shortcuts, name of the Run value. */
  appId: string;
  publisher?: string;
  description?: string;
  homepage?: string;
  /** File name of the executable in the install folder. */
  executable: string;
  /** Folder name under %LOCALAPPDATA%\Programs (the default install folder). */
  directory: string;
  /** Start menu / desktop shortcut name. */
  shortcutName: string;
  languages: string[];
  options: SetupOptions;
  hooks: SetupHooks;
  previous: SetupPrevious;
  protocols: string[];
  fileTypes: FileTypeAssociation[];
  /** Wizard texts the app overrides or adds, per language then key (see setup/strings.ts). */
  strings: Record<string, Record<string, string>>;
  /** Theme colour of the wizard (`#RRGGBB`); default the Tarve theme's primary. */
  accent?: string;
  /** Size of the installed executable in bytes (the uninstall entry's EstimatedSize). */
  size: number;
  /** Whether the app has an icon the wizard shows (embedded beside the payload). */
  icon: boolean;
}

/** The `tarve.installer` field as written in package.json (every part optional). */
export interface InstallerConfig {
  directory?: string;
  shortcutName?: string;
  languages?: readonly string[];
  homepage?: string;
  accent?: string;
  options?: {
    directory?: boolean;
    language?: boolean;
    desktopShortcut?: boolean | Partial<SetupToggle>;
    startup?: boolean | (Partial<SetupToggle> & { args?: readonly string[]; command?: readonly string[]; undo?: readonly string[] });
    launch?: boolean | (Partial<SetupToggle> & { args?: readonly string[] });
    custom?: readonly (Omit<SetupCustomOption, "default"> & { default?: boolean })[];
  };
  hooks?: Partial<Record<keyof SetupHooks, SetupHookConfig>>;
  previous?: Partial<SetupPrevious>;
  strings?: Readonly<Record<string, Readonly<Record<string, string>>>>;
}

const OPTION_ID = /^[a-z][a-z0-9-]*$/i;

function expectObject(value: unknown, where: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new TypeError(`${where} must be an object`);
  return value as Record<string, unknown>;
}

function optionalString(value: unknown, where: string): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string" || !value.trim()) throw new TypeError(`${where} must be a non-empty string`);
  return value.trim();
}

function optionalBoolean(value: unknown, where: string): boolean | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "boolean") throw new TypeError(`${where} must be true or false`);
  return value;
}

function stringList(value: unknown, where: string): string[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.some(item => typeof item !== "string")) throw new TypeError(`${where} must be an array of strings`);
  return [...value as string[]];
}

function localized(value: unknown, where: string): Localized | undefined {
  if (value === undefined) return undefined;
  if (typeof value === "string") return value;
  const object = expectObject(value, where);
  for (const [language, text] of Object.entries(object)) if (typeof text !== "string") throw new TypeError(`${where}.${language} must be a string`);
  return object as Record<string, string>;
}

function toggle(value: unknown, where: string, defaults: SetupToggle): SetupToggle {
  if (value === undefined) return defaults;
  if (typeof value === "boolean") return { ...defaults, enabled: value };
  const object = expectObject(value, where);
  return {
    enabled: optionalBoolean(object.enabled, `${where}.enabled`) ?? true,
    default: optionalBoolean(object.default, `${where}.default`) ?? defaults.default,
    ...(localized(object.label, `${where}.label`) !== undefined ? { label: localized(object.label, `${where}.label`) } : {}),
    ...(localized(object.description, `${where}.description`) !== undefined ? { description: localized(object.description, `${where}.description`) } : {}),
  };
}

/** Validates a `tarve.installer` value and fills the defaults in. */
export function parseInstallerConfig(value: unknown): Required<Pick<InstallerConfig, "languages" | "strings">> & { options: SetupOptions; hooks: SetupHooks; previous: SetupPrevious } & Omit<InstallerConfig, "options" | "hooks" | "previous" | "languages" | "strings"> {
  const config = value === undefined ? {} : expectObject(value, "tarve.installer");
  const options = config.options === undefined ? {} : expectObject(config.options, "tarve.installer.options");
  const languages = stringList(config.languages, "tarve.installer.languages") ?? [...SETUP_LANGUAGES];
  if (!languages.length) throw new TypeError("tarve.installer.languages must name at least one language");
  const strings: Record<string, Record<string, string>> = {};
  if (config.strings !== undefined) {
    for (const [language, texts] of Object.entries(expectObject(config.strings, "tarve.installer.strings"))) {
      const table = expectObject(texts, `tarve.installer.strings.${language}`);
      for (const [key, text] of Object.entries(table)) if (typeof text !== "string") throw new TypeError(`tarve.installer.strings.${language}.${key} must be a string`);
      strings[language] = { ...table as Record<string, string> };
    }
  }
  for (const language of languages) {
    if (!(SETUP_LANGUAGES as readonly string[]).includes(language) && !strings[language]) {
      throw new TypeError(`tarve.installer.languages: "${language}" needs its texts in tarve.installer.strings["${language}"] (the installer speaks ${SETUP_LANGUAGES.join(" and ")})`);
    }
  }
  const startupValue = typeof options.startup === "boolean" ? {} : options.startup === undefined ? {} : expectObject(options.startup, "tarve.installer.options.startup");
  const launchValue = typeof options.launch === "boolean" ? {} : options.launch === undefined ? {} : expectObject(options.launch, "tarve.installer.options.launch");
  const custom = (options.custom === undefined ? [] : (Array.isArray(options.custom) ? options.custom : (() => { throw new TypeError("tarve.installer.options.custom must be an array"); })())).map((item: unknown, index: number): SetupCustomOption => {
    const where = `tarve.installer.options.custom[${index}]`;
    const object = expectObject(item, where);
    const id = optionalString(object.id, `${where}.id`);
    if (!id || !OPTION_ID.test(id)) throw new TypeError(`${where}.id must be letters, digits and dashes, starting with a letter`);
    const label = localized(object.label, `${where}.label`);
    if (label === undefined) throw new TypeError(`${where}.label is required`);
    const description = localized(object.description, `${where}.description`);
    return {
      id, label, default: optionalBoolean(object.default, `${where}.default`) ?? false,
      ...(description !== undefined ? { description } : {}),
      ...(stringList(object.command, `${where}.command`) ? { command: stringList(object.command, `${where}.command`) } : {}),
      ...(stringList(object.undo, `${where}.undo`) ? { undo: stringList(object.undo, `${where}.undo`) } : {}),
    };
  });
  const ids = new Set<string>();
  for (const option of custom) {
    if (ids.has(option.id)) throw new TypeError(`tarve.installer.options.custom: option "${option.id}" is listed twice`);
    ids.add(option.id);
  }
  const hooks = config.hooks === undefined ? {} : expectObject(config.hooks, "tarve.installer.hooks");
  const previous = config.previous === undefined ? {} : expectObject(config.previous, "tarve.installer.previous");
  const hookList = (key: keyof SetupHooks): string[][] | undefined => {
    const value = hooks[key];
    if (value === undefined) return undefined;
    const where = `tarve.installer.hooks.${key}`;
    if (Array.isArray(value) && value.every(item => typeof item === "string")) return [[...value as string[]]];
    if (Array.isArray(value) && value.every(item => Array.isArray(item) && item.every(part => typeof part === "string"))) return (value as string[][]).map(item => [...item]);
    throw new TypeError(`${where} must be an argument list (["--stop"]) or a list of them ([["--stop"], ["--migrate"]])`);
  };
  return {
    directory: optionalString(config.directory, "tarve.installer.directory"),
    shortcutName: optionalString(config.shortcutName, "tarve.installer.shortcutName"),
    homepage: optionalString(config.homepage, "tarve.installer.homepage"),
    accent: optionalString(config.accent, "tarve.installer.accent"),
    languages,
    strings,
    options: {
      directory: optionalBoolean(options.directory, "tarve.installer.options.directory") ?? true,
      language: optionalBoolean(options.language, "tarve.installer.options.language") ?? languages.length > 1,
      desktopShortcut: toggle(options.desktopShortcut, "tarve.installer.options.desktopShortcut", { enabled: true, default: true }),
      startup: {
        ...toggle(options.startup, "tarve.installer.options.startup", { enabled: false, default: false }),
        args: stringList(startupValue.args, "tarve.installer.options.startup.args") ?? [],
        ...(stringList(startupValue.command, "tarve.installer.options.startup.command") ? { command: stringList(startupValue.command, "tarve.installer.options.startup.command") } : {}),
        ...(stringList(startupValue.undo, "tarve.installer.options.startup.undo") ? { undo: stringList(startupValue.undo, "tarve.installer.options.startup.undo") } : {}),
      },
      launch: {
        ...toggle(options.launch, "tarve.installer.options.launch", { enabled: true, default: true }),
        args: stringList(launchValue.args, "tarve.installer.options.launch.args") ?? [],
      },
      custom,
    },
    hooks: {
      ...(hookList("beforeInstall") ? { beforeInstall: hookList("beforeInstall") } : {}),
      ...(hookList("afterInstall") ? { afterInstall: hookList("afterInstall") } : {}),
      ...(hookList("beforeUninstall") ? { beforeUninstall: hookList("beforeUninstall") } : {}),
    },
    previous: {
      uninstallKeys: stringList(previous.uninstallKeys, "tarve.installer.previous.uninstallKeys") ?? [],
      files: stringList(previous.files, "tarve.installer.previous.files") ?? [],
      shortcuts: stringList(previous.shortcuts, "tarve.installer.previous.shortcuts") ?? [],
    },
  };
}

/** A manifest written as JSON and read back: the shape the installer validates at start. */
export function parseSetupManifest(value: unknown): SetupManifest {
  const object = expectObject(value, "setup manifest");
  for (const key of ["name", "version", "appId", "executable", "directory", "shortcutName"] as const) {
    if (typeof object[key] !== "string" || !(object[key] as string).length) throw new TypeError(`setup manifest: ${key} is missing`);
  }
  if (!Array.isArray(object.languages) || !object.languages.length) throw new TypeError("setup manifest: languages are missing");
  return object as unknown as SetupManifest;
}

/** The text of a `Localized` value in `language`, falling back to English, then to any language. */
export function localizedText(value: Localized | undefined, language: string): string | undefined {
  if (value === undefined || typeof value === "string") return value;
  return value[language] ?? value[language.split("-")[0]!] ?? value.en ?? Object.values(value)[0];
}

/** A folder name for the app under %LOCALAPPDATA%\Programs: no characters Windows refuses, no trailing dots or spaces. */
export function installFolderName(name: string): string {
  const folder = name.replace(/[<>:"/\\|?*\u0000-\u001f]+/g, " ").replace(/\s+/g, " ").trim().replace(/[. ]+$/, "");
  return folder || "App";
}
