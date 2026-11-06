/**
 * The nodes one flush sets, in flat lists kept from flush to flush: per node its id, its text
 * and a chain of style values (`first` → `next` into `keys`/`values`).
 */
export class NodeSetQueue {
  readonly ids: string[] = [];
  readonly text: (string | undefined)[] = [];
  readonly first: number[] = [];
  readonly last: number[] = [];
  readonly keys: string[] = [];
  readonly values: unknown[] = [];
  readonly next: number[] = [];
  private readonly index = new Map<string, number>();

  reset(): void {
    this.ids.length = 0;
    this.text.length = 0;
    this.first.length = 0;
    this.last.length = 0;
    this.keys.length = 0;
    this.values.length = 0;
    this.next.length = 0;
    this.index.clear();
  }

  /** The node's slot, added on first use. */
  entry(id: string): number {
    let at = this.index.get(id);
    if (at === undefined) {
      at = this.ids.length;
      this.index.set(id, at);
      this.ids.push(id);
      this.text.push(undefined);
      this.first.push(-1);
      this.last.push(-1);
    }
    return at;
  }

  /** Sets one style value of the node (a later value of the same key wins). */
  style(at: number, key: string, value: unknown): void {
    for (let kv = this.first[at]!; kv >= 0; kv = this.next[kv]!) {
      if (this.keys[kv] === key) { this.values[kv] = value; return; }
    }
    const kv = this.keys.length;
    this.keys.push(key);
    this.values.push(value);
    this.next.push(-1);
    if (this.last[at]! >= 0) this.next[this.last[at]!] = kv;
    else this.first[at] = kv;
    this.last[at] = kv;
  }
}

