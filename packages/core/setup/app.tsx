// The Windows installer's window: a wizard in the app's colours (Welcome → Options → Folder →
// Installing → Done), the uninstaller's confirmation, and the silent modes. Built into one
// executable per app by `tarve package --format setup` (setup-build.ts), which calls `runSetup`
// with the manifest, the gzipped app executable and its icon.
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { extractOverlay } from "../src/exe-overlay";
import { Button, Checkbox, Column, Image, Input, Progress, Row, Select, Text, TitleBar, View, Window, createApp, createTheme, darkTheme, lightTheme, theme } from "../src/index";
import type { AppHandle } from "../src/app/types";
import type { ThemeDefinition } from "../src/theme";
import type { Child, VNode } from "../src/jsx-runtime";
import { applyArgs, defaultChoices, defaultSystem, directoryProblem, directoryWritable, install, installedDirectory, parseSetupArgs, relaunchUninstallerFromTemp, sweepUninstallerCopies, uninstall, SetupError, type SetupSystem } from "./install";
import { localizedText, parseSetupManifest } from "./manifest";
import { LANGUAGE_NAMES, formatSize, pickLanguage, setupText, type SetupStringKey } from "./strings";

type Page = "welcome" | "options" | "directory" | "installing" | "done" | "failed" | "uninstall" | "uninstalling" | "uninstalled" | "uninstallFailed";

const WIDTH = 640;
const HEIGHT = 460;

/** The system locale (`pt-BR`) from the registry, else from Intl. */
function systemLocale(system: SetupSystem): string | undefined {
  try {
    const result = system.reg(["query", "HKCU\\Control Panel\\International", "/v", "LocaleName"]);
    const match = /LocaleName\s+REG_SZ\s+(\S+)/.exec(result.output);
    if (result.status === 0 && match) return match[1];
  } catch { /* no registry: Intl below */ }
  try { return Intl.DateTimeFormat().resolvedOptions().locale; } catch { return undefined; }
}

/** Whether Windows apps are in dark mode (Settings → Personalization → Colors). */
function systemDark(system: SetupSystem): boolean {
  try {
    const result = system.reg(["query", "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Themes\\Personalize", "/v", "AppsUseLightTheme"]);
    return result.status === 0 && /AppsUseLightTheme\s+REG_DWORD\s+0x0\b/.test(result.output);
  } catch {
    return false;
  }
}

function hexColor(value: string | undefined): string | undefined {
  return value && /^#[0-9a-f]{6}$/i.test(value) ? value : undefined;
}

/** A darker/lighter shade of `#rrggbb` for hover and active states. */
function shade(hex: string, amount: number): string {
  const channel = (index: number) => Math.max(0, Math.min(255, Math.round(Number.parseInt(hex.slice(1 + index * 2, 3 + index * 2), 16) * (1 + amount))));
  return `#${[0, 1, 2].map(index => channel(index).toString(16).padStart(2, "0")).join("")}`;
}

function wizardTheme(accent: string | undefined, dark: boolean): ThemeDefinition {
  const base = dark ? darkTheme : lightTheme;
  const primary = hexColor(accent);
  return createTheme(primary ? { colors: { primary, primaryHover: shade(primary, dark ? 0.12 : -0.1), primaryActive: shade(primary, dark ? 0.24 : -0.2), ring: primary } } : {}, base);
}

export interface RunSetupOptions {
  /** The gzipped app executable; default the overlay of this executable (src/exe-overlay.ts). */
  payload?: string;
  /** The app icon as a .png (an embedded file), when it has one. */
  icon?: string;
  /** The installer's arguments (default: the process's). */
  argv?: readonly string[];
  system?: SetupSystem;
}

/** The gzipped app: the option's file, else this executable's overlay copied to a temporary file. */
function payloadFile(options: RunSetupOptions, system: SetupSystem): { path: string; dispose(): void } {
  if (options.payload) return { path: options.payload, dispose() {} };
  const directory = mkdtempSync(join(tmpdir(), "tarve-setup-payload-"));
  const path = join(directory, "app.gz");
  if (!extractOverlay(system.self, path)) {
    rmSync(directory, { recursive: true, force: true });
    throw new SetupError("failedText", {}, `${system.self} carries no app to install; build the installer with tarve package --format setup`);
  }
  return { path, dispose: () => rmSync(directory, { recursive: true, force: true }) };
}

/** Runs the installer: the wizard, or the silent install/uninstall the arguments ask for. Resolves with the exit code. */
export async function runSetup(manifestValue: unknown, options: RunSetupOptions): Promise<number> {
  const manifest = parseSetupManifest(manifestValue);
  const system = options.system ?? defaultSystem();
  const argv = options.argv ?? process.argv.slice(2);
  const args = parseSetupArgs(argv);
  if (args.mode === "uninstall" && relaunchUninstallerFromTemp(manifest, argv, system)) return 0;
  if (args.mode === "install") sweepUninstallerCopies();
  const language = args.language && manifest.languages.includes(args.language) ? args.language : pickLanguage(manifest, systemLocale(system));
  const t = (key: SetupStringKey, params?: Record<string, string | number>) => setupText(manifest, state.choices.language, key, params);
  const state = {
    page: (args.mode === "uninstall" ? "uninstall" : "welcome") as Page,
    choices: applyArgs(defaultChoices(manifest, system, language), args),
    step: "stepPrepare" as SetupStringKey,
    fraction: 0,
    error: undefined as string | undefined,
    directoryProblem: undefined as SetupStringKey | undefined,
    directoryNote: undefined as SetupStringKey | undefined,
    uninstallDirectory: args.directory ?? installedDirectory(manifest, system),
  };
  if (args.mode === "uninstall" && !state.uninstallDirectory) throw new SetupError("uninstallFailedTitle", {}, `${manifest.name} is not installed here (pass --dir=<install folder>)`);

  if (args.silent) {
    try {
      if (args.mode === "uninstall") await uninstall(manifest, state.uninstallDirectory!, system);
      else {
        const payload = payloadFile(options, system);
        try { await install(manifest, payload.path, state.choices, system); } finally { payload.dispose(); }
      }
      return 0;
    } catch (error) {
      console.error(error instanceof Error ? error.message : String(error));
      return 1;
    }
  }

  const icon = options.icon && existsSync(options.icon) ? readFileSync(options.icon) : undefined;
  const wizard = wizardTheme(manifest.accent, systemDark(system));
  const c = theme.colors;
  let app!: AppHandle;

  const describeError = (error: unknown): string => {
    if (error instanceof SetupError) {
      const text = t(error.key, error.params);
      return error.message && error.message !== error.key ? `${text}\n${error.message}` : text;
    }
    return error instanceof Error ? error.message : String(error);
  };

  const checkDirectory = () => {
    state.directoryProblem = directoryProblem(state.choices.directory);
    if (!state.directoryProblem && !directoryWritable(state.choices.directory.trim())) state.directoryProblem = "directoryNotWritable";
    state.directoryNote = undefined;
    if (!state.directoryProblem) {
      try {
        const directory = state.choices.directory.trim();
        if (existsSync(directory) && readdirSync(directory).some(name => ![manifest.executable, `${manifest.executable}.old`, "Uninstall.exe", "tarve-setup.json"].includes(name))) state.directoryNote = "directoryNotEmpty";
      } catch { /* unreadable: the install reports it */ }
    }
  };

  const startInstall = async () => {
    state.page = "installing";
    state.fraction = 0;
    app.update();
    try {
      const payload = payloadFile(options, system);
      try {
        await install(manifest, payload.path, state.choices, system, (step, fraction) => {
          state.step = step;
          state.fraction = fraction;
          app.update();
        });
      } finally {
        payload.dispose();
      }
      state.page = "done";
    } catch (error) {
      state.error = describeError(error);
      state.page = "failed";
    }
    app.update();
  };

  const startUninstall = async () => {
    state.page = "uninstalling";
    state.fraction = 0;
    app.update();
    try {
      await uninstall(manifest, state.uninstallDirectory!, system, (step, fraction) => {
        state.step = step;
        state.fraction = fraction;
        app.update();
      });
      state.page = "uninstalled";
    } catch (error) {
      state.error = describeError(error);
      state.page = "uninstallFailed";
    }
    app.update();
  };

  const pages: Page[] = ["welcome", ...(manifest.options.directory ? ["directory" as Page] : []), "options"];
  const hasOptions = manifest.options.desktopShortcut.enabled || manifest.options.startup.enabled || manifest.options.launch.enabled || manifest.options.custom.length > 0;
  const flow = hasOptions ? pages : pages.filter(page => page !== "options");
  const go = (delta: number) => {
    const index = flow.indexOf(state.page);
    const next = flow[index + delta];
    if (next === "directory" || state.page === "directory") checkDirectory();
    if (state.page === "directory" && delta > 0 && state.directoryProblem) return;
    if (next) state.page = next;
    else if (delta > 0) void startInstall();
  };
  const last = () => flow.indexOf(state.page) === flow.length - 1;

  const Header = ({ title, text }: { title: string; text?: string }) => (
    <Column gap={6}>
      <Text size={22} weight={650}>{title}</Text>
      {text ? <Text size={13} color={c.mutedForeground}>{text}</Text> : null}
    </Column>
  );

  const Brand = () => (
    <Column dragRegion style={{ width: 200, shrink: 0, padding: 28, gap: 16, background: c.muted, justify: "end" }}>
      {icon ? <Image src={{ bytes: new Uint8Array(icon), cacheKey: "app-icon" }} width={72} height={72} fit="contain" /> : <View style={{ width: 72, height: 72, radius: 18, background: c.primary }} />}
      <Column gap={2}>
        <Text size={16} weight={650}>{manifest.name}</Text>
        <Text size={12} color={c.mutedForeground}>{t("version")}</Text>
        {manifest.publisher ? <Text size={12} color={c.mutedForeground}>{manifest.publisher}</Text> : null}
      </Column>
    </Column>
  );

  const Footer = ({ children }: { children: Child }) => (
    <Row gap={8} justify="end" style={{ padding: { top: 16 } }}>{children}</Row>
  );

  const Toggle = ({ id, label, description, checked, onChange }: { id: string; label: string; description?: string; checked: boolean; onChange: (value: boolean) => void }) => (
    <Column gap={2}>
      <Checkbox id={id} label={label} checked={checked} onCheckedChange={onChange} />
      {description ? <Text size={12} color={c.mutedForeground} style={{ padding: { left: 27 } }}>{description}</Text> : null}
    </Column>
  );

  const body = (): VNode => {
    const { page, choices } = state;
    const optionText = (value: { label?: string | Record<string, string>; description?: string | Record<string, string> }, fallback: SetupStringKey) => ({
      label: localizedText(value.label, choices.language) ?? t(fallback),
      description: localizedText(value.description, choices.language),
    });
    switch (page) {
      case "welcome":
        return (
          <Column flex={1} gap={20}>
            <Header title={t("welcomeTitle")} text={t("welcomeText")} />
            {manifest.description ? <Text size={13}>{manifest.description}</Text> : null}
            <View flex={1} />
            {manifest.options.language && manifest.languages.length > 1 ? (
              <Row gap={10} align="center">
                <Text size={13} color={c.mutedForeground}>{t("language")}</Text>
                <Select id="setup-language" value={choices.language} style={{ width: 220 }}
                  options={manifest.languages.map(code => ({ value: code, label: LANGUAGE_NAMES[code] ?? code }))}
                  onValueChange={value => { choices.language = value; }} />
              </Row>
            ) : null}
            <Text size={12} color={c.mutedForeground}>{t("spaceRequired", { size: formatSize(manifest.size) })}</Text>
            <Footer>
              <Button id="setup-cancel" variant="outline" onClick={() => app.close()}>{t("cancel")}</Button>
              <Button id="setup-next" onClick={() => go(1)}>{last() ? t("install") : t("next")}</Button>
            </Footer>
          </Column>
        );
      case "directory":
        return (
          <Column flex={1} gap={20}>
            <Header title={t("directoryTitle")} text={t("directoryText")} />
            <Row gap={8} align="center">
              <Input id="setup-directory" value={choices.directory} style={{ flex: 1, shrink: 1, width: "auto", minWidth: 0 }}
                onChange={value => { choices.directory = value; checkDirectory(); }} />
              <Button id="setup-browse" variant="outline" onClick={async () => {
                const picked = await app.openFolderDialog({ title: t("directoryTitle") });
                if (picked) { choices.directory = picked; checkDirectory(); app.update(); }
              }}>{t("browse")}</Button>
            </Row>
            {state.directoryProblem ? <Text size={12} color={c.destructiveText}>{t(state.directoryProblem)}</Text> : null}
            {state.directoryNote ? <Text size={12} color={c.mutedForeground}>{t(state.directoryNote)}</Text> : null}
            <View flex={1} />
            <Text size={12} color={c.mutedForeground}>{t("spaceRequired", { size: formatSize(manifest.size) })}</Text>
            <Footer>
              <Button id="setup-back" variant="outline" onClick={() => go(-1)}>{t("back")}</Button>
              <Button id="setup-next" disabled={!!state.directoryProblem} onClick={() => go(1)}>{last() ? t("install") : t("next")}</Button>
            </Footer>
          </Column>
        );
      case "options":
        return (
          <Column flex={1} gap={20}>
            <Header title={t("optionsTitle")} text={t("optionsText")} />
            <Column gap={14}>
              {manifest.options.desktopShortcut.enabled ? <Toggle id="setup-desktop-shortcut" {...optionText(manifest.options.desktopShortcut, "desktopShortcut")} checked={choices.desktopShortcut} onChange={value => { choices.desktopShortcut = value; }} /> : null}
              {manifest.options.startup.enabled ? <Toggle id="setup-startup" {...optionText(manifest.options.startup, "startup")} checked={choices.startup} onChange={value => { choices.startup = value; }} /> : null}
              {manifest.options.custom.map(option => (
                <Toggle key={option.id} id={`setup-option-${option.id}`} label={localizedText(option.label, choices.language) ?? option.id} description={localizedText(option.description, choices.language)}
                  checked={choices.custom[option.id] ?? option.default} onChange={value => { choices.custom[option.id] = value; }} />
              ))}
              {manifest.options.launch.enabled ? <Toggle id="setup-launch" {...optionText(manifest.options.launch, "launch")} checked={choices.launch} onChange={value => { choices.launch = value; }} /> : null}
            </Column>
            <View flex={1} />
            <Footer>
              <Button id="setup-back" variant="outline" onClick={() => go(-1)}>{t("back")}</Button>
              <Button id="setup-next" onClick={() => go(1)}>{last() ? t("install") : t("next")}</Button>
            </Footer>
          </Column>
        );
      case "installing":
      case "uninstalling":
        return (
          <Column flex={1} gap={20}>
            <Header title={t(page === "installing" ? "installingTitle" : "uninstallingTitle")} text={t("installingText")} />
            <View flex={1} />
            <Column gap={10}>
              <Text size={13}>{t(state.step)}</Text>
              <Progress id="setup-progress" value={Math.round(state.fraction * 100)} label={t(state.step)} />
            </Column>
            <View flex={1} />
            <Footer>
              <Button id="setup-cancel" variant="outline" disabled>{t("cancel")}</Button>
            </Footer>
          </Column>
        );
      case "done":
        return (
          <Column flex={1} gap={20}>
            <Header title={t("doneTitle")} text={t("doneText", { folder: choices.directory })} />
            <View flex={1} />
            <Footer>
              <Button id="setup-finish" onClick={() => app.close()}>{t("finish")}</Button>
            </Footer>
          </Column>
        );
      case "failed":
      case "uninstallFailed":
        return (
          <Column flex={1} gap={20}>
            <Header title={t(page === "failed" ? "failedTitle" : "uninstallFailedTitle")} text={page === "failed" ? t("failedText") : undefined} />
            <View style={{ padding: 12, radius: 8, background: c.muted, borderWidth: 1, borderColor: c.border }}>
              <Text size={12} color={c.destructiveText} style={{ userSelect: "text" }}>{state.error ?? ""}</Text>
            </View>
            <View flex={1} />
            <Footer>
              <Button id="setup-close" variant="outline" onClick={() => app.close()}>{t("close")}</Button>
              <Button id="setup-retry" onClick={() => { if (page === "failed") { state.page = flow[flow.length - 1]!; } else void startUninstall(); }}>{t("retry")}</Button>
            </Footer>
          </Column>
        );
      case "uninstall":
        return (
          <Column flex={1} gap={20}>
            <Header title={t("uninstallTitle")} text={t("uninstallText")} />
            <Text size={12} color={c.mutedForeground}>{state.uninstallDirectory ?? ""}</Text>
            <View flex={1} />
            <Footer>
              <Button id="setup-cancel" variant="outline" onClick={() => app.close()}>{t("cancel")}</Button>
              <Button id="setup-uninstall" variant="destructive" onClick={() => void startUninstall()}>{t("uninstall")}</Button>
            </Footer>
          </Column>
        );
      case "uninstalled":
        return (
          <Column flex={1} gap={20}>
            <Header title={t("uninstalledTitle")} text={t("uninstalledText")} />
            <View flex={1} />
            <Footer>
              <Button id="setup-finish" onClick={() => app.close()}>{t("finish")}</Button>
            </Footer>
          </Column>
        );
    }
  };

  const view = () => (
    <Window title={t("title")} width={WIDTH} height={HEIGHT} minWidth={WIDTH} minHeight={HEIGHT} resizable={false} theme={wizard}
      onCloseRequest={event => { if (state.page === "installing" || state.page === "uninstalling") event.preventDefault(); }}>
      <Row flex={1} align="stretch">
        <Brand />
        <Column flex={1} style={{ minWidth: 0, shrink: 1 }}>
          {/* Tarve's own title bar: frameless window, only minimize and close, drawn over the wizard's surface. */}
          <TitleBar showMaximize={false} height={36} style={{ background: c.background, borderWidth: 0, padding: { left: 28 } }}>
            <Text size={12} color={c.mutedForeground}>{t("title")}</Text>
          </TitleBar>
          <Column flex={1} style={{ minWidth: 0, padding: { top: 4, right: 28, bottom: 28, left: 28 } }}>{body()}</Column>
        </Column>
      </Row>
    </Window>
  );

  app = createApp(view, {
    renderer: "cpu", lowPower: true, closeBehavior: "exit",
    ...(options.icon ? { icon: options.icon } : {}),
    appIdentity: { id: `${manifest.appId}.Setup`, name: t("title"), ...(options.icon ? { icon: options.icon } : {}) },
  });
  await app.ready;
  await app.closed;
  return state.page === "failed" || state.page === "uninstallFailed" ? 1 : 0;
}
