import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createShellLink, readShellLink } from "./shell-link";

describe("shell links", () => {
  test("round-trips target, arguments, folder, icon and AppUserModelID", () => {
    const bytes = createShellLink({
      target: "C:\\Users\\Ação\\AppData\\Local\\Programs\\Acme Notes\\AcmeNotes.exe",
      args: "--run \"a b\"", workingDirectory: "C:\\Users\\Ação\\AppData\\Local\\Programs\\Acme Notes",
      description: "Notas", icon: "C:\\x\\AcmeNotes.exe", iconIndex: 0, appUserModelId: "Acme.Notes",
    });
    expect(bytes[0]).toBe(0x4c);
    expect(new DataView(bytes.buffer).getUint32(20, true) & 0x83).toBe(0x83);
    expect(readShellLink(bytes)).toEqual({
      target: "C:\\Users\\Ação\\AppData\\Local\\Programs\\Acme Notes\\AcmeNotes.exe",
      args: "--run \"a b\"", workingDirectory: "C:\\Users\\Ação\\AppData\\Local\\Programs\\Acme Notes",
      description: "Notas", icon: "C:\\x\\AcmeNotes.exe", iconIndex: 0, appUserModelId: "Acme.Notes",
    });
  });

  test("a bare link has no optional strings", () => {
    const info = readShellLink(createShellLink({ target: "D:\\app.exe" }));
    expect(info).toEqual({ target: "D:\\app.exe", iconIndex: 0 });
  });

  test("rejects relative targets and non-links", () => {
    expect(() => createShellLink({ target: "app.exe" })).toThrow(/absolute/);
    expect(() => readShellLink(new Uint8Array(10))).toThrow(/shortcut/);
  });

  test.skipIf(process.platform !== "win32")("the Windows shell resolves the link", () => {
    const directory = mkdtempSync(join(tmpdir(), "tarve-lnk-"));
    try {
      const target = join(directory, "Periféricos teste", "Bloco ção.exe");
      const link = join(directory, "Teste.lnk");
      writeFileSync(link, createShellLink({ target, args: "--x", appUserModelId: "Acme.Notes" }));
      const script = `[Console]::OutputEncoding=[Text.Encoding]::UTF8; $s=(New-Object -ComObject WScript.Shell).CreateShortcut('${link}'); $s.TargetPath; $s.Arguments; (New-Object -ComObject Shell.Application).Namespace('${directory}').ParseName('Teste.lnk').ExtendedProperty('System.AppUserModel.ID')`;
      const result = spawnSync("powershell", ["-NoProfile", "-Command", script], { encoding: "utf8" });
      expect(result.status).toBe(0);
      expect(result.stdout.split(/\r?\n/).slice(0, 3)).toEqual([target, "--x", "Acme.Notes"]);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  // PowerShell and its COM objects start slowly on CI runners (over 5 s on windows-latest).
  }, 60_000);
});
