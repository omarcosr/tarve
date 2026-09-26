import type { TextHighlight } from "../../protocol/src/index";

export interface FindRangesOptions {
  text: string;
  query: string;
  caseSensitive?: boolean;
  wholeWord?: boolean;
}

const wordCharacter = /[\p{Alphabetic}\p{Number}_]/u;

function isWordAt(text: string, offset: number): boolean {
  const point = text.codePointAt(offset);
  return point !== undefined && wordCharacter.test(String.fromCodePoint(point));
}

function isWordBefore(text: string, offset: number): boolean {
  if (offset === 0) return false;
  const last = text.charCodeAt(offset - 1);
  return isWordAt(text, last >= 0xdc00 && last <= 0xdfff ? offset - 2 : offset - 1);
}

/** UTF-16 ranges, matching the native highlight protocol. */
export function findRanges({ text, query, caseSensitive = false, wholeWord = false }: FindRangesOptions): Array<{ start: number; end: number }> {
  if (!query || query.length > 4096) return [];
  const ranges: Array<{ start: number; end: number }> = [];
  const expression = new RegExp(query.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), `gu${caseSensitive ? "" : "i"}`);
  for (const found of text.matchAll(expression)) {
    const start = found.index;
    const end = start + found[0].length;
    if (wholeWord && (isWordBefore(text, start) || isWordAt(text, end))) continue;
    ranges.push({ start, end });
    if (ranges.length === 50_000) break;
  }
  return ranges;
}

export interface TextSearchOptions extends Omit<TextHighlight, "ranges" | "activeIndex"> {
  query: string;
}

export interface TextSearchSnapshot {
  props: { highlight: TextHighlight | undefined; onHighlight: (event: { matchCount: number; query?: string; caseSensitive?: boolean; wholeWord?: boolean }) => void };
  total: number;
  active: number;
}

export interface TextSearchController {
  getSnapshot(options: TextSearchOptions): TextSearchSnapshot;
  next(): void;
  previous(): void;
  goTo(index: number): void;
  subscribe(listener: () => void): () => void;
}

/** Framework-neutral navigation for highlight on a native container or leaf. */
export function createTextSearchController(): TextSearchController {
  let options: TextSearchOptions = { query: "" };
  let reported = 0;
  let requested = 0;
  const listeners = new Set<() => void>();
  const emit = () => listeners.forEach(listener => listener());
  const total = () => options.query ? reported : 0;
  const active = () => total() ? Math.min(requested, total() - 1) : 0;
  const onHighlight = (event: { matchCount: number; query?: string; caseSensitive?: boolean; wholeWord?: boolean }) => {
    if (event.query !== undefined && event.query !== options.query) return;
    if (event.caseSensitive !== undefined && event.caseSensitive !== (options.caseSensitive ?? false)) return;
    if (event.wholeWord !== undefined && event.wholeWord !== (options.wholeWord ?? false)) return;
    const count = Number.isSafeInteger(event.matchCount) && event.matchCount > 0 ? event.matchCount : 0;
    if (count === reported) return;
    reported = count;
    emit();
  };
  return {
    getSnapshot(nextOptions) {
      if (nextOptions.query !== options.query || nextOptions.caseSensitive !== options.caseSensitive || nextOptions.wholeWord !== options.wholeWord) {
        reported = 0;
        requested = 0;
      }
      options = nextOptions;
      return {
        props: {
          highlight: options.query ? { ...options, activeIndex: active() } : undefined,
          onHighlight,
        },
        total: total(),
        active: active(),
      };
    },
    next() {
      if (!total()) return;
      requested = (active() + 1) % total();
      emit();
    },
    previous() {
      if (!total()) return;
      requested = (active() + total() - 1) % total();
      emit();
    },
    goTo(index) {
      if (!Number.isInteger(index) || index < 0 || index >= total() || index === active()) return;
      requested = index;
      emit();
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}
