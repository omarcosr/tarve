import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { isZip, machOArch, machOKind } from "./macho";
import { executableMagic, looksExecutable, macBundleOf, planMacBundleUpdate } from "./updates";

const bytes = (...values: number[]) => Uint8Array.of(...values);

describe("Mach-O detection", () => {
  test("recognizes 64-bit, 32-bit and universal binaries in both byte orders", () => {
    expect(machOKind(bytes(0xcf, 0xfa, 0xed, 0xfe))).toBe("macho64"); // 0xfeedfacf on disk (little-endian)
    expect(machOKind(bytes(0xfe, 0xed, 0xfa, 0xcf))).toBe("macho64");
    expect(machOKind(bytes(0xce, 0xfa, 0xed, 0xfe))).toBe("macho32");
    expect(machOKind(bytes(0xca, 0xfe, 0xba, 0xbe))).toBe("fat");
    expect(machOKind(bytes(0x7f, 0x45, 0x4c, 0x46))).toBeUndefined();
    expect(machOKind(bytes(0xcf, 0xfa))).toBeUndefined();
  });

  test("reads the CPU of a thin binary", () => {
    expect(machOArch(bytes(0xcf, 0xfa, 0xed, 0xfe, 0x0c, 0, 0, 0x01))).toBe("arm64");
    expect(machOArch(bytes(0xcf, 0xfa, 0xed, 0xfe, 0x07, 0, 0, 0x01))).toBe("x64");
    expect(machOArch(bytes(0xfe, 0xed, 0xfa, 0xcf, 0x01, 0, 0, 0x0c))).toBe("arm64");
    expect(machOArch(bytes(0xca, 0xfe, 0xba, 0xbe, 0, 0, 0, 2))).toBe("universal");
    expect(machOArch(bytes(0xcf, 0xfa, 0xed, 0xfe, 0x12, 0, 0, 0))).toBeUndefined();
  });

  test("darwin update artifacts are Mach-O or a zipped .app", () => {
    expect(looksExecutable(bytes(0xcf, 0xfa, 0xed, 0xfe), "darwin-arm64")).toBe(true);
    expect(looksExecutable(bytes(0xca, 0xfe, 0xba, 0xbe), "darwin-x64")).toBe(true);
    expect(looksExecutable(bytes(0x50, 0x4b, 0x03, 0x04), "darwin-arm64")).toBe(true);
    expect(isZip(bytes(0x50, 0x4b, 0x03, 0x04))).toBe(true);
    expect(looksExecutable(bytes(0x7f, 0x45, 0x4c, 0x46), "darwin-arm64")).toBe(false);
    expect(looksExecutable(bytes(0xcf, 0xfa, 0xed, 0xfe), "linux-x64")).toBe(false);
    expect(looksExecutable(bytes(0x50, 0x4b, 0x03, 0x04), "win32-x64")).toBe(false);
    expect([...executableMagic("darwin-arm64")!]).toEqual([0xcf, 0xfa, 0xed, 0xfe]);
    expect([...executableMagic("win32-x64")!]).toEqual([0x4d, 0x5a]);
  });
});

describe("macOS bundle updates", () => {
  test("find the .app around an executable", () => {
    const app = join("/Applications", "Acme Notes.app");
    const executable = join(app, "Contents", "MacOS", "Acme Notes");
    expect(macBundleOf(executable)).toBe(app);
    expect(macBundleOf(join("/usr", "local", "bin", "notes"))).toBeUndefined();
    expect(macBundleOf(join("/Applications", "Notes", "Contents", "MacOS", "Notes"))).toBeUndefined();
  });

  test("plan a whole-bundle swap beside the running app", () => {
    const app = join("/Applications", "Acme Notes.app");
    expect(planMacBundleUpdate(join(app, "Contents", "MacOS", "Acme Notes"))).toEqual({
      bundle: app,
      executable: "Contents/MacOS/Acme Notes",
      staging: join("/Applications", ".Acme Notes.app.update"),
      backup: `${app}.old`,
    });
    expect(planMacBundleUpdate(join("/opt", "notes"))).toBeUndefined();
  });
});
