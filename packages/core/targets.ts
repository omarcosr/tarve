export const BUILD_TARGETS = ["windows-x64", "linux-x64"] as const;
export type BuildTarget = typeof BUILD_TARGETS[number];

export interface TargetConfig {
  platform: "win32" | "linux";
  arch: "x64";
  bunTarget: "bun-windows-x64" | "bun-linux-x64";
  nativeDirectory: "win32-x64" | "linux-x64";
  nativeName: "tarve_native.dll" | "libtarve_native.so";
  executableSuffix: ".exe" | "";
}

export const TARGET_CONFIGS: Readonly<Record<BuildTarget, TargetConfig>> = {
  "windows-x64": {
    platform: "win32",
    arch: "x64",
    bunTarget: "bun-windows-x64",
    nativeDirectory: "win32-x64",
    nativeName: "tarve_native.dll",
    executableSuffix: ".exe",
  },
  "linux-x64": {
    platform: "linux",
    arch: "x64",
    bunTarget: "bun-linux-x64",
    nativeDirectory: "linux-x64",
    nativeName: "libtarve_native.so",
    executableSuffix: "",
  },
};

export function isBuildTarget(value: string): value is BuildTarget {
  return (BUILD_TARGETS as readonly string[]).includes(value);
}

export function targetConfig(target: BuildTarget): TargetConfig {
  return TARGET_CONFIGS[target];
}

export function hostBuildTarget(
  platform: NodeJS.Platform = process.platform,
  arch: string = process.arch,
): BuildTarget | undefined {
  return BUILD_TARGETS.find(target => {
    const config = TARGET_CONFIGS[target];
    return config.platform === platform && config.arch === arch;
  });
}

export function nativeDirectoryForBuildTarget(target: BuildTarget): TargetConfig["nativeDirectory"] {
  return TARGET_CONFIGS[target].nativeDirectory;
}

export function nativeRelativePath(target: BuildTarget): string {
  const config = TARGET_CONFIGS[target];
  return `native/${config.nativeDirectory}/${config.nativeName}`;
}
