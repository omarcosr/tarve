import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gunzipSync } from "node:zlib";
import { parseFileTypeFlag, resolveAppAssociations } from "./associations-config";
import { androidManifest } from "./android-build";
import { appxManifest, desktopEntry, packageApp } from "./package-installer";
import { encodePng } from "./src/png";

const decoder = new TextDecoder();
const root = mkdtempSync(join(tmpdir(), "tarve-associations-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));

function tarFiles(gz: Uint8Array): Map<string, string> {
  const bytes = gunzipSync(gz);
  const text = (start: number, length: number) => decoder.decode(bytes.subarray(start, start + length)).replace(/\0.*$/s, "");
  const files = new Map<string, string>();
  for (let offset = 0; offset + 512 <= bytes.length && bytes[offset] !== 0;) {
    const size = Number.parseInt(text(offset + 124, 12), 8);
    const prefix = text(offset + 345, 155);
    files.set((prefix ? prefix + "/" : "") + text(offset, 100), decoder.decode(bytes.subarray(offset + 512, offset + 512 + size)));
    offset += 512 + Math.ceil(size / 512) * 512;
  }
  return files;
}

function arMember(bytes: Uint8Array, name: string): Uint8Array {
  for (let offset = 8; offset < bytes.length;) {
    const header = decoder.decode(bytes.subarray(offset, offset + 60));
    const size = Number(header.slice(48, 58).trim());
    if (header.slice(0, 16).trim() === name) return bytes.subarray(offset + 60, offset + 60 + size);
    offset += 60 + size + (size % 2);
  }
  throw new Error(`no ${name}`);
}

function elf(): Uint8Array {
  const bytes = new Uint8Array(1024).fill(0x41);
  bytes.set([0x7f, 0x45, 0x4c, 0x46, 2, 1, 1, 0], 0);
  new DataView(bytes.buffer).setUint16(18, 0x3e, true);
  return bytes;
}

function project(): string {
  const directory = mkdtempSync(join(root, "app-"));
  const icon = new Uint8Array(64 * 64 * 4).fill(200);
  writeFileSync(join(directory, "note.png"), encodePng(icon, 64, 64));
  writeFileSync(join(directory, "package.json"), JSON.stringify({
    name: "acme-notes", version: "1.2.3",
    tarve: { name: "Acme Notes", appId: "Acme.Notes", protocols: ["acme"], fileTypes: [{ ext: ".tarvenote", name: "Tarve note", icon: "note.png" }] },
  }));
  mkdirSync(join(directory, "dist"));
  writeFileSync(join(directory, "dist", "AcmeNotes"), elf());
  return directory;
}

describe("package associations", () => {
  test("package.json tarve.protocols / fileTypes, plus flags", () => {
    const directory = project();
    const associations = resolveAppAssociations(join(directory, "app.tsx"), { protocols: ["Other"], fileTypes: [parseFileTypeFlag("md=Markdown")] });
    expect(associations.protocols).toEqual(["acme", "other"]);
    expect(associations.fileTypes).toEqual([
      { ext: "tarvenote", name: "Tarve note", icon: join(directory, "note.png") },
      { ext: "md", name: "Markdown" },
    ]);
    expect(parseFileTypeFlag(".log")).toEqual({ ext: "log", name: "LOG file" });
    writeFileSync(join(directory, "package.json"), JSON.stringify({ tarve: { protocols: "acme" } }));
    expect(() => resolveAppAssociations(join(directory, "app.tsx"))).toThrow(/tarve.protocols/);
  });

  test(".desktop entry declares the scheme handler and file MIME types", () => {
    const entry = desktopEntry({ name: "A", exec: "a %U", wmClass: "a", mimeTypes: "x-scheme-handler/acme;application/x-tarvenote;" });
    expect(entry).toContain("MimeType=x-scheme-handler/acme;application/x-tarvenote;\n");
    expect(desktopEntry({ name: "A", exec: "a %U", wmClass: "a" })).not.toContain("MimeType=");
  });

  test(".deb and .tar.gz carry MimeType, shared-mime-info XML and the file type icon", () => {
    const directory = project();
    const [deb, tar] = packageApp({ executable: join(directory, "dist", "AcmeNotes"), format: ["deb", "tar"], mtime: 0 });
    const debBytes = new Uint8Array(readFileSync(deb!.path));
    const data = tarFiles(arMember(debBytes, "data.tar.gz"));
    expect(data.get("./usr/share/applications/Acme.Notes.desktop")).toContain("MimeType=x-scheme-handler/acme;application/x-tarvenote;");
    expect(data.get("./usr/share/mime/packages/Acme.Notes.xml")).toContain('<glob pattern="*.tarvenote"/>');
    expect(data.has("./usr/share/icons/hicolor/64x64/mimetypes/application-x-tarvenote.png")).toBe(true);
    const control = tarFiles(arMember(debBytes, "control.tar.gz"));
    expect(control.get("./postinst")).toContain("update-mime-database /usr/share/mime");

    const files = tarFiles(new Uint8Array(readFileSync(tar!.path)));
    expect(files.get("acme-notes-1.2.3/Acme.Notes.desktop")).toContain("MimeType=x-scheme-handler/acme;application/x-tarvenote;");
    expect(files.get("acme-notes-1.2.3/share/mime/packages/Acme.Notes.xml")).toContain("application/x-tarvenote");
    const install = files.get("acme-notes-1.2.3/install.sh")!;
    expect(install).toContain('cp "$here/share/mime/packages/Acme.Notes.xml" "$data/mime/packages/Acme.Notes.xml"');
    expect(install).toContain('update-mime-database "$data/mime"');
  });

  test("MSIX manifest gets uap:Protocol and uap:FileTypeAssociation", () => {
    const manifest = appxManifest({
      identity: "Acme.Notes", publisher: "CN=Acme", publisherDisplayName: "Acme", version: "1.2.3.0", arch: "x64",
      displayName: "Acme Notes", description: "Notes", executable: "AcmeNotes.exe", applicationId: "AcmeNotes",
      protocols: ["acme"], fileTypes: [{ ext: "tarvenote", name: "Tarve note" }],
    });
    expect(manifest).toMatch(/<\/uap:VisualElements>|Square44x44Logo\.png" \/>\n {6}<Extensions>/);
    expect(manifest).toContain('<uap:Protocol Name="acme" />');
    expect(manifest).toContain('<uap:FileType ContentType="application/x-tarvenote">.tarvenote</uap:FileType>');
    expect(manifest.indexOf("</Extensions>")).toBeLessThan(manifest.indexOf("</Application>"));
    expect(appxManifest({
      identity: "a", publisher: "CN=a", publisherDisplayName: "a", version: "1.0.0.0", arch: "x64",
      displayName: "a", description: "a", executable: "a.exe", applicationId: "a",
    })).not.toContain("<Extensions>");
  });

  test("Android manifest gets a VIEW intent-filter per scheme", () => {
    const manifest = androidManifest({ packageName: "acme.notes", label: "Notes", versionCode: 1, versionName: "1", icon: false, protocols: ["acme"] });
    expect(manifest).toContain('<data android:scheme="acme"/>');
    expect(manifest.indexOf('android:scheme="acme"')).toBeLessThan(manifest.indexOf("</activity>"));
    expect(androidManifest({ packageName: "a.b", label: "A", versionCode: 1, versionName: "1", icon: false })).not.toContain("android.intent.action.VIEW");
  });
});
