import type { NativeNodeSet } from "../protocol";

/**
 * A command that writes itself as packed bytes (`NodeSetsCommand`): the FFI bridge sends
 * them instead of JSON. Native reads a leading byte 1 as this format (JSON starts with `{`).
 */
export const PACK: unique symbol = Symbol.for("tarve.pack") as never;

/** A growable byte buffer the packed commands are written into, reused from send to send. */
export class PackWriter {
  bytes = new Uint8Array(65536);
  view = new DataView(this.bytes.buffer);
  length = 0;
  private readonly encoder = new TextEncoder();

  reset(): void {
    this.length = 0;
    // A buffer grown for one large flush is not kept around.
    if (this.bytes.length > 4 * 1048576) this.grow(0, 65536);
  }

  private grow(extra: number, size = 0): void {
    const next = new Uint8Array(Math.max(size, this.length + extra, this.bytes.length * 2));
    next.set(this.bytes.subarray(0, this.length));
    this.bytes = next;
    this.view = new DataView(next.buffer);
  }

  u8(value: number): void {
    if (this.length + 1 > this.bytes.length) this.grow(1);
    this.bytes[this.length++] = value;
  }

  f64(value: number): void {
    if (this.length + 8 > this.bytes.length) this.grow(8);
    this.view.setFloat64(this.length, value, true);
    this.length += 8;
  }

  /** A string as UTF-8 after its byte length (u32): ASCII byte by byte, the rest encoded. */
  string(text: string): void {
    const max = text.length * 3 + 4;
    if (this.length + max > this.bytes.length) this.grow(max);
    const start = this.length + 4;
    let at = start;
    const bytes = this.bytes;
    let index = 0;
    for (; index < text.length; index++) {
      const code = text.charCodeAt(index);
      if (code >= 0x80) break;
      bytes[at++] = code;
    }
    if (index < text.length) at += this.encoder.encodeInto(text.slice(index), bytes.subarray(at)).written;
    this.view.setUint32(this.length, at - start, true);
    this.length = at;
  }
}

/** Record kinds of the packed `setNodes` (see `Command::from_packed_sets`). */
const STYLE_STRING = 1, STYLE_NUMBER = 2, STYLE_JSON = 3, TEXT = 4;

/**
 * The `setNodes` command a signal flush sends: per set the node's id and its new style
 * values or text, kept in flat lists. The FFI bridge sends it packed (`PACK`): no object,
 * string or JSON per node is made for it. A node set twice in one flush is in it twice;
 * the later value of a key wins, as native applies the sets in order. `nodes` (tests,
 * bridges that serialize JSON) is built from the same lists when read.
 */
export class NodeSetsCommand {
  readonly type = "setNodes" as const;
  readonly #ids: string[] = [];
  readonly #styles: (Record<string, unknown> | undefined)[] = [];
  /** `addValue`'s key and value, kept apart until `nodes` is read. */
  readonly #keys: (string | undefined)[] = [];
  readonly #values: unknown[] = [];
  readonly #texts: (string | undefined)[] = [];

  get length(): number {
    return this.#ids.length;
  }

  /** One node's style values and text. */
  add(id: string, style: Record<string, unknown> | undefined, text: string | undefined): void {
    this.#ids.push(id);
    this.#styles.push(style);
    this.#keys.push(undefined);
    this.#values.push(undefined);
    this.#texts.push(text);
  }

  /** One style value of a node, the common signal update, without a style object. */
  addValue(id: string, key: string, value: unknown): void {
    this.#ids.push(id);
    this.#styles.push(undefined);
    this.#keys.push(key);
    this.#values.push(value);
    this.#texts.push(undefined);
  }

  /** Own and enumerable (read like a plain command's), built when read. */
  declare readonly nodes: NativeNodeSet[];

  constructor() {
    Object.defineProperty(this, "nodes", { enumerable: true, get: () => this.#buildNodes() });
  }

  #buildNodes(): NativeNodeSet[] {
    return this.#ids.map((id, index) => {
      const set: NativeNodeSet = { id };
      const key = this.#keys[index];
      const style = this.#styles[index] ?? (key === undefined ? undefined : { [key]: this.#values[index] });
      const text = this.#texts[index];
      if (style) set.style = style as NativeNodeSet["style"];
      if (text !== undefined) set.text = text;
      return set;
    });
  }

  /** Writes the command packed: a 1, then per value a kind, the id, the key and the value. */
  [PACK](out: PackWriter): void {
    out.reset();
    out.u8(1);
    const value = (kind: number, id: string, key: string, data: unknown) => {
      if (kind === STYLE_STRING || kind === STYLE_NUMBER || kind === STYLE_JSON) {
        out.u8(kind);
        out.string(id);
        out.string(key);
        if (kind === STYLE_STRING) out.string(data as string);
        else if (kind === STYLE_NUMBER) out.f64(data as number);
        else out.string(JSON.stringify(data) ?? "null");
      }
    };
    const kindOf = (data: unknown) =>
      typeof data === "string" ? STYLE_STRING : typeof data === "number" && Number.isFinite(data) ? STYLE_NUMBER : STYLE_JSON;
    for (let index = 0; index < this.#ids.length; index++) {
      const id = this.#ids[index]!;
      const key = this.#keys[index];
      if (key !== undefined) {
        const data = this.#values[index];
        value(kindOf(data), id, key, data);
        continue;
      }
      const style = this.#styles[index];
      if (style) for (const name in style) value(kindOf(style[name]), id, name, style[name]);
      const text = this.#texts[index];
      if (text !== undefined) {
        out.u8(TEXT);
        out.string(id);
        out.string(text);
      }
    }
  }

  toJSON(): { type: "setNodes"; nodes: NativeNodeSet[] } {
    return { type: this.type, nodes: this.#buildNodes() };
  }
}
