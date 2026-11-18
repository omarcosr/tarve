// Per-argument marshalling for threadsafeCallback (native/src/threadsafe/marshal.rs, native ABI 9):
// what a call keeps or copies from an argument before it returns, because its caller releases or
// frees what the argument names afterwards (a UI Automation sender, the BSTR in a VARIANT).
import type { ThreadsafeArgType } from "./threadsafe";

/**
 * A pointer argument the call keeps or copies before it returns:
 * - `keep: "com"`: AddRefs the interface pointer; the callback gets it and must `releaseCom` it.
 * - `copy: bytes`: copies that many bytes it points to (a Uint8Array), as the `copy` option does.
 * - `copy: "bstr"` (Windows): the BSTR's text, a string ("" for a null BSTR).
 * - `copy: "variant"` (Windows): a VARIANT passed by pointer or by value (24 bytes, which the x64
 *   and arm64 Windows conventions pass as a pointer to a caller's copy), as a `ThreadsafeVariant`.
 * A null pointer arrives as null.
 */
export type ThreadsafeArgSpec =
  | { readonly type: "ptr"; readonly keep: "com" }
  | { readonly type: "ptr"; readonly copy: number | "bstr" | "variant" };

export type ThreadsafeArg = ThreadsafeArgType | ThreadsafeArgSpec;

/**
 * A copied VARIANT: VT_BSTR a string; VT_I1/I2/I4/INT/UI1/UI2/UI4/UINT/R4/R8 a number; VT_BOOL a
 * boolean; VT_EMPTY/VT_NULL null; VT_UNKNOWN/VT_DISPATCH the AddRef'd interface pointer (a bigint
 * to `releaseCom`, null when null); any other type its 24 raw bytes.
 */
export type ThreadsafeVariant = string | number | boolean | null | bigint | Uint8Array;

/** Set in a record's copied length when its copied bytes are segments. */
export const TAGGED = 0x80000000;
const KIND = { raw: 0, bytes: 1, com: 2, bstr: 3, variant: 4 } as const;
const TAG = { null: 0, data: 1, object: 2, text: 3, number: 4, boolean: 5, raw: 6 } as const;

/**
 * The plain types of `args`, and the native specs (kind u32, length u32 per argument) when any is
 * marshalled; a `copy` option alongside is folded in as a byte copy.
 */
export function marshalSpecs(
  args: readonly ThreadsafeArg[],
  copy: { readonly arg: number; readonly bytes: number } | undefined,
  maxCopy: number,
): { types: ThreadsafeArgType[]; specs: Uint8Array | null } {
  const types: ThreadsafeArgType[] = [];
  const specs = new Uint8Array(Math.max(1, args.length) * 8);
  const view = new DataView(specs.buffer);
  let marshalled = false;
  args.forEach((arg, index) => {
    if (typeof arg === "string") {
      types.push(arg);
      return;
    }
    if (!arg || typeof arg !== "object" || arg.type !== "ptr") throw new TypeError(`threadsafeCallback: argument ${index} must be a type or { type: "ptr", keep | copy }`);
    const kept = "keep" in arg, copied = "copy" in arg;
    if (kept === copied) throw new TypeError(`threadsafeCallback: argument ${index} takes keep or copy, not both or neither`);
    let kind: number, length = 0;
    if (kept) {
      if (arg.keep !== "com") throw new TypeError(`threadsafeCallback: argument ${index}: keep must be "com"`);
      kind = KIND.com;
    } else {
      const what = (arg as { copy: unknown }).copy;
      if (what === "bstr" || what === "variant") kind = KIND[what];
      else if (typeof what === "number" && Number.isInteger(what) && what > 0 && what <= maxCopy) [kind, length] = [KIND.bytes, what];
      else throw new RangeError(`threadsafeCallback: argument ${index}: copy must be "bstr", "variant" or 1 to ${maxCopy} bytes`);
    }
    types.push("ptr");
    view.setUint32(index * 8, kind, true);
    view.setUint32(index * 8 + 4, length, true);
    marshalled = true;
  });
  if (!marshalled) return { types, specs: null };
  if (copy) {
    if (typeof args[copy.arg] !== "string") throw new RangeError("threadsafeCallback: copy.arg must name a plain \"ptr\" argument");
    view.setUint32(copy.arg * 8, KIND.bytes, true);
    view.setUint32(copy.arg * 8 + 4, copy.bytes, true);
  }
  return { types, specs };
}

const utf8 = new TextDecoder();

/** Walks the segments in `bytes[start, end)`: argument index, tag, data offset and length. */
function walk(bytes: Uint8Array, start: number, end: number, visit: (arg: number, tag: number, at: number, length: number) => void): void {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  for (let at = start; at + 8 <= end;) {
    const length = view.getUint32(at + 4, true);
    visit(bytes[at]!, bytes[at + 1]!, at + 8, length);
    at += 8 + length;
  }
}

/** A marshalled call's values by argument index. */
export function segmentValues(bytes: Uint8Array, start: number, end: number): Map<number, unknown> {
  const values = new Map<number, unknown>();
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  walk(bytes, start, end, (arg, tag, at, length) => {
    switch (tag) {
      case TAG.data: case TAG.raw: values.set(arg, bytes.slice(at, at + length)); break;
      case TAG.object: values.set(arg, view.getBigUint64(at, true)); break;
      case TAG.text: values.set(arg, utf8.decode(bytes.subarray(at, at + length))); break;
      case TAG.number: values.set(arg, view.getFloat64(at, true)); break;
      case TAG.boolean: values.set(arg, bytes[at] !== 0); break;
      default: values.set(arg, null);
    }
  });
  return values;
}

/** The interface pointers a marshalled call kept, for a record no callback takes. */
export function heldObjects(bytes: Uint8Array, start: number, end: number): bigint[] {
  const objects: bigint[] = [];
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  walk(bytes, start, end, (_arg, tag, at) => { if (tag === TAG.object) objects.push(view.getBigUint64(at, true)); });
  return objects;
}
