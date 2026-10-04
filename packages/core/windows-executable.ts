import { readFileSync, writeFileSync } from "node:fs";
import { NtExecutable, NtExecutableResource, Resource } from "resedit";

export interface WindowsExecutableInfo {
  name: string;
  version: string;
  filename: string;
}

const IMAGE_SUBSYSTEM_WINDOWS_GUI = 2;

/** Windows numeric versions have four 16-bit parts; "1.2.3-beta.4" becomes 1.2.3.0. */
function numericVersion(version: string): [number, number, number, number] {
  const parts = version.split(/[.+-]/).slice(0, 4).map(part => Number.parseInt(part, 10));
  return [0, 1, 2, 3].map(index => {
    const value = parts[index];
    return Number.isInteger(value) && value! >= 0 && value! <= 0xffff ? value! : 0;
  }) as [number, number, number, number];
}

/**
 * Give a Node.js single-executable app the identity `bun build --compile` gives a
 * Tarve app: its own name, description and version instead of Node.js branding, and
 * the GUI subsystem so double-clicking it does not open a console window.
 */
export function brandWindowsExecutable(path: string, info: WindowsExecutableInfo): void {
  const executable = NtExecutable.from(readFileSync(path), { ignoreCert: true });
  const resources = NtExecutableResource.from(executable);
  const versionInfo = Resource.VersionInfo.fromEntries(resources.entries)[0] ?? Resource.VersionInfo.createEmpty();
  const languages = versionInfo.getAllLanguagesForStringValues();
  if (languages.length === 0) languages.push({ lang: 1033, codepage: 1200 });
  const [major, minor, patch, revision] = numericVersion(info.version);
  const text = `${major}.${minor}.${patch}.${revision}`;
  for (const language of languages) {
    for (const key of ["CompanyName", "LegalCopyright", "LegalTrademarks", "Comments", "PrivateBuild", "SpecialBuild"]) {
      versionInfo.removeStringValue(language, key);
    }
    versionInfo.setStringValues(language, {
      FileDescription: `${info.name} — native Tarve application`,
      ProductName: info.name,
      InternalName: info.name,
      OriginalFilename: info.filename,
      FileVersion: text,
      ProductVersion: text,
    });
  }
  versionInfo.setFileVersion(major, minor, patch, revision);
  versionInfo.setProductVersion(major, minor, patch, revision);
  versionInfo.outputToResourceEntries(resources.entries);
  resources.outputResource(executable);
  const output = Buffer.from(executable.generate());
  output.writeUInt16LE(IMAGE_SUBSYSTEM_WINDOWS_GUI, output.readUInt32LE(0x3c) + 24 + 68);
  writeFileSync(path, output);
}
