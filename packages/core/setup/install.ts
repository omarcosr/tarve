// What the Windows installer does once the user has chosen: files, shortcuts, registry entries
// (the Apps & features entry, Run, deep links and file types), the app's hooks, and the reverse
// on uninstall. Pure node: modules and an injectable `SetupSystem` (registry, processes,
// environment), so the steps are testable in a temporary folder on any OS.
import { spawn, spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { gunzipSync } from "node:zlib";
import { fileTypeProgId, fileTypeRegistryCommands, fileTypeUnregistryCommands, protocolRegistryCommands, protocolUnregistryCommands, quote } from "../src/associations";
import { createShellLink } from "../src/shell-link";
import { SETUP_STATE_NAME, UNINSTALLER_NAME, UNINSTALL_ROOT, installSizeKb, readSetupState, writeSetupState, type SetupState } from "../src/install-record";

export { SETUP_STATE_NAME, UNINSTALLER_NAME, readSetupState, type SetupState };
import { installFolderName, type SetupManifest } from "./manifest";
import type { SetupStringKey } from "./strings";

/** What the user picked (or the command line set). */
export interface SetupChoices {
  directory: string;
  language: string;
  desktopShortcut: boolean;
  startup: boolean;
  launch: boolean;
  custom: Record<string, boolean>;
}

/** The outside world of an install: environment, registry and processes. */
export interface SetupSystem {
  env: Readonly<Record<string, string | undefined>>;
  /** This installer's own executable (copied as the uninstaller). */
  self: string;
  /** `reg.exe` with these arguments; status and output. */
  reg(args: readonly string[]): { status: number | null; output: string };
  /** Runs `executable` with `args` and waits for its exit code. */
  run(executable: string, args: readonly string[], options?: { cwd?: string }): Promise<number | null>;
  /** Starts `executable` with `args` and lets it live on after the installer. */
  launch(executable: string, args: readonly string[], options?: { cwd?: string }): void;
}

/** Where the installer reports progress: a step (a text key) and how far along (0–1). */
export type SetupProgress = (step: SetupStringKey, fraction: number) => void;

/** An error the wizard shows in the user's language. */
export class SetupError extends Error {
  constructor(readonly key: SetupStringKey, readonly params: Record<string, string | number> = {}, detail?: string) {
    super(detail ?? key);
    this.name = "SetupError";
  }
}

const RUN_KEY = "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run";
const SHELL_FOLDERS = "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Explorer\\User Shell Folders";

/** The registry and processes of the machine the installer runs on. */
export function defaultSystem(): SetupSystem {
  return {
    env: process.env,
    self: process.execPath,
    reg(args) {
      const result = spawnSync("reg.exe", args as string[], { encoding: "utf8", windowsHide: true });
      if (result.error) throw result.error;
      return { status: result.status, output: `${result.stdout ?? ""}${result.stderr ?? ""}` };
    },
    run(executable, args, options) {
      return new Promise((resolveExit, reject) => {
        const child = spawn(executable, args as string[], { cwd: options?.cwd, stdio: "ignore", windowsHide: true });
        child.once("error", reject);
        child.once("exit", code => resolveExit(code));
      });
    },
    launch(executable, args, options) {
      spawn(executable, args as string[], { cwd: options?.cwd, detached: true, stdio: "ignore" }).unref();
    },
  };
}

function expandEnvironment(value: string, env: SetupSystem["env"]): string {
  return value.replace(/%([^%]+)%/g, (match, name: string) => env[name] ?? env[name.toUpperCase()] ?? match);
}

/** `%LOCALAPPDATA%\Programs\<folder>`: where per-user apps go (what Inno Setup and Squirrel use too). */
export function defaultDirectory(manifest: Pick<SetupManifest, "directory">, env: SetupSystem["env"]): string {
  const local = env.LOCALAPPDATA ?? (env.USERPROFILE ? join(env.USERPROFILE, "AppData", "Local") : undefined);
  if (!local) throw new SetupError("failedText", {}, "LOCALAPPDATA is not set");
  return join(local, "Programs", installFolderName(manifest.directory));
}

/** Folders under %LOCALAPPDATA% whose `packs` hold the app's packs (pack-host.ts names them after the app id, else the name). */
export function packFolders(manifest: Pick<SetupManifest, "appId" | "name">, system: SetupSystem): string[] {
  const local = system.env.LOCALAPPDATA ?? (system.env.USERPROFILE ? join(system.env.USERPROFILE, "AppData", "Local") : undefined);
  if (!local) return [];
  const safe = (id: string) => id.replace(/[<>:"/\\|?*\x00-\x1f]/g, "_");
  return [...new Set([safe(manifest.appId), safe(manifest.name)])].map(id => join(local, id));
}

/** Whether the user can write into `directory` (or the nearest folder above it that exists): tried, since Windows ACLs decide. */
export function directoryWritable(directory: string): boolean {
  let existing = resolve(directory);
  while (!existsSync(existing)) {
    const parent = dirname(existing);
    if (parent === existing) return false;
    existing = parent;
  }
  try {
    rmSync(mkdtempSync(join(existing, ".tarve-setup-")), { recursive: true, force: true });
    return true;
  } catch {
    return false;
  }
}

/** The text key of what is wrong with an install folder, or undefined when it will do. */
export function directoryProblem(directory: string): SetupStringKey | undefined {
  const trimmed = directory.trim();
  if (!/^[A-Za-z]:\\/.test(trimmed) || /[<>"|?*\u0000-\u001f]/.test(trimmed.slice(2))) return "directoryInvalid";
  if (/^[A-Za-z]:\\?$/.test(trimmed)) return "directoryInvalid";
  return undefined;
}

/** The desktop folder as Windows has it (OneDrive may redirect it); `%USERPROFILE%\Desktop` without an answer. */
export function desktopFolder(system: SetupSystem): string | undefined {
  try {
    const result = system.reg(["query", SHELL_FOLDERS, "/v", "Desktop"]);
    const match = /Desktop\s+REG_(?:EXPAND_)?SZ\s+(.+?)\s*$/m.exec(result.output);
    if (result.status === 0 && match) return expandEnvironment(match[1]!, system.env);
  } catch { /* no registry (tests, other OSes): fall through */ }
  return system.env.USERPROFILE ? join(system.env.USERPROFILE, "Desktop") : undefined;
}

export function startMenuFolder(system: SetupSystem): string {
  const appData = system.env.APPDATA ?? (system.env.USERPROFILE ? join(system.env.USERPROFILE, "AppData", "Roaming") : undefined);
  if (!appData) throw new SetupError("failedText", {}, "APPDATA is not set");
  return join(appData, "Microsoft", "Windows", "Start Menu", "Programs");
}

/** The files and keys of an installed app. */
export function setupPaths(manifest: SetupManifest, directory: string, system: SetupSystem) {
  const shortcut = `${installFolderName(manifest.shortcutName)}.lnk`;
  const desktop = desktopFolder(system);
  return {
    directory,
    executable: join(directory, manifest.executable),
    uninstaller: join(directory, UNINSTALLER_NAME),
    state: join(directory, SETUP_STATE_NAME),
    startMenuShortcut: join(startMenuFolder(system), shortcut),
    desktopShortcut: desktop ? join(desktop, shortcut) : undefined,
    uninstallKey: `${UNINSTALL_ROOT}\\${manifest.appId}`,
  };
}

/** The choices the wizard starts from: the manifest's defaults and the default folder. */
export function defaultChoices(manifest: SetupManifest, system: SetupSystem, language: string): SetupChoices {
  return {
    directory: defaultDirectory(manifest, system.env),
    language,
    desktopShortcut: manifest.options.desktopShortcut.enabled && manifest.options.desktopShortcut.default,
    startup: manifest.options.startup.enabled && manifest.options.startup.default,
    launch: manifest.options.launch.enabled && manifest.options.launch.default,
    custom: Object.fromEntries(manifest.options.custom.map(option => [option.id, option.default])),
  };
}

/** The installer's command line: `/S` or `--silent`, `--dir=`, `--lang=`, `--no-<option>` / `--<option>`, `--uninstall`. */
export interface SetupArgs {
  mode: "install" | "uninstall";
  silent: boolean;
  directory?: string;
  language?: string;
  desktopShortcut?: boolean;
  startup?: boolean;
  launch?: boolean;
  custom: Record<string, boolean>;
}

export function parseSetupArgs(argv: readonly string[]): SetupArgs {
  const args: SetupArgs = { mode: "install", silent: false, custom: {} };
  for (const arg of argv) {
    if (arg === "/S" || arg === "/s" || arg === "--silent" || arg === "/SILENT" || arg === "/VERYSILENT") args.silent = true;
    else if (arg === "--uninstall") args.mode = "uninstall";
    else if (arg.startsWith("--dir=")) args.directory = arg.slice("--dir=".length).replace(/^"|"$/g, "");
    else if (arg.startsWith("/D=")) args.directory = arg.slice(3).replace(/^"|"$/g, "");
    else if (arg.startsWith("--lang=")) args.language = arg.slice("--lang=".length);
    else if (arg === "--desktop-shortcut" || arg === "--no-desktop-shortcut") args.desktopShortcut = !arg.startsWith("--no-");
    else if (arg === "--startup" || arg === "--no-startup") args.startup = !arg.startsWith("--no-");
    else if (arg === "--launch" || arg === "--no-launch") args.launch = !arg.startsWith("--no-");
    else if (/^--(no-)?option=/.test(arg)) args.custom[arg.replace(/^--(no-)?option=/, "")] = !arg.startsWith("--no-");
  }
  return args;
}

/** The choices with the command line applied on top. */
export function applyArgs(choices: SetupChoices, args: SetupArgs): SetupChoices {
  return {
    ...choices,
    ...(args.directory ? { directory: resolve(args.directory) } : {}),
    ...(args.language ? { language: args.language } : {}),
    ...(args.desktopShortcut !== undefined ? { desktopShortcut: args.desktopShortcut } : {}),
    ...(args.startup !== undefined ? { startup: args.startup } : {}),
    ...(args.launch !== undefined ? { launch: args.launch } : {}),
    custom: { ...choices.custom, ...args.custom },
  };
}

function regAdd(system: SetupSystem, key: string, name: string | undefined, value: string, type: "REG_SZ" | "REG_DWORD" | "REG_EXPAND_SZ" = "REG_SZ"): void {
  const result = system.reg(["add", key, ...(name === undefined ? ["/ve"] : ["/v", name]), "/t", type, "/d", value, "/f"]);
  if (result.status !== 0) throw new SetupError("failedText", {}, `reg add ${key}${name ? ` /v ${name}` : ""} failed: ${result.output.trim()}`);
}

function regDelete(system: SetupSystem, key: string, name?: string): void {
  // A missing key or value is fine: reg.exe says so with status 1.
  system.reg(["delete", key, ...(name === undefined ? [] : ["/v", name]), "/f"]);
}

function regRun(system: SetupSystem, commands: readonly (readonly string[])[], check: boolean): void {
  for (const args of commands) {
    const result = system.reg(args);
    if (check && result.status !== 0) throw new SetupError("failedText", {}, `reg ${args.join(" ")} failed: ${result.output.trim()}`);
  }
}

async function runHooks(system: SetupSystem, executable: string, commands: readonly (readonly string[])[] | undefined, failure: SetupStringKey): Promise<void> {
  for (const args of commands ?? []) await runHook(system, executable, args, failure);
}

async function runHook(system: SetupSystem, executable: string, args: readonly string[] | undefined, failure: SetupStringKey): Promise<void> {
  if (!args) return;
  let code: number | null;
  try {
    code = await system.run(executable, args, { cwd: dirname(executable) });
  } catch (error) {
    throw new SetupError(failure, { code: -1 }, `${basename(executable)} ${args.join(" ")}: ${(error as Error).message}`);
  }
  if (code !== 0) throw new SetupError(failure, { code: code ?? -1 }, `${basename(executable)} ${args.join(" ")} exited with ${code}`);
}

function dateStamp(now = new Date()): string {
  return `${now.getFullYear()}${String(now.getMonth() + 1).padStart(2, "0")}${String(now.getDate()).padStart(2, "0")}`;
}

/** Replaces `path` with `bytes`: a running executable there is renamed to `.old` first (Windows lets a running file be renamed, not overwritten). */
function replaceFile(path: string, from: string): void {
  const old = `${path}.old`;
  try {
    copyFileSync(from, path);
    return;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (!existsSync(path) || !(code === "EBUSY" || code === "EPERM" || code === "EACCES" || code === "ETXTBSY")) throw error;
  }
  rmSync(old, { force: true });
  renameSync(path, old);
  try {
    copyFileSync(from, path);
  } catch (error) {
    renameSync(old, path);
    throw error;
  }
  try { rmSync(old, { force: true }); } catch { /* still running: the uninstaller removes it */ }
}

export interface InstallResult {
  directory: string;
  executable: string;
}

/**
 * Installs the app: the payload (the gzipped executable) goes to the chosen folder with the
 * uninstaller beside it, then shortcuts, the Apps & features entry, startup, deep links and file
 * types, the hooks and the chosen options' commands.
 */
export async function install(manifest: SetupManifest, payload: string, choices: SetupChoices, system: SetupSystem, progress: SetupProgress = () => {}): Promise<InstallResult> {
  const problem = directoryProblem(choices.directory) ?? (directoryWritable(choices.directory) ? undefined : "directoryNotWritable");
  if (problem) throw new SetupError(problem);
  const directory = resolve(choices.directory);
  const paths = setupPaths(manifest, directory, system);
  progress("stepPrepare", 0.02);
  const staging = mkdtempSync(join(tmpdir(), "tarve-setup-"));
  try {
    const fresh = join(staging, manifest.executable);
    writeFileSync(fresh, gunzipSync(readFileSync(payload)));
    progress("stepStop", 0.15);
    await runHooks(system, fresh, manifest.hooks.beforeInstall, "stopFailed");
    progress("stepCopy", 0.3);
    mkdirSync(directory, { recursive: true });
    for (const name of manifest.previous.files) rmSync(join(directory, name), { force: true });
    replaceFile(paths.executable, fresh);
    if (resolve(system.self) !== resolve(paths.uninstaller)) replaceFile(paths.uninstaller, system.self);
    writeSetupState(directory, { appId: manifest.appId, version: manifest.version, language: choices.language, startup: choices.startup, custom: choices.custom });
    progress("stepShortcuts", 0.6);
    const link = createShellLink({
      target: paths.executable, workingDirectory: directory, description: manifest.description ?? manifest.name,
      icon: paths.executable, iconIndex: 0, appUserModelId: manifest.appId,
    });
    mkdirSync(dirname(paths.startMenuShortcut), { recursive: true });
    for (const name of manifest.previous.shortcuts) rmSync(join(dirname(paths.startMenuShortcut), name), { force: true });
    writeFileSync(paths.startMenuShortcut, link);
    if (choices.desktopShortcut && paths.desktopShortcut) {
      mkdirSync(dirname(paths.desktopShortcut), { recursive: true });
      writeFileSync(paths.desktopShortcut, link);
    } else if (paths.desktopShortcut) {
      rmSync(paths.desktopShortcut, { force: true });
    }
    progress("stepRegistry", 0.7);
    for (const key of manifest.previous.uninstallKeys) {
      regDelete(system, `${UNINSTALL_ROOT}\\${key}`);
      regDelete(system, `HKLM\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\${key}`);
    }
    const uninstall = `${quote(paths.uninstaller)} --uninstall`;
    regAdd(system, paths.uninstallKey, "DisplayName", manifest.name);
    regAdd(system, paths.uninstallKey, "DisplayVersion", manifest.version);
    regAdd(system, paths.uninstallKey, "DisplayIcon", `${paths.executable},0`);
    regAdd(system, paths.uninstallKey, "InstallLocation", directory);
    regAdd(system, paths.uninstallKey, "InstallDate", dateStamp());
    regAdd(system, paths.uninstallKey, "UninstallString", uninstall);
    regAdd(system, paths.uninstallKey, "QuietUninstallString", `${uninstall} --silent`);
    regAdd(system, paths.uninstallKey, "NoModify", "1", "REG_DWORD");
    regAdd(system, paths.uninstallKey, "NoRepair", "1", "REG_DWORD");
    regAdd(system, paths.uninstallKey, "EstimatedSize", String(installSizeKb(directory, paths.executable)), "REG_DWORD");
    if (manifest.publisher) regAdd(system, paths.uninstallKey, "Publisher", manifest.publisher);
    if (manifest.homepage) regAdd(system, paths.uninstallKey, "URLInfoAbout", manifest.homepage);
    const command = [paths.executable];
    for (const scheme of manifest.protocols) regRun(system, protocolRegistryCommands(scheme, { name: manifest.name, command, icon: `${paths.executable},0` }), true);
    for (const type of manifest.fileTypes) {
      regRun(system, fileTypeRegistryCommands({ ...type, icon: type.icon ?? `${paths.executable},0` }, { progId: fileTypeProgId(manifest.appId, type.ext), command }), true);
    }
    if (manifest.options.startup.enabled && !manifest.options.startup.command) {
      if (choices.startup) regAdd(system, RUN_KEY, manifest.appId, [quote(paths.executable), ...manifest.options.startup.args.map(quote)].join(" "));
      else regDelete(system, RUN_KEY, manifest.appId);
    }
    progress("stepHooks", 0.85);
    await runHooks(system, paths.executable, manifest.hooks.afterInstall, "hookFailed");
    if (manifest.options.startup.enabled && manifest.options.startup.command) {
      await runHook(system, paths.executable, choices.startup ? manifest.options.startup.command : manifest.options.startup.undo, "hookFailed");
    }
    for (const option of manifest.options.custom) {
      await runHook(system, paths.executable, choices.custom[option.id] ? option.command : undefined, "hookFailed");
    }
    progress("stepHooks", 1);
    if (manifest.options.launch.enabled && choices.launch) system.launch(paths.executable, manifest.options.launch.args, { cwd: directory });
    return { directory, executable: paths.executable };
  } finally {
    rmSync(staging, { recursive: true, force: true });
  }
}

/** The install folder of the app this uninstaller sits in (the uninstaller's own folder), when it is one. */
export function installedDirectory(manifest: SetupManifest, system: SetupSystem): string | undefined {
  const directory = dirname(resolve(system.self));
  return basename(system.self).toLowerCase() === UNINSTALLER_NAME.toLowerCase() && existsSync(join(directory, manifest.executable)) ? directory : undefined;
}

/**
 * Removes the app: the before-uninstall hook and the options' undo commands, then startup,
 * deep links, file types and the Apps & features entry, shortcuts and files. The folder goes
 * when nothing else is in it.
 */
export async function uninstall(manifest: SetupManifest, directory: string, system: SetupSystem, progress: SetupProgress = () => {}): Promise<void> {
  const paths = setupPaths(manifest, resolve(directory), system);
  const state = readSetupState(paths.directory);
  progress("stepStop", 0.1);
  if (existsSync(paths.executable)) {
    await runHooks(system, paths.executable, manifest.hooks.beforeUninstall, "stopFailed");
    if (manifest.options.startup.enabled && manifest.options.startup.command && state?.startup) await runHook(system, paths.executable, manifest.options.startup.undo, "hookFailed");
    for (const option of manifest.options.custom) await runHook(system, paths.executable, state?.custom[option.id] ? option.undo : undefined, "hookFailed");
  }
  progress("stepRegistry", 0.4);
  regDelete(system, RUN_KEY, manifest.appId);
  for (const scheme of manifest.protocols) regRun(system, protocolUnregistryCommands(scheme), false);
  for (const type of manifest.fileTypes) regRun(system, fileTypeUnregistryCommands(type, fileTypeProgId(manifest.appId, type.ext)), false);
  regDelete(system, paths.uninstallKey);
  progress("stepShortcuts", 0.6);
  rmSync(paths.startMenuShortcut, { force: true });
  if (paths.desktopShortcut) rmSync(paths.desktopShortcut, { force: true });
  progress("stepCleanup", 0.8);
  for (const name of [manifest.executable, `${manifest.executable}.old`, UNINSTALLER_NAME, SETUP_STATE_NAME, ...manifest.previous.files]) {
    rmSync(join(paths.directory, name), { force: true });
  }
  if (existsSync(paths.directory) && readdirSync(paths.directory).length === 0) rmSync(paths.directory, { recursive: true, force: true });
  // Downloaded app packs (incremental updates) are the app's code, not the user's data.
  for (const folder of packFolders(manifest, system)) {
    rmSync(join(folder, "packs"), { recursive: true, force: true });
    try { if (readdirSync(folder).length === 0) rmSync(folder, { recursive: true, force: true }); } catch { /* not there */ }
  }
  progress("stepCleanup", 1);
}

/**
 * An uninstaller cannot delete the folder it runs from: when this executable is the installed
 * `Uninstall.exe`, copy it to the temporary folder, start the copy with the same arguments and
 * `--dir=<install folder>`, and return true so the caller exits. Copies left by earlier
 * uninstalls (a copy cannot delete itself either) are swept first.
 */
export function relaunchUninstallerFromTemp(manifest: SetupManifest, args: readonly string[], system: SetupSystem): boolean {
  const directory = installedDirectory(manifest, system);
  if (!directory || args.some(arg => arg.startsWith("--dir="))) return false;
  sweepUninstallerCopies();
  const copy = join(mkdtempSync(join(tmpdir(), UNINSTALL_TEMP_PREFIX)), `${installFolderName(manifest.name)} Uninstall.exe`);
  copyFileSync(system.self, copy);
  system.launch(copy, [...args, `--dir=${directory}`], { cwd: tmpdir() });
  return true;
}

const UNINSTALL_TEMP_PREFIX = "tarve-uninstall-";

/** Removes the temporary uninstaller copies of earlier runs (a running one refuses and stays). */
export function sweepUninstallerCopies(temporary = tmpdir()): void {
  let names: string[];
  try { names = readdirSync(temporary); } catch { return; }
  for (const name of names) {
    if (!name.startsWith(UNINSTALL_TEMP_PREFIX)) continue;
    try { rmSync(join(temporary, name), { recursive: true, force: true }); } catch { /* in use */ }
  }
}

