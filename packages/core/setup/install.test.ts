import { afterAll, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gzipSync } from "node:zlib";
import { readShellLink } from "../src/shell-link";
import { syncInstallRecord } from "../src/install-record";
import { applyArgs, defaultChoices, defaultDirectory, directoryProblem, directoryWritable, effectiveSetupArgv, install, installedDirectory, launchInstalled, parseSetupArgs, readSetupState, relaunchUninstallerFromTemp, setupPaths, uninstall, type SetupSystem } from "./install";
import { parseInstallerConfig, type SetupManifest } from "./manifest";

const windows = process.platform === "win32";
const root = mkdtempSync(join(tmpdir(), "tarve-setup-test-"));
const locked: string[] = [];
afterAll(() => {
  for (const folder of locked) unlock(folder);
  rmSync(root, { recursive: true, force: true });
});

/** A folder nobody may create anything in, administrators included (an explicit deny ACE on Windows). */
function lockedFolder(name: string): string {
  const folder = join(root, name);
  mkdirSync(folder, { recursive: true });
  if (windows) {
    const result = spawnSync("icacls", [folder, "/deny", "*S-1-1-0:(OI)(CI)(W,D,DC)"], { encoding: "utf8" });
    if (result.status !== 0) throw new Error(`icacls failed: ${result.stdout}${result.stderr}`);
  } else {
    chmodSync(folder, 0o555);
  }
  locked.push(folder);
  return folder;
}

function unlock(folder: string): void {
  if (windows) spawnSync("icacls", [folder, "/remove:d", "*S-1-1-0"]);
  else chmodSync(folder, 0o755);
}

interface FakeSystem extends SetupSystem {
  registry: Map<string, Map<string, string>>;
  runs: { executable: string; args: string[] }[];
  launches: { executable: string; args: string[] }[];
  exitCodes: Record<string, number>;
}

function fakeSystem(name: string): FakeSystem {
  const home = join(root, name);
  mkdirSync(join(home, "AppData", "Local"), { recursive: true });
  mkdirSync(join(home, "AppData", "Roaming"), { recursive: true });
  const self = join(home, "Downloads", "App-Setup.exe");
  mkdirSync(join(home, "Downloads"), { recursive: true });
  writeFileSync(self, "SETUP");
  const registry = new Map<string, Map<string, string>>();
  const system: FakeSystem = {
    registry, runs: [], launches: [], exitCodes: {},
    env: { LOCALAPPDATA: join(home, "AppData", "Local"), APPDATA: join(home, "AppData", "Roaming"), USERPROFILE: home },
    self,
    reg(args) {
      const [verb, key, ...rest] = args as string[];
      if (verb === "add") {
        const values = registry.get(key!) ?? new Map<string, string>();
        registry.set(key!, values);
        const name = rest[0] === "/ve" ? "" : rest[rest.indexOf("/v") + 1]!;
        const data = rest.indexOf("/d") >= 0 ? rest[rest.indexOf("/d") + 1]! : "";
        values.set(name, data);
        return { status: 0, output: "" };
      }
      if (verb === "delete") {
        if (!registry.has(key!)) return { status: 1, output: "ERROR: The system was unable to find the specified registry key or value." };
        if (rest[0] === "/v") registry.get(key!)!.delete(rest[1]!); else registry.delete(key!);
        return { status: 0, output: "" };
      }
      if (verb === "query" && key === "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Explorer\\User Shell Folders") {
        return { status: 0, output: "\r\n" + key + "\r\n    Desktop    REG_EXPAND_SZ    %USERPROFILE%\\Área de Trabalho\r\n" };
      }
      return { status: 1, output: "" };
    },
    async run(executable, args) {
      system.runs.push({ executable, args: [...args] });
      return system.exitCodes[args.join(" ")] ?? 0;
    },
    launch(executable, args) {
      system.launches.push({ executable, args: [...args] });
    },
  };
  return system;
}

function manifest(overrides: Partial<SetupManifest> = {}, installer: unknown = undefined): SetupManifest {
  const config = parseInstallerConfig(installer);
  return {
    name: "Acme Notes", version: "1.2.3", appId: "Acme.Notes", publisher: "Acme", description: "Notes", homepage: "https://acme.test",
    executable: "AcmeNotes.exe", directory: "Acme Notes", shortcutName: "Acme Notes",
    languages: [...config.languages], options: config.options, hooks: config.hooks, previous: config.previous, protocols: ["acmenotes"], fileTypes: [{ ext: "acmenote", name: "Acme note" }],
    strings: {}, size: 4096, icon: false, ...overrides,
  };
}

function payload(name: string): string {
  const path = join(root, name + ".gz");
  writeFileSync(path, gzipSync(Buffer.from("MZ-fake-app-" + name)));
  return path;
}

describe("installer arguments", () => {
  test("parse silent, uninstall, folder, language and option switches", () => {
    expect(parseSetupArgs(["/S", "--dir=C:\\Apps\\Notes", "--lang=pt-BR", "--no-desktop-shortcut", "--startup", "--no-launch", "--option=menu", "--no-option=cloud"])).toEqual({
      mode: "install", silent: true, directory: "C:\\Apps\\Notes", language: "pt-BR", desktopShortcut: false, startup: true, launch: false, custom: { menu: true, cloud: false },
    });
    expect(parseSetupArgs(["--uninstall", "--silent"])).toEqual({ mode: "uninstall", silent: true, custom: {} });
    expect(parseSetupArgs(["/D=C:\\X"]).directory).toBe("C:\\X");
  });

  test("apply on top of the defaults", () => {
    const system = fakeSystem("args");
    const m = manifest({}, { options: { startup: true, custom: [{ id: "menu", label: "Menu", default: true }] } });
    const choices = defaultChoices(m, system, "en");
    expect(choices).toEqual({ directory: join(system.env.LOCALAPPDATA!, "Programs", "Acme Notes"), language: "en", desktopShortcut: true, startup: false, launch: true, custom: { menu: true } });
    expect(applyArgs(choices, parseSetupArgs(["--startup", "--no-option=menu"]))).toMatchObject({ startup: true, custom: { menu: false } });
  });

  test("folder checks", () => {
    expect(directoryProblem("C:\\")).toBe("directoryInvalid");
    expect(directoryProblem("Apps\\Notes")).toBe("directoryInvalid");
    expect(directoryProblem("C:\\Apps\\No?tes")).toBe("directoryInvalid");
    expect(directoryProblem("C:\\Apps\\Notes")).toBeUndefined();
    expect(defaultDirectory({ directory: "Acme Notes" }, { USERPROFILE: "C:\\Users\\me" })).toBe(join("C:\\Users\\me", "AppData", "Local", "Programs", "Acme Notes"));
  });
});

describe.skipIf(!windows)("install and uninstall", () => {
  test("files, shortcuts, registry, hooks, startup, options and launch", async () => {
    const system = fakeSystem("full");
    const m = manifest({}, {
      options: { startup: { default: true, args: ["--background"] }, custom: [{ id: "menu", label: "Menu", default: true, command: ["--add-menu"], undo: ["--remove-menu"] }] },
      hooks: { beforeInstall: ["--stop", "--wait"], afterInstall: ["--migrate"], beforeUninstall: [["--stop", "--wait"], ["--remove-startup"]] },
      previous: { uninstallKeys: ["Acme.Notes_is1"], files: ["unins000.exe"], shortcuts: ["Acme Notes Old.lnk"] },
    });
    const choices = defaultChoices(m, system, "pt-BR");
    const paths = setupPaths(m, choices.directory, system);
    mkdirSync(choices.directory, { recursive: true });
    writeFileSync(join(choices.directory, "unins000.exe"), "old");
    mkdirSync(join(system.env.APPDATA!, "Microsoft", "Windows", "Start Menu", "Programs"), { recursive: true });
    writeFileSync(join(system.env.APPDATA!, "Microsoft", "Windows", "Start Menu", "Programs", "Acme Notes Old.lnk"), "old");
    system.registry.set("HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\Acme.Notes_is1", new Map([["DisplayName", "Old"]]));
    const steps: string[] = [];
    const result = await install(m, payload("full"), choices, system, step => { if (steps.at(-1) !== step) steps.push(step); });
    expect(result.executable).toBe(paths.executable);
    expect(readFileSync(paths.executable, "utf8")).toBe("MZ-fake-app-full");
    expect(readFileSync(paths.uninstaller, "utf8")).toBe("SETUP");
    expect(existsSync(join(choices.directory, "unins000.exe"))).toBe(false);
    expect(existsSync(join(system.env.APPDATA!, "Microsoft", "Windows", "Start Menu", "Programs", "Acme Notes Old.lnk"))).toBe(false);
    expect(readSetupState(choices.directory)).toEqual({ appId: "Acme.Notes", version: "1.2.3", language: "pt-BR", startup: true, custom: { menu: true } });
    expect(steps).toEqual(["stepPrepare", "stepStop", "stepCopy", "stepShortcuts", "stepRegistry", "stepHooks"]);
    // Shortcuts: Start menu always, the desktop one (from the shell folders) by choice.
    const link = readShellLink(new Uint8Array(readFileSync(paths.startMenuShortcut)));
    expect(link).toMatchObject({ target: paths.executable, workingDirectory: choices.directory, appUserModelId: "Acme.Notes", icon: paths.executable, iconIndex: 0 });
    expect(paths.desktopShortcut).toBe(join(system.env.USERPROFILE!, "Área de Trabalho", "Acme Notes.lnk"));
    expect(existsSync(paths.desktopShortcut!)).toBe(true);
    // Registry: the Apps & features entry, the previous installer's gone, Run, protocol and file type.
    const entry = system.registry.get(paths.uninstallKey)!;
    expect(entry.get("DisplayName")).toBe("Acme Notes");
    expect(entry.get("DisplayVersion")).toBe("1.2.3");
    expect(entry.get("UninstallString")).toBe('"' + paths.uninstaller + '" --uninstall');
    expect(entry.get("QuietUninstallString")).toBe('"' + paths.uninstaller + '" --uninstall --silent');
    expect(entry.get("DisplayIcon")).toBe(paths.executable + ",0");
    expect(entry.get("InstallLocation")).toBe(choices.directory);
    expect(entry.get("Publisher")).toBe("Acme");
    expect(entry.get("URLInfoAbout")).toBe("https://acme.test");
    expect(Number(entry.get("EstimatedSize"))).toBeGreaterThan(0);
    expect(system.registry.has("HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\Acme.Notes_is1")).toBe(false);
    expect(system.registry.get("HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run")!.get("Acme.Notes")).toBe('"' + paths.executable + '" "--background"');
    expect(system.registry.get("HKCU\\Software\\Classes\\acmenotes\\shell\\open\\command")!.get("")).toBe('"' + paths.executable + '" "%1"');
    expect(system.registry.get("HKCU\\Software\\Classes\\.acmenote\\OpenWithProgids")!.has("Acme.Notes.acmenote")).toBe(true);
    // Hooks: the fresh executable before, the installed one after, then the checked option's command.
    expect(system.runs.map(run => run.args.join(" "))).toEqual(["--stop --wait", "--migrate", "--add-menu"]);
    expect(system.runs[0]!.executable).not.toBe(paths.executable);
    expect(system.runs[1]!.executable).toBe(paths.executable);
    // Opening the app is left to the end: install() does not, launchInstalled() does.
    expect(system.launches).toEqual([]);
    expect(launchInstalled(m, choices, result, system)).toBe(true);
    expect(system.launches).toEqual([{ executable: paths.executable, args: [] }]);

    // Incremental updates downloaded since (pack-host.ts keeps them per user, by app id).
    const packs = join(system.env.LOCALAPPDATA!, "Acme.Notes", "packs", "abc");
    mkdirSync(packs, { recursive: true });
    writeFileSync(join(packs, "1.2.4.tarve"), "pack");
    writeFileSync(join(system.env.LOCALAPPDATA!, "Acme.Notes", "settings.json"), "{}");
    // Uninstall from the install folder: the hook, the option's undo, then everything goes.
    const uninstallSystem: FakeSystem = { ...system, self: paths.uninstaller };
    expect(installedDirectory(m, uninstallSystem)).toBe(choices.directory);
    const before = system.runs.length;
    await uninstall(m, choices.directory, uninstallSystem);
    expect(system.runs.slice(before).map(run => run.args.join(" "))).toEqual(["--stop --wait", "--remove-startup", "--remove-menu"]);
    expect(existsSync(choices.directory)).toBe(false);
    expect(existsSync(paths.startMenuShortcut)).toBe(false);
    expect(existsSync(paths.desktopShortcut!)).toBe(false);
    expect(system.registry.has(paths.uninstallKey)).toBe(false);
    expect(system.registry.get("HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run")!.has("Acme.Notes")).toBe(false);
    expect(system.registry.has("HKCU\\Software\\Classes\\acmenotes")).toBe(false);
    // Packs go; the app's own data beside them stays.
    expect(existsSync(join(system.env.LOCALAPPDATA!, "Acme.Notes", "packs"))).toBe(false);
    expect(existsSync(join(system.env.LOCALAPPDATA!, "Acme.Notes", "settings.json"))).toBe(true);
  });

  test("a self-updated app brings its Apps & features entry to the running version", async () => {
    const system = fakeSystem("sync");
    const m = manifest();
    const choices = defaultChoices(m, system, "en");
    const paths = setupPaths(m, choices.directory, system);
    await install(m, payload("sync"), { ...choices, launch: false }, system);
    const registry = (args: readonly string[]) => {
      if (args[0] === "query") {
        const values = system.registry.get(args[1]!);
        const value = values?.get(args[3]!);
        return value === undefined ? { status: 1, output: "" } : { status: 0, output: `\r\n${args[1]}\r\n    ${args[3]}    REG_SZ    ${value}\r\n` };
      }
      return system.reg(args);
    };
    expect(syncInstallRecord("1.2.3", paths.executable, registry)).toBe(false);
    expect(syncInstallRecord("1.3.0", paths.executable, registry)).toBe(true);
    expect(system.registry.get(paths.uninstallKey)!.get("DisplayVersion")).toBe("1.3.0");
    expect(readSetupState(choices.directory)!.version).toBe("1.3.0");
    expect(syncInstallRecord("1.3.0", paths.executable, registry)).toBe(false);
    // A copy of the app elsewhere (a portable one) leaves the installed entry alone.
    const portable = join(root, "sync-portable");
    mkdirSync(portable, { recursive: true });
    writeFileSync(join(portable, "tarve-setup.json"), JSON.stringify({ appId: "Acme.Notes", version: "1.0.0" }));
    expect(syncInstallRecord("2.0.0", join(portable, "AcmeNotes.exe"), registry)).toBe(false);
    expect(system.registry.get(paths.uninstallKey)!.get("DisplayVersion")).toBe("1.3.0");
  });

  test("folders the user cannot write to are refused before anything is copied", async () => {
    expect(directoryWritable(join(root, "new", "deeper"))).toBe(true);
    // A folder denied to everyone, not System32: CI runners run elevated and may write there.
    const target = join(lockedFolder("locked"), "tarve-setup-test");
    expect(directoryWritable(target)).toBe(false);
    const system = fakeSystem("protected");
    const m = manifest();
    const choices = { ...defaultChoices(m, system, "en"), directory: target };
    await expect(install(m, payload("protected"), choices, system)).rejects.toMatchObject({ key: "directoryNotWritable" });
  });

  test("a failing before-install hook cancels the install", async () => {
    const system = fakeSystem("hook");
    system.exitCodes["--stop --wait"] = 2;
    const m = manifest({}, { hooks: { beforeInstall: ["--stop", "--wait"] } });
    const choices = defaultChoices(m, system, "en");
    await expect(install(m, payload("hook"), choices, system)).rejects.toMatchObject({ key: "stopFailed", params: { code: 2 } });
    expect(existsSync(join(choices.directory, "AcmeNotes.exe"))).toBe(false);
  });

  test("unchecked choices leave no desktop shortcut or Run entry, and app-managed startup runs the app", async () => {
    const system = fakeSystem("minimal");
    const m = manifest({}, { options: { startup: { default: true, command: ["--enable-startup"], undo: ["--disable-startup"] }, launch: false } });
    const choices = { ...defaultChoices(m, system, "en"), desktopShortcut: false };
    const paths = setupPaths(m, choices.directory, system);
    await install(m, payload("minimal"), choices, system);
    expect(existsSync(paths.desktopShortcut!)).toBe(false);
    expect(system.registry.get("HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run")).toBeUndefined();
    expect(system.runs.map(run => run.args.join(" "))).toEqual(["--enable-startup"]);
    expect(system.launches).toEqual([]);
    const before = system.runs.length;
    await uninstall(m, choices.directory, system);
    expect(system.runs.slice(before).map(run => run.args.join(" "))).toEqual(["--disable-startup"]);
  });

  test("the installed uninstaller relaunches itself from the temporary folder", () => {
    const system = fakeSystem("relaunch");
    const m = manifest();
    const directory = join(system.env.LOCALAPPDATA!, "Programs", "Acme Notes");
    mkdirSync(directory, { recursive: true });
    writeFileSync(join(directory, "AcmeNotes.exe"), "app");
    writeFileSync(join(directory, "Uninstall.exe"), "SETUP");
    const installed: FakeSystem = { ...system, self: join(directory, "Uninstall.exe") };
    expect(relaunchUninstallerFromTemp(m, ["--uninstall"], installed)).toBe(true);
    expect(installed.launches).toHaveLength(1);
    expect(installed.launches[0]!.executable.startsWith(tmpdir())).toBe(true);
    expect(installed.launches[0]!.args).toEqual(["--uninstall", "--dir=" + directory]);
    rmSync(installed.launches[0]!.executable, { force: true });
    expect(relaunchUninstallerFromTemp(m, ["--uninstall", "--dir=" + directory], installed)).toBe(false);
    expect(relaunchUninstallerFromTemp(m, ["--uninstall"], system)).toBe(false);
  });

  test("the installed uninstaller opened without --uninstall uninstalls", () => {
    const system = fakeSystem("uninstaller-by-hand");
    const m = manifest();
    const directory = join(system.env.LOCALAPPDATA!, "Programs", "Acme Notes");
    mkdirSync(directory, { recursive: true });
    writeFileSync(join(directory, "AcmeNotes.exe"), "app");
    writeFileSync(join(directory, "Uninstall.exe"), "SETUP");
    const installed: FakeSystem = { ...system, self: join(directory, "Uninstall.exe") };
    expect(effectiveSetupArgv(m, [], installed)).toEqual(["--uninstall"]);
    expect(effectiveSetupArgv(m, ["--uninstall", "--silent"], installed)).toEqual(["--uninstall", "--silent"]);
    expect(effectiveSetupArgv(m, ["--silent"], system)).toEqual(["--silent"]);
  });
});
