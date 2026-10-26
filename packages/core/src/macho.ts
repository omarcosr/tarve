// Mach-O (macOS executable) detection from the first bytes of a file. No Node APIs: the
// updater (src/updates.ts) and the packager (package-installer.ts) share it.

export type MachOKind = "macho64" | "macho32" | "fat";

/** The magic numbers as they appear on disk: MH_MAGIC_64/MH_CIGAM_64, MH_MAGIC/MH_CIGAM, FAT_MAGIC/FAT_CIGAM (and the 64-bit fat variants). */
export const MACHO_MAGICS: readonly Uint8Array[] = [
  Uint8Array.of(0xcf, 0xfa, 0xed, 0xfe), // 0xfeedfacf, little-endian (arm64, x86_64)
  Uint8Array.of(0xfe, 0xed, 0xfa, 0xcf), // 0xfeedfacf, big-endian
  Uint8Array.of(0xce, 0xfa, 0xed, 0xfe), // 0xfeedface, 32-bit little-endian
  Uint8Array.of(0xfe, 0xed, 0xfa, 0xce), // 0xfeedface, 32-bit big-endian
  Uint8Array.of(0xca, 0xfe, 0xba, 0xbe), // universal ("fat") binary, always big-endian
  Uint8Array.of(0xca, 0xfe, 0xba, 0xbf), // fat with 64-bit offsets
];

const CPU_TYPE_X86_64 = 0x01000007;
const CPU_TYPE_ARM64 = 0x0100000c;

function word(bytes: Uint8Array): number {
  return ((bytes[0]! << 24) | (bytes[1]! << 16) | (bytes[2]! << 8) | bytes[3]!) >>> 0;
}

/** The kind of Mach-O file `bytes` (its start) is, or undefined. */
export function machOKind(bytes: Uint8Array): MachOKind | undefined {
  if (bytes.length < 4) return undefined;
  switch (word(bytes)) {
    case 0xfeedfacf: case 0xcffaedfe: return "macho64";
    case 0xfeedface: case 0xcefaedfe: return "macho32";
    case 0xcafebabe: case 0xcafebabf: case 0xbebafeca: case 0xbfbafeca: return "fat";
    default: return undefined;
  }
}

/** The CPU of a thin Mach-O (`cputype` after the magic), `universal` for a fat binary. Needs 8 bytes. */
export function machOArch(bytes: Uint8Array): "arm64" | "x64" | "universal" | undefined {
  const kind = machOKind(bytes);
  if (kind === "fat") return "universal";
  if (!kind || bytes.length < 8) return undefined;
  const little = bytes[0] === 0xcf || bytes[0] === 0xce;
  const cpu = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(4, little);
  return cpu === CPU_TYPE_ARM64 ? "arm64" : cpu === CPU_TYPE_X86_64 ? "x64" : undefined;
}

/** A zip local file header (`PK\x03\x04`): how macOS updates ship a whole `.app`. */
export const ZIP_MAGIC = Uint8Array.of(0x50, 0x4b, 0x03, 0x04);

export function isZip(bytes: Uint8Array): boolean {
  return bytes.length >= 4 && ZIP_MAGIC.every((byte, index) => bytes[index] === byte);
}
