export const BUILD_TARGETS = ["windows-x64", "linux-x64", "darwin-arm64", "darwin-x64"] as const;
export type BuildTarget = typeof BUILD_TARGETS[number];

/**
 * Targets whose prebuilt release runtimes the npm package must contain (`bun run package`,
 * scripts/release-policy.ts). macOS runtimes are built from a checkout until a macOS
 * release runner stages them.
 */
export const PACKAGED_TARGETS = ["windows-x64", "linux-x64"] as const satisfies readonly BuildTarget[];
export type PackagedTarget = typeof PACKAGED_TARGETS[number];

export interface TargetConfig {
  platform: "win32" | "linux" | "darwin";
  arch: "x64" | "arm64";
  bunTarget: "bun-windows-x64" | "bun-linux-x64" | "bun-darwin-arm64" | "bun-darwin-x64";
  nativeDirectory: "win32-x64" | "linux-x64" | "darwin-arm64" | "darwin-x64";
  nativeName: "tarve_native.dll" | "libtarve_native.so" | "libtarve_native.dylib";
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
  "darwin-arm64": {
    platform: "darwin",
    arch: "arm64",
    bunTarget: "bun-darwin-arm64",
    nativeDirectory: "darwin-arm64",
    nativeName: "libtarve_native.dylib",
    executableSuffix: "",
  },
  "darwin-x64": {
    platform: "darwin",
    arch: "x64",
    bunTarget: "bun-darwin-x64",
    nativeDirectory: "darwin-x64",
    nativeName: "libtarve_native.dylib",
    executableSuffix: "",
  },
};

/** Whether `target` builds a macOS `.app` bundle. */
export function isMacTarget(target: BuildTarget): target is "darwin-arm64" | "darwin-x64" {
  return TARGET_CONFIGS[target].platform === "darwin";
}


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
