// `tarve package --format setup`: a Windows installer, itself a Tarve app. The wizard
// (setup/app.tsx) is built with `tarve build` for the same runtime as the app, with the app's
// executable (gzipped), icon and setup manifest embedded; the result is
// `<App>-Setup-<version>-win32-x64.exe`. No Inno Setup, NSIS or WiX: it builds from any OS the
// package builds from. The installed app is removed by a copy of the same executable
// (`Uninstall.exe --uninstall`), registered under Apps & features.
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { gzipSync } from "node:zlib";
import { resolveAppAssociations } from "./associations-config";
import { appIconImages, resolveAppMetadata, type AppMetadata } from "./package-metadata";
import { executableInfo, type PackageArtifact, type PackageOptions } from "./package-installer";
import { installFolderName, parseInstallerConfig, type SetupManifest } from "./setup/manifest";
import type { BuildOptions } from "./build";

export interface SetupPackageOptions extends PackageOptions {
  /** Runtime of the installer executable (default: the one `tarve` runs on; txiki for the smallest installer). */
  runtime?: "bun" | "node" | "txiki";
  /** Runtime binary for Windows (Node.js or txiki.js) when cross-building from another OS. */
  targetExecutable?: string;
  /** Native subsystems of the installer's own runtime (default: core only; the wizard needs no more). */
  nativeFeatures?: string | readonly string[];
  smol?: boolean;
  trim?: boolean;
  /** Where the installer's own window chrome and texts take their colour (`#RRGGBB`); default the Tarve theme. */
  accent?: string;
}

/** The nearest package.json above `path`, parsed; undefined without one. */
function nearestPackage(path: string): { manifest: Record<string, unknown>; root: string } | undefined {
  let directory = statSync(path).isDirectory() ? path : dirname(resolve(path));
  for (;;) {
    const candidate = join(directory, "package.json");
    if (existsSync(candidate)) return { manifest: JSON.parse(readFileSync(candidate, "utf8")) as Record<string, unknown>, root: directory };
    const parent = dirname(directory);
    if (parent === directory) return undefined;
    directory = parent;
  }
}

/** The setup manifest of an app: its metadata plus the `tarve.installer` field of its package.json. */
export function setupManifest(executable: string, metadata: AppMetadata, options: Pick<SetupPackageOptions, "entrypoint" | "protocols" | "fileTypes" | "accent">): SetupManifest {
  if (!metadata.version) throw new Error("tarve package --format setup needs --version (or \"version\" in package.json with a \"tarve\" field).");
  const found = nearestPackage(options.entrypoint ?? executable);
  const tarve = found?.manifest.tarve as Record<string, unknown> | undefined;
  const config = parseInstallerConfig(tarve?.installer);
  const associations = resolveAppAssociations(options.entrypoint ?? executable, {
    protocols: options.protocols ? [...options.protocols] : undefined,
    fileTypes: options.fileTypes ? [...options.fileTypes] : undefined,
  });
  const appId = metadata.appId ?? (metadata.name.replace(/[^A-Za-z0-9.]+/g, "").replace(/^[^A-Za-z]+/, "") || "TarveApp");
  const homepage = config.homepage ?? (typeof found?.manifest.homepage === "string" ? found.manifest.homepage : undefined);
  return {
    name: metadata.name,
    version: metadata.version,
    appId,
    ...(metadata.publisher ? { publisher: metadata.publisher } : {}),
    ...(metadata.description ? { description: metadata.description } : {}),
    ...(homepage ? { homepage } : {}),
    executable: basename(executable),
    directory: installFolderName(config.directory ?? metadata.name),
    shortcutName: config.shortcutName ?? metadata.name,
    languages: [...config.languages],
    options: config.options,
    hooks: config.hooks,
    previous: config.previous,
    protocols: [...associations.protocols],
    fileTypes: [...associations.fileTypes],
    strings: config.strings,
    ...((options.accent ?? config.accent) ? { accent: options.accent ?? config.accent } : {}),
    size: statSync(executable).size,
    icon: !!metadata.icon,
  };
}

/** The wizard's module: the TypeScript source in a checkout, the bundle in the npm package. */
function setupAppModule(): string {
  const source = join(import.meta.dirname, "setup", "app.tsx");
  if (existsSync(source)) return source;
  const bundled = join(import.meta.dirname, "setup-app.js");
  if (existsSync(bundled)) return bundled;
  throw new Error(`The installer app is missing from this Tarve package: ${bundled}`);
}

/** The installer entry module `tarve build` compiles: the wizard with the payload, icon and manifest embedded. */
export function writeSetupEntry(directory: string, manifest: SetupManifest, payload: string, icon: string | undefined): string {
  const lines = [
    `import { runSetup } from ${JSON.stringify(setupAppModule())};`,
    `import payload from ${JSON.stringify(payload)} with { type: "file" };`,
    ...(icon ? [`import icon from ${JSON.stringify(icon)} with { type: "file" };`] : []),
    `const manifest = ${JSON.stringify(manifest)};`,
    `process.exitCode = await runSetup(manifest, { payload${icon ? ", icon" : ""} });`,
    "",
  ];
  const entry = join(directory, "setup-entry.ts");
  writeFileSync(entry, lines.join("\n"));
  return entry;
}

/** The installer's file name: `<App>-Setup-<version>-win32-<arch>.exe`. */
export function setupFileName(metadata: AppMetadata, arch: string): string {
  // Accents fold to their base letter: "Periféricos" is "Perifericos-Setup-…".
  const slug = (value: string) => value.normalize("NFD").replace(/[\u0300-\u036f]/g, "").replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "") || "app";
  return `${slug(metadata.name)}-Setup-${slug(metadata.version ?? "0")}-win32-${arch}.exe`;
}

/**
 * Builds the installer of a Windows executable (from `tarve build`). The installer is a Tarve
 * app of the same runtime as `tarve build` would use (`runtime`), so building it needs what
 * that build needs (Bun; or Node.js 26.10+ and, cross-building, the Windows Node binary; or
 * txiki.js).
 */
export async function packageSetup(options: SetupPackageOptions): Promise<PackageArtifact> {
  const executable = resolve(options.executable);
  if (!existsSync(executable)) throw new Error(`Executable not found: ${executable}. Build it first with tarve build.`);
  const info = executableInfo(executable);
  if (info.platform !== "win32") throw new Error("--format setup needs a Windows executable (tarve build --target windows-x64).");
  const metadata = resolveAppMetadata(options.entrypoint ?? executable, {
    name: options.name, version: options.version, description: options.description, publisher: options.publisher,
    copyright: options.copyright, icon: options.icon, appId: options.appId,
  });
  const manifest = setupManifest(executable, metadata, options);
  const outDir = resolve(options.outDir ?? dirname(executable));
  mkdirSync(outDir, { recursive: true });
  const outfile = join(outDir, setupFileName(metadata, info.arch));
  const staging = mkdtempSync(join(tmpdir(), "tarve-setup-build-"));
  try {
    const payload = join(staging, `${manifest.executable}.gz`);
    writeFileSync(payload, gzipSync(readFileSync(executable), { level: 9 }));
    let icon: string | undefined;
    if (metadata.icon) {
      icon = join(staging, "icon.png");
      writeFileSync(icon, appIconImages(metadata.icon).png);
    }
    const entry = writeSetupEntry(staging, manifest, payload, icon);
    const { build } = await import("./build");
    const buildOptions: BuildOptions = {
      entrypoint: entry,
      outfile,
      target: "windows-x64",
      name: `${metadata.name} Setup`,
      version: metadata.version,
      description: `${metadata.name} installer`,
      ...(metadata.publisher ? { publisher: metadata.publisher } : {}),
      ...(metadata.copyright ? { copyright: metadata.copyright } : {}),
      ...(metadata.icon ? { icon: metadata.icon } : {}),
      appId: `${manifest.appId}.Setup`,
      runtime: options.runtime,
      targetExecutable: options.targetExecutable,
      nativeFeatures: options.nativeFeatures ?? "core",
      smol: options.smol,
      trim: options.trim,
    };
    const built = await build(buildOptions);
    return {
      format: "setup",
      path: built,
      note: `installs per user into %LOCALAPPDATA%\\Programs\\${manifest.directory}; silent: ${basename(built)} /S [--dir=…]; sign it like the app (signtool)`,
    };
  } finally {
    rmSync(staging, { recursive: true, force: true });
  }
}
