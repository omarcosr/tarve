import { describe, expect, test } from "bun:test";
import { installFolderName, localizedText, parseInstallerConfig, parseSetupManifest } from "./manifest";
import { formatSize, pickLanguage, setupText } from "./strings";

describe("tarve.installer", () => {
  test("defaults: both languages, folder page, desktop shortcut and launch on, startup hidden", () => {
    const config = parseInstallerConfig(undefined);
    expect(config.languages).toEqual(["en", "pt-BR"]);
    expect(config.options.directory).toBe(true);
    expect(config.options.language).toBe(true);
    expect(config.options.desktopShortcut).toEqual({ enabled: true, default: true });
    expect(config.options.startup).toEqual({ enabled: false, default: false, args: [] });
    expect(config.options.launch).toEqual({ enabled: true, default: true, args: [] });
    expect(config.options.custom).toEqual([]);
    expect(config.hooks).toEqual({});
    expect(config.previous).toEqual({ uninstallKeys: [], files: [], shortcuts: [] });
  });

  test("reads toggles, hooks, custom options and previous installers", () => {
    const config = parseInstallerConfig({
      directory: "Acme Notes", languages: ["pt-BR"], accent: "#3366ff",
      options: {
        directory: false, desktopShortcut: false,
        startup: { default: true, command: ["--enable-startup"], undo: ["--disable-startup"], label: { "pt-BR": "Abrir com o Windows" } },
        launch: { args: ["--from-setup"] },
        custom: [{ id: "context-menu", label: { en: "Add to the context menu", "pt-BR": "Adicionar ao menu de contexto" }, command: ["--register-menu"], undo: ["--unregister-menu"] }],
      },
      hooks: { beforeInstall: ["--stop", "--wait"], afterInstall: ["--migrate"], beforeUninstall: [["--stop", "--wait"], ["--remove-startup"]] },
      previous: { uninstallKeys: ["Acme.Notes_is1"], files: ["unins000.exe", "unins000.dat"] },
      strings: { "pt-BR": { welcomeTitle: "Olá" } },
    });
    expect(config.directory).toBe("Acme Notes");
    expect(config.options.language).toBe(false);
    expect(config.options.desktopShortcut.enabled).toBe(false);
    expect(config.options.startup).toEqual({ enabled: true, default: true, args: [], command: ["--enable-startup"], undo: ["--disable-startup"], label: { "pt-BR": "Abrir com o Windows" } });
    expect(config.options.launch).toEqual({ enabled: true, default: true, args: ["--from-setup"] });
    expect(config.options.custom[0]).toEqual({ id: "context-menu", label: { en: "Add to the context menu", "pt-BR": "Adicionar ao menu de contexto" }, default: false, command: ["--register-menu"], undo: ["--unregister-menu"] });
    expect(config.hooks.beforeInstall).toEqual([["--stop", "--wait"]]);
    expect(config.hooks.beforeUninstall).toEqual([["--stop", "--wait"], ["--remove-startup"]]);
    expect(config.previous.files).toEqual(["unins000.exe", "unins000.dat"]);
    expect(config.strings["pt-BR"]!.welcomeTitle).toBe("Olá");
  });

  test("rejects malformed fields", () => {
    expect(() => parseInstallerConfig({ options: { custom: [{ label: "x" }] } })).toThrow(/custom\[0\]\.id/);
    expect(() => parseInstallerConfig({ options: { custom: [{ id: "a", label: "x" }, { id: "a", label: "y" }] } })).toThrow(/twice/);
    expect(() => parseInstallerConfig({ hooks: { afterInstall: "--x" } })).toThrow(/argument list/);
    expect(() => parseInstallerConfig({ hooks: { afterInstall: [["--x"], "--y"] } })).toThrow(/argument list/);
    expect(() => parseInstallerConfig({ languages: ["fr"] })).toThrow(/strings\["fr"\]/);
    expect(() => parseInstallerConfig({ languages: ["fr"], strings: { fr: { welcomeTitle: "Bonjour" } } })).not.toThrow();
    expect(() => parseInstallerConfig({ options: { startup: { default: "yes" } } })).toThrow(/true or false/);
  });

  test("localized texts fall back to the language family, English, then anything", () => {
    expect(localizedText({ "pt-BR": "Olá", en: "Hi" }, "pt-BR")).toBe("Olá");
    expect(localizedText({ pt: "Olá", en: "Hi" }, "pt-BR")).toBe("Olá");
    expect(localizedText({ en: "Hi" }, "pt-BR")).toBe("Hi");
    expect(localizedText({ de: "Hallo" }, "pt-BR")).toBe("Hallo");
    expect(localizedText("Plain", "pt-BR")).toBe("Plain");
    expect(localizedText(undefined, "en")).toBeUndefined();
  });

  test("folder names drop what Windows refuses", () => {
    expect(installFolderName("Periféricos")).toBe("Periféricos");
    expect(installFolderName(' Acme: "Notes"? ')).toBe("Acme Notes");
    expect(installFolderName("...")).toBe("App");
  });

  test("manifests need their identity", () => {
    expect(() => parseSetupManifest({ name: "A" })).toThrow(/version is missing/);
  });
});

describe("installer texts", () => {
  const manifest = { name: "Periféricos", version: "0.5.7", publisher: "Acme", languages: ["en", "pt-BR"], strings: { "pt-BR": { welcomeTitle: "Olá, {name} {version}" } } };

  test("pick the system language, its family, else the first", () => {
    expect(pickLanguage(manifest, "pt-BR")).toBe("pt-BR");
    expect(pickLanguage(manifest, "pt_PT")).toBe("pt-BR");
    expect(pickLanguage(manifest, "en-GB")).toBe("en");
    expect(pickLanguage(manifest, "de-DE")).toBe("en");
    expect(pickLanguage({ languages: ["pt-BR"] }, undefined)).toBe("pt-BR");
  });

  test("fill placeholders, with app overrides first and English as the fallback", () => {
    expect(setupText(manifest, "pt-BR", "welcomeTitle")).toBe("Olá, Periféricos 0.5.7");
    expect(setupText(manifest, "pt-BR", "next")).toBe("Avançar");
    expect(setupText(manifest, "en", "doneText", { folder: "C:\\Apps" })).toContain("C:\\Apps");
    expect(setupText(manifest, "de", "next")).toBe("Next");
    expect(setupText(manifest, "en", "hookFailed", { code: 3 })).toBe("Periféricos reported a problem (exit code 3).");
  });

  test("sizes", () => {
    expect(formatSize(512)).toBe("1 KB");
    expect(formatSize(5 * 1024 * 1024)).toBe("5.0 MB");
    expect(formatSize(80 * 1024 * 1024)).toBe("80 MB");
  });
});
