// The installer's own texts, English and Brazilian Portuguese. `{name}`, `{version}`, `{size}`
// and `{folder}` are filled in. An app overrides any key or adds a language with
// `tarve.installer.strings`.
import type { SetupManifest } from "./manifest";

export type SetupStringKey =
  | "title" | "welcomeTitle" | "welcomeText" | "language" | "next" | "back" | "install" | "finish" | "cancel" | "browse"
  | "optionsTitle" | "optionsText" | "directoryTitle" | "directoryText" | "directoryInvalid" | "directoryNotWritable" | "directoryNotEmpty"
  | "desktopShortcut" | "startup" | "launch" | "installingTitle" | "installingText"
  | "stepPrepare" | "stepStop" | "stepCopy" | "stepShortcuts" | "stepRegistry" | "stepHooks" | "stepCleanup"
  | "doneTitle" | "doneText" | "failedTitle" | "failedText" | "retry"
  | "uninstallTitle" | "uninstallText" | "uninstall" | "uninstallingTitle" | "uninstalledTitle" | "uninstalledText" | "uninstallFailedTitle"
  | "stopFailed" | "hookFailed" | "spaceRequired" | "version" | "publisher" | "close";

export const SETUP_STRINGS: Record<"en" | "pt-BR", Record<SetupStringKey, string>> = {
  en: {
    title: "{name} Setup",
    welcomeTitle: "Welcome to {name}",
    welcomeText: "This wizard installs {name} {version} for your user account. No administrator rights are needed.",
    language: "Language",
    next: "Next",
    back: "Back",
    install: "Install",
    finish: "Finish",
    cancel: "Cancel",
    browse: "Browse…",
    optionsTitle: "Options",
    optionsText: "Choose what the setup does besides copying {name}.",
    directoryTitle: "Install folder",
    directoryText: "{name} will be installed in this folder.",
    directoryInvalid: "Enter a full folder path on this computer (for example C:\\Users\\you\\Apps\\{name}).",
    directoryNotWritable: "You cannot write to this folder without administrator rights. Choose a folder of your own, such as the default one.",
    directoryNotEmpty: "This folder holds other files; they stay untouched.",
    desktopShortcut: "Create a desktop shortcut",
    startup: "Start {name} when you sign in to Windows",
    launch: "Open {name} when done",
    installingTitle: "Installing {name}",
    installingText: "This takes a few seconds.",
    stepPrepare: "Preparing…",
    stepStop: "Closing {name}…",
    stepCopy: "Copying {name}…",
    stepShortcuts: "Creating shortcuts…",
    stepRegistry: "Registering {name} with Windows…",
    stepHooks: "Finishing…",
    stepCleanup: "Removing files…",
    doneTitle: "{name} is installed",
    doneText: "{name} {version} is ready in {folder}. Remove it any time from Windows Settings, Apps.",
    failedTitle: "Setup could not finish",
    failedText: "{name} was not installed.",
    retry: "Try again",
    uninstallTitle: "Remove {name}?",
    uninstallText: "This removes {name} and its shortcuts from your computer. Your settings and data stay.",
    uninstall: "Remove",
    uninstallingTitle: "Removing {name}",
    uninstalledTitle: "{name} was removed",
    uninstalledText: "Thanks for using {name}.",
    uninstallFailedTitle: "{name} could not be removed",
    stopFailed: "Close {name} and try again.",
    hookFailed: "{name} reported a problem (exit code {code}).",
    spaceRequired: "Space required: {size}",
    version: "Version {version}",
    publisher: "{publisher}",
    close: "Close",
  },
  "pt-BR": {
    title: "Instalação do {name}",
    welcomeTitle: "Bem-vindo ao {name}",
    welcomeText: "Este assistente instala o {name} {version} para a sua conta de usuário. Não precisa de permissão de administrador.",
    language: "Idioma",
    next: "Avançar",
    back: "Voltar",
    install: "Instalar",
    finish: "Concluir",
    cancel: "Cancelar",
    browse: "Procurar…",
    optionsTitle: "Opções",
    optionsText: "Escolha o que a instalação faz além de copiar o {name}.",
    directoryTitle: "Pasta de instalação",
    directoryText: "O {name} será instalado nesta pasta.",
    directoryInvalid: "Informe o caminho completo de uma pasta neste computador (por exemplo C:\\Users\\você\\Apps\\{name}).",
    directoryNotWritable: "Esta pasta exige permissão de administrador. Escolha uma pasta sua, como a sugerida.",
    directoryNotEmpty: "Esta pasta contém outros arquivos; eles não serão alterados.",
    desktopShortcut: "Criar atalho na área de trabalho",
    startup: "Iniciar o {name} ao entrar no Windows",
    launch: "Abrir o {name} ao concluir",
    installingTitle: "Instalando o {name}",
    installingText: "Isso leva alguns segundos.",
    stepPrepare: "Preparando…",
    stepStop: "Fechando o {name}…",
    stepCopy: "Copiando o {name}…",
    stepShortcuts: "Criando atalhos…",
    stepRegistry: "Registrando o {name} no Windows…",
    stepHooks: "Finalizando…",
    stepCleanup: "Removendo arquivos…",
    doneTitle: "{name} instalado",
    doneText: "O {name} {version} está pronto em {folder}. Remova-o quando quiser em Configurações do Windows, Aplicativos.",
    failedTitle: "A instalação não foi concluída",
    failedText: "O {name} não foi instalado.",
    retry: "Tentar de novo",
    uninstallTitle: "Remover o {name}?",
    uninstallText: "Isto remove o {name} e seus atalhos do computador. Suas configurações e dados ficam.",
    uninstall: "Remover",
    uninstallingTitle: "Removendo o {name}",
    uninstalledTitle: "{name} foi removido",
    uninstalledText: "Obrigado por usar o {name}.",
    uninstallFailedTitle: "Não foi possível remover o {name}",
    stopFailed: "Feche o {name} e tente novamente.",
    hookFailed: "O {name} relatou um problema (código {code}).",
    spaceRequired: "Espaço necessário: {size}",
    version: "Versão {version}",
    publisher: "{publisher}",
    close: "Fechar",
  },
};

/** The language names shown by the picker. */
export const LANGUAGE_NAMES: Record<string, string> = { en: "English", "pt-BR": "Português (Brasil)" };

/** Picks the installer language for a system locale: the manifest's first language that matches (`pt-BR`, then `pt`), else its first. */
export function pickLanguage(manifest: Pick<SetupManifest, "languages">, locale: string | undefined): string {
  const wanted = (locale ?? "").replace("_", "-").toLowerCase();
  if (wanted) {
    const exact = manifest.languages.find(language => language.toLowerCase() === wanted);
    if (exact) return exact;
    const base = wanted.split("-")[0]!;
    const family = manifest.languages.find(language => language.toLowerCase().split("-")[0] === base);
    if (family) return family;
  }
  return manifest.languages[0] ?? "en";
}

/** Human size, binary (`12.3 MB`). */
export function formatSize(bytes: number): string {
  if (bytes < 1024 * 1024) return `${Math.max(1, Math.round(bytes / 1024))} KB`;
  return `${(bytes / 1024 / 1024).toFixed(bytes < 10 * 1024 * 1024 ? 1 : 0)} MB`;
}

/** The text of `key` in `language`: the app's override, else the built-in one, else English. */
export function setupText(manifest: Pick<SetupManifest, "strings" | "name" | "version" | "publisher">, language: string, key: SetupStringKey, params: Record<string, string | number> = {}): string {
  const base = language.split("-")[0]!;
  const builtin = SETUP_STRINGS[language as "en"] ?? SETUP_STRINGS[base as "en"];
  const text = manifest.strings[language]?.[key] ?? manifest.strings[base]?.[key] ?? builtin?.[key] ?? SETUP_STRINGS.en[key];
  const values: Record<string, string | number> = { name: manifest.name, version: manifest.version, publisher: manifest.publisher ?? "", ...params };
  return text.replace(/\{(\w+)\}/g, (match, name: string) => name in values ? String(values[name]) : match);
}
