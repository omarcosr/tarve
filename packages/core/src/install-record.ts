// What the Windows installer (`tarve package --format setup`) leaves beside the app, and the
// Apps & features entry it registers, kept true when the app updates itself: an executable
// swap or an app pack changes the running version, so the entry's version and size follow it.
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

/** The installer's record in the install folder. */
export const SETUP_STATE_NAME = "tarve-setup.json";
export const UNINSTALLER_NAME = "Uninstall.exe";
export const UNINSTALL_ROOT = "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall";

export interface SetupState {
  /** Registry key of the Apps & features entry (absent in records of early installers). */
  appId?: string;
  /** The version the entry shows. */
  version: string;
  language: string;
  startup: boolean;
  custom: Record<string, boolean>;
}

/** What the installer recorded in `directory`; undefined when this setup did not install the app there. */
export function readSetupState(directory: string): SetupState | undefined {
  const path = join(directory, SETUP_STATE_NAME);
  if (!existsSync(path)) return undefined;
  try {
    const state = JSON.parse(readFileSync(path, "utf8")) as Partial<SetupState>;
    return {
      ...(typeof state.appId === "string" ? { appId: state.appId } : {}),
      version: state.version ?? "", language: state.language ?? "", startup: state.startup === true, custom: state.custom ?? {},
    };
  } catch {
    return undefined;
  }
}

export function writeSetupState(directory: string, state: SetupState): void {
  writeFileSync(join(directory, SETUP_STATE_NAME), JSON.stringify(state, null, 2) + "\n");
}

/** `reg.exe` with these arguments; injectable for tests. */
export type RegistryCommand = (args: readonly string[]) => { status: number | null; output: string };

const reg: RegistryCommand = args => {
  const result = spawnSync("reg.exe", args as string[], { encoding: "utf8", windowsHide: true });
  if (result.error) throw result.error;
  return { status: result.status, output: `${result.stdout ?? ""}${result.stderr ?? ""}` };
};

/** The Apps & features size of an install folder in KB: the executable and the uninstaller. */
export function installSizeKb(directory: string, executable: string): number {
  let bytes = 0;
  for (const path of [executable, join(directory, UNINSTALLER_NAME)]) {
    try { bytes += statSync(path).size; } catch { /* missing: not counted */ }
  }
  return Math.max(1, Math.ceil(bytes / 1024));
}

/**
 * Brings the installer's Apps & features entry up to `version` when the app updated itself:
 * a no-op unless `executable` sits in a folder the installer recorded (`tarve-setup.json`) at
 * another version and the entry still points at that folder. Windows only; never throws.
 * Returns whether it changed the entry.
 */
export function syncInstallRecord(version: string | undefined, executable = process.execPath, registry: RegistryCommand = reg): boolean {
  if (!version) return false;
  if (registry === reg && process.platform !== "win32") return false;
  try {
    const directory = dirname(resolve(executable));
    const state = readSetupState(directory);
    if (!state?.appId || state.version === version) return false;
    const key = `${UNINSTALL_ROOT}\\${state.appId}`;
    const entry = registry(["query", key, "/v", "InstallLocation"]);
    const location = /InstallLocation\s+REG_\w+\s+(.+?)\s*$/m.exec(entry.output)?.[1];
    if (entry.status !== 0 || !location || resolve(location).toLowerCase() !== directory.toLowerCase()) return false;
    const set = (name: string, value: string, type = "REG_SZ") => registry(["add", key, "/v", name, "/t", type, "/d", value, "/f"]).status === 0;
    if (!set("DisplayVersion", version)) return false;
    set("EstimatedSize", String(installSizeKb(directory, executable)), "REG_DWORD");
    writeSetupState(directory, { ...state, version });
    return true;
  } catch {
    return false;
  }
}
