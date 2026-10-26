// Code signing and notarization of macOS app bundles. These run Apple's tools (codesign,
// xcrun notarytool, xcrun stapler), so they only work on a Mac; elsewhere they fail with a
// clear error instead of shipping an unsigned bundle.
import { spawnSync } from "node:child_process";

export interface NotarizeOptions {
  /** `xcrun notarytool store-credentials` profile (preferred). Also TARVE_NOTARY_PROFILE. */
  keychainProfile?: string;
  /** Apple ID credentials when there is no keychain profile: APPLE_ID, APPLE_TEAM_ID, APPLE_APP_PASSWORD. */
  appleId?: string;
  teamId?: string;
  password?: string;
}

export interface MacSignOptions {
  /** `Developer ID Application: Acme (TEAMID)`, a certificate hash, or `-` (ad-hoc, local runs only). */
  identity: string;
  /** Entitlements plist for the hardened runtime. Also TARVE_MACOS_ENTITLEMENTS. */
  entitlements?: string;
  /** Submit to Apple's notary service and staple the ticket. */
  notarize?: NotarizeOptions;
}

/** Runs a command and throws when it fails; injectable for tests. */
export type CommandRunner = (command: string, args: readonly string[]) => void;

export const runCommand: CommandRunner = (command, args) => {
  const result = spawnSync(command, [...args], { stdio: "inherit" });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${command} ${args[0] ?? ""} failed (exit ${result.status}).`);
};

/** Throws unless this is macOS: codesign, notarytool and stapler only exist there. */
export function assertMacHost(action: string, platform: NodeJS.Platform = process.platform): void {
  if (platform !== "darwin") {
    throw new Error(`${action} needs macOS (codesign/xcrun). This host is ${platform}: run tarve release on a Mac or a macOS CI runner (e.g. GitHub Actions macos-14).`);
  }
}

/** `codesign` arguments: hardened runtime, secure timestamp (not for ad-hoc), deep, forced. */
export function codesignArgs(app: string, options: MacSignOptions): string[] {
  return [
    "--force", "--deep", "--options", "runtime",
    ...(options.identity === "-" ? [] : ["--timestamp"]),
    ...(options.entitlements ? ["--entitlements", options.entitlements] : []),
    "--sign", options.identity, app,
  ];
}

/** `xcrun notarytool submit` arguments for `zip`, waiting for the verdict. */
export function notarytoolArgs(zip: string, notarize: NotarizeOptions): string[] {
  const credentials = notarize.keychainProfile
    ? ["--keychain-profile", notarize.keychainProfile]
    : notarize.appleId && notarize.teamId && notarize.password
      ? ["--apple-id", notarize.appleId, "--team-id", notarize.teamId, "--password", notarize.password]
      : undefined;
  if (!credentials) throw new Error("Notarization needs a notarytool keychain profile (TARVE_NOTARY_PROFILE) or APPLE_ID, APPLE_TEAM_ID and APPLE_APP_PASSWORD.");
  return ["notarytool", "submit", zip, "--wait", ...credentials];
}

/** Signs `app` (a .app bundle) and verifies the signature. */
export function signMacApp(app: string, options: MacSignOptions, run: CommandRunner = runCommand, platform: NodeJS.Platform = process.platform): void {
  assertMacHost("Signing a macOS app", platform);
  if (!options.identity) throw new Error("macOS signing needs an identity (--sign \"Developer ID Application: …\" or TARVE_MACOS_SIGN_IDENTITY).");
  run("codesign", codesignArgs(app, options));
  run("codesign", ["--verify", "--deep", "--strict", "--verbose=2", app]);
}

/** Submits `zip` (the zipped, signed `app`) for notarization, then staples the ticket to `app`. */
export function notarizeMacApp(app: string, zip: string, notarize: NotarizeOptions, run: CommandRunner = runCommand, platform: NodeJS.Platform = process.platform): void {
  assertMacHost("Notarizing a macOS app", platform);
  run("xcrun", notarytoolArgs(zip, notarize));
  run("xcrun", ["stapler", "staple", app]);
}

/**
 * Signing options from flags and the environment: TARVE_MACOS_SIGN_IDENTITY, TARVE_MACOS_ENTITLEMENTS,
 * and notarization when `notarize` is set or TARVE_NOTARY_PROFILE / APPLE_ID+APPLE_TEAM_ID+APPLE_APP_PASSWORD exist.
 */
export function macSignOptions(
  flags: { identity?: string; entitlements?: string; notarize?: boolean; notaryProfile?: string },
  env: NodeJS.ProcessEnv = process.env,
): MacSignOptions | undefined {
  const identity = flags.identity ?? env.TARVE_MACOS_SIGN_IDENTITY;
  if (!identity) {
    if (flags.notarize) throw new Error("--notarize needs a signing identity (--sign or TARVE_MACOS_SIGN_IDENTITY).");
    return undefined;
  }
  const notarize: NotarizeOptions = {
    keychainProfile: flags.notaryProfile ?? env.TARVE_NOTARY_PROFILE,
    appleId: env.APPLE_ID, teamId: env.APPLE_TEAM_ID, password: env.APPLE_APP_PASSWORD,
  };
  const hasCredentials = !!notarize.keychainProfile || !!(notarize.appleId && notarize.teamId && notarize.password);
  if (flags.notarize && !hasCredentials) notarytoolArgs("", notarize);
  return {
    identity,
    entitlements: flags.entitlements ?? env.TARVE_MACOS_ENTITLEMENTS,
    ...((flags.notarize || (hasCredentials && flags.notarize !== false)) && identity !== "-" ? { notarize } : {}),
  };
}
