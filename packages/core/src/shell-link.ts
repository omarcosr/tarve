const HAS_LINK_TARGET_ID_LIST = 0x01;
// Windows shortcuts (.lnk) written in TypeScript, after MS-SHLLINK: what an installer puts in
// the Start menu and on the desktop. No COM, so it runs in Bun, Node.js and txiki.js alike and
// from any OS. The link carries the target as a LinkInfo local path (plus its Unicode form), the
// working directory, arguments, icon and an AppUserModelID property, which the shell needs to
// group the app's windows, media session and notifications under its own identity.

export interface ShellLinkOptions {
  /** Absolute path of the executable or file the shortcut opens. */
  target: string;
  /** Command-line arguments, already quoted as one string. */
  args?: string;
  workingDirectory?: string;
  /** Tooltip (the shell's "Comment"). */
  description?: string;
  /** Icon file (default: the target) and index in it. */
  icon?: string;
  iconIndex?: number;
  /** Windows AppUserModelID (`Acme.Notes`): taskbar grouping, media controls and notifications. */
  appUserModelId?: string;
}

const HEADER_SIZE = 0x4c;
const LINK_CLSID = [0x01, 0x14, 0x02, 0x00, 0x00, 0x00, 0x00, 0x00, 0xc0, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x46];
const HAS_LINK_INFO = 0x02;
const HAS_NAME = 0x04;
const HAS_WORKING_DIR = 0x10;
const HAS_ARGUMENTS = 0x20;
const HAS_ICON_LOCATION = 0x40;
const IS_UNICODE = 0x80;
const FILE_ATTRIBUTE_NORMAL = 0x80;
const SW_SHOWNORMAL = 1;
const DRIVE_FIXED = 3;
const PROPERTY_STORE_SIGNATURE = 0xa0000009;
const PROPERTY_STORAGE_VERSION = 0x53505331;
/** {9F4C2855-9F79-4B39-A8D0-E1D42DE1D5F3}: System.AppUserModel.*; property 5 is the ID. */
const APP_USER_MODEL_FORMAT = [0x55, 0x28, 0x4c, 0x9f, 0x79, 0x9f, 0x39, 0x4b, 0xa8, 0xd0, 0xe1, 0xd4, 0x2d, 0xe1, 0xd5, 0xf3];
const PID_APP_USER_MODEL_ID = 5;
const VT_LPWSTR = 0x1f;

function utf16(text: string, terminated: boolean): Uint8Array {
  const value = terminated ? `${text}\0` : text;
  const out = new Uint8Array(value.length * 2);
  const view = new DataView(out.buffer);
  for (let index = 0; index < value.length; index++) view.setUint16(index * 2, value.charCodeAt(index), true);
  return out;
}

/** The ANSI copy of a path: ASCII, other characters as `?` (the Unicode copy beside it is what Windows reads). */
function ansi(text: string): Uint8Array {
  const out = new Uint8Array(text.length + 1);
  for (let index = 0; index < text.length; index++) {
    const code = text.charCodeAt(index);
    out[index] = code < 0x80 ? code : 0x3f;
  }
  return out;
}

function concat(parts: readonly Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0));
  let offset = 0;
  for (const part of parts) { out.set(part, offset); offset += part.length; }
  return out;
}

function u32(value: number): Uint8Array {
  const out = new Uint8Array(4);
  new DataView(out.buffer).setUint32(0, value >>> 0, true);
  return out;
}

function u16(value: number): Uint8Array {
  const out = new Uint8Array(2);
  new DataView(out.buffer).setUint16(0, value, true);
  return out;
}

/** StringData: a character count then the UTF-16 text, no terminator. */
function stringData(text: string): Uint8Array {
  if (text.length > 0xffff) throw new RangeError("Shortcut strings are at most 65535 characters");
  return concat([u16(text.length), utf16(text, false)]);
}

/**
 * The LinkTargetIDList: the shell resolves a link through this list of item IDs (My Computer,
 * the drive, then each folder and the file), not through LinkInfo alone. File items carry the
 * ANSI name and a 0xBEEF0004 extension block with the Unicode name.
 */
function idList(target: string): Uint8Array {
  const [drive, ...parts] = target.split(/[\\/]+/).filter(Boolean) as [string, ...string[]];
  const items: Uint8Array[] = [
    new Uint8Array([0x14, 0x00, 0x1f, 0x50, 0xe0, 0x4f, 0xd0, 0x20, 0xea, 0x3a, 0x69, 0x10, 0xa2, 0xd8, 0x08, 0x00, 0x2b, 0x30, 0x30, 0x9d]),
  ];
  const driveItem = new Uint8Array(0x19);
  driveItem.set([0x19, 0x00, 0x2f]);
  driveItem.set(ansi(`${drive.toUpperCase()}\\`), 3);
  items.push(driveItem);
  parts.forEach((name, index) => {
    const directory = index < parts.length - 1;
    const primary = ansi(name.replace(/[^\x20-\x7e]/g, "_"));
    const head = concat([new Uint8Array([directory ? 0x31 : 0x32, 0]), u32(0), u32(0), u16(directory ? 0x10 : 0x20), primary]);
    const padded = concat([head, new Uint8Array(head.length % 2)]);
    const longName = utf16(name, true);
    // Extension block version 3: size, version, signature, creation and access times, identifier,
    // localized-name size (none), the long name and the block's offset in the item.
    const extensionSize = 2 + 2 + 4 + 4 + 4 + 2 + 2 + longName.length + 2;
    const extension = concat([u16(extensionSize), u16(3), u32(0xbeef0004), u32(0), u32(0), u16(0x14), u16(0), longName, u16(2 + padded.length)]);
    items.push(concat([u16(2 + padded.length + extension.length), padded, extension]));
  });
  const list = concat([...items, u16(0)]);
  return concat([u16(list.length), list]);
}

/** LinkInfo with a VolumeID and the local base path, in ANSI and Unicode. */
function linkInfo(target: string): Uint8Array {
  const headerSize = 0x24;
  const volume = concat([u32(0x11), u32(DRIVE_FIXED), u32(0), u32(0x10), new Uint8Array([0])]);
  const basePath = ansi(target);
  const suffix = new Uint8Array([0]);
  const basePathUnicode = utf16(target, true);
  const suffixUnicode = utf16("", true);
  const volumeOffset = headerSize;
  const basePathOffset = volumeOffset + volume.length;
  const suffixOffset = basePathOffset + basePath.length;
  const basePathUnicodeOffset = suffixOffset + suffix.length;
  const suffixUnicodeOffset = basePathUnicodeOffset + basePathUnicode.length;
  const size = suffixUnicodeOffset + suffixUnicode.length;
  return concat([
    u32(size), u32(headerSize), u32(0x1), u32(volumeOffset), u32(basePathOffset), u32(0), u32(suffixOffset),
    u32(basePathUnicodeOffset), u32(suffixUnicodeOffset),
    volume, basePath, suffix, basePathUnicode, suffixUnicode,
  ]);
}

/** A PropertyStoreDataBlock holding System.AppUserModel.ID (MS-PROPSTORE serialized storage). */
function appUserModelBlock(id: string): Uint8Array {
  const text = utf16(id, true);
  const padded = concat([text, new Uint8Array((4 - text.length % 4) % 4)]);
  // ValueSize, Id, Reserved, Type + padding, Length (characters incl. terminator), string.
  const value = concat([u32(4 + 4 + 1 + 4 + 4 + padded.length), u32(PID_APP_USER_MODEL_ID), new Uint8Array([0]), u16(VT_LPWSTR), u16(0), u32(text.length / 2), padded]);
  const storage = concat([u32(4 + 4 + 16 + value.length + 4), u32(PROPERTY_STORAGE_VERSION), new Uint8Array(APP_USER_MODEL_FORMAT), value, u32(0)]);
  const body = concat([storage, u32(0)]);
  return concat([u32(8 + body.length), u32(PROPERTY_STORE_SIGNATURE), body]);
}

/** The bytes of a .lnk file. */
export function createShellLink(options: ShellLinkOptions): Uint8Array {
  const target = options.target;
  if (!/^[A-Za-z]:\\/.test(target)) throw new TypeError(`Shortcut targets are absolute Windows paths (C:\\…): ${target}`);
  let flags = HAS_LINK_TARGET_ID_LIST | HAS_LINK_INFO | IS_UNICODE;
  const strings: Uint8Array[] = [];
  if (options.description) { flags |= HAS_NAME; strings.push(stringData(options.description)); }
  if (options.workingDirectory) { flags |= HAS_WORKING_DIR; strings.push(stringData(options.workingDirectory)); }
  if (options.args) { flags |= HAS_ARGUMENTS; strings.push(stringData(options.args)); }
  const icon = options.icon ?? (options.iconIndex !== undefined ? target : undefined);
  if (icon) { flags |= HAS_ICON_LOCATION; strings.push(stringData(icon)); }
  const header = new Uint8Array(HEADER_SIZE);
  const view = new DataView(header.buffer);
  view.setUint32(0, HEADER_SIZE, true);
  header.set(LINK_CLSID, 4);
  view.setUint32(20, flags, true);
  view.setUint32(24, FILE_ATTRIBUTE_NORMAL, true);
  view.setInt32(56, options.iconIndex ?? 0, true);
  view.setUint32(60, SW_SHOWNORMAL, true);
  const extra = options.appUserModelId ? appUserModelBlock(options.appUserModelId) : new Uint8Array(0);
  return concat([header, idList(target), linkInfo(target), ...strings, extra, u32(0)]);
}

export interface ShellLinkInfo {
  target: string;
  args?: string;
  workingDirectory?: string;
  description?: string;
  icon?: string;
  iconIndex: number;
  appUserModelId?: string;
}

/** Reads back what `createShellLink` wrote (tests, and installers checking an existing shortcut). */
export function readShellLink(bytes: Uint8Array): ShellLinkInfo {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (bytes.length < HEADER_SIZE || view.getUint32(0, true) !== HEADER_SIZE || !LINK_CLSID.every((byte, index) => bytes[4 + index] === byte)) {
    throw new TypeError("Not a Windows shortcut (.lnk)");
  }
  const flags = view.getUint32(20, true);
  const unicode = (flags & IS_UNICODE) !== 0;
  let offset = HEADER_SIZE;
  if (flags & HAS_LINK_TARGET_ID_LIST) offset += 2 + view.getUint16(offset, true);
  let target = "";
  if (flags & HAS_LINK_INFO) {
    const size = view.getUint32(offset, true);
    const headerSize = view.getUint32(offset + 4, true);
    const infoFlags = view.getUint32(offset + 8, true);
    if (infoFlags & 0x1) {
      if (headerSize >= 0x24) {
        const unicodeOffset = view.getUint32(offset + 0x1c, true);
        target = readUtf16Z(bytes, offset + unicodeOffset);
      } else {
        const ansiOffset = view.getUint32(offset + 0x10, true);
        let end = offset + ansiOffset;
        while (bytes[end] !== 0) end++;
        target = new TextDecoder("latin1").decode(bytes.subarray(offset + ansiOffset, end));
      }
    }
    offset += size;
  }
  const readString = (): string => {
    const count = view.getUint16(offset, true);
    offset += 2;
    const text = unicode
      ? new TextDecoder("utf-16le").decode(bytes.subarray(offset, offset + count * 2))
      : new TextDecoder("latin1").decode(bytes.subarray(offset, offset + count));
    offset += unicode ? count * 2 : count;
    return text;
  };
  const info: ShellLinkInfo = { target, iconIndex: view.getInt32(56, true) };
  if (flags & HAS_NAME) info.description = readString();
  if (flags & 0x08) readString();
  if (flags & HAS_WORKING_DIR) info.workingDirectory = readString();
  if (flags & HAS_ARGUMENTS) info.args = readString();
  if (flags & HAS_ICON_LOCATION) info.icon = readString();
  while (offset + 4 <= bytes.length) {
    const size = view.getUint32(offset, true);
    if (size < 4) break;
    if (view.getUint32(offset + 4, true) === PROPERTY_STORE_SIGNATURE) {
      const format = bytes.subarray(offset + 16, offset + 32);
      if (APP_USER_MODEL_FORMAT.every((byte, index) => format[index] === byte) && view.getUint32(offset + 36, true) === PID_APP_USER_MODEL_ID) {
        info.appUserModelId = readUtf16Z(bytes, offset + 49);
      }
    }
    offset += size;
  }
  return info;
}

function readUtf16Z(bytes: Uint8Array, start: number): string {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let end = start;
  while (end + 1 < bytes.length && view.getUint16(end, true) !== 0) end += 2;
  return new TextDecoder("utf-16le").decode(bytes.subarray(start, end));
}
