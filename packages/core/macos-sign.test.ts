import { describe, expect, test } from "bun:test";
import { codesignArgs, macSignOptions, notarizeMacApp, notarytoolArgs, signMacApp } from "./macos-sign";

describe("macOS signing", () => {
  test("codesign uses the hardened runtime, deep signing and a timestamp", () => {
    expect(codesignArgs("/tmp/App.app", { identity: "Developer ID Application: Acme (TEAM)", entitlements: "app.entitlements" })).toEqual([
      "--force", "--deep", "--options", "runtime", "--timestamp", "--entitlements", "app.entitlements",
      "--sign", "Developer ID Application: Acme (TEAM)", "/tmp/App.app",
    ]);
    expect(codesignArgs("/tmp/App.app", { identity: "-" })).not.toContain("--timestamp");
  });

  test("runs codesign, verify, notarytool and stapler on macOS", () => {
    const calls: string[] = [];
    const run = (command: string, args: readonly string[]) => { calls.push([command, ...args].join(" ")); };
    signMacApp("/A.app", { identity: "ID" }, run, "darwin");
    notarizeMacApp("/A.app", "/A.zip", { keychainProfile: "notary" }, run, "darwin");
    expect(calls).toEqual([
      "codesign --force --deep --options runtime --timestamp --sign ID /A.app",
      "codesign --verify --deep --strict --verbose=2 /A.app",
      "xcrun notarytool submit /A.zip --wait --keychain-profile notary",
      "xcrun stapler staple /A.app",
    ]);
  });

  test("fails clearly off macOS", () => {
    const run = () => { throw new Error("must not run"); };
    expect(() => signMacApp("/A.app", { identity: "ID" }, run, "win32")).toThrow("needs macOS");
    expect(() => notarizeMacApp("/A.app", "/A.zip", { keychainProfile: "p" }, run, "linux")).toThrow("needs macOS");
  });

  test("reads options from flags and the environment", () => {
    expect(macSignOptions({}, {})).toBeUndefined();
    expect(() => macSignOptions({ notarize: true }, {})).toThrow("signing identity");
    expect(() => macSignOptions({ identity: "ID", notarize: true }, {})).toThrow("keychain profile");
    expect(macSignOptions({}, { TARVE_MACOS_SIGN_IDENTITY: "ID" })).toEqual({ identity: "ID", entitlements: undefined });
    expect(macSignOptions({ identity: "ID" }, { TARVE_NOTARY_PROFILE: "p" })!.notarize?.keychainProfile).toBe("p");
    expect(macSignOptions({ identity: "ID", notarize: false }, { TARVE_NOTARY_PROFILE: "p" })!.notarize).toBeUndefined();
    expect(notarytoolArgs("a.zip", { appleId: "me@acme.dev", teamId: "TEAM", password: "pw" }))
      .toEqual(["notarytool", "submit", "a.zip", "--wait", "--apple-id", "me@acme.dev", "--team-id", "TEAM", "--password", "pw"]);
  });
});
