/**
 * Subtitles for `<video subtitles>`: WebVTT and SubRip files parsed into cues, loaded once per
 * source (a path, `file://` or `http(s)://` URL) and shown by the cue under the current time.
 */

export interface SubtitleTrack {
  /** A `.vtt` or `.srt` file: path, `file://` or `http(s)://` URL. */
  src: string;
  /** What a track menu shows (`"Português"`). */
  label?: string;
  /** BCP 47 language (`"pt-BR"`). */
  language?: string;
}

export interface SubtitleCue {
  start: number;
  end: number;
  text: string;
}

const TIME = /(?:(\d+):)?(\d{1,2}):(\d{2})[.,](\d{1,3})/;

function seconds(stamp: string): number | undefined {
  const match = TIME.exec(stamp);
  if (!match) return undefined;
  const [, h = "0", m, s, ms] = match;
  return Number(h) * 3600 + Number(m) * 60 + Number(s) + Number(ms!.padEnd(3, "0")) / 1000;
}

/** WebVTT or SubRip text → cues sorted by start; markup (`<i>`, `{\\an8}`) is dropped. */
export function parseSubtitles(source: string): SubtitleCue[] {
  const cues: SubtitleCue[] = [];
  const blocks = source.replace(/^\uFEFF/, "").replace(/\r\n?/g, "\n").split(/\n{2,}/);
  for (const block of blocks) {
    const lines = block.split("\n");
    const timing = lines.findIndex(line => line.includes("-->"));
    if (timing < 0) continue;
    const [from, rest = ""] = lines[timing]!.split("-->");
    const start = seconds(from!), end = seconds(rest.trim().split(/\s+/)[0] ?? "");
    if (start === undefined || end === undefined || end <= start) continue;
    const text = lines.slice(timing + 1).join("\n").replace(/<[^>]*>/g, "").replace(/\{\\[^}]*\}/g, "")
      .replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&nbsp;/g, " ").trim();
    if (text) cues.push({ start, end, text });
  }
  return cues.sort((a, b) => a.start - b.start);
}

/** The text of the cues showing at `time` (overlapping cues stack). */
export function cueAt(cues: SubtitleCue[], time: number): string {
  let low = 0, high = cues.length;
  while (low < high) {
    const mid = (low + high) >> 1;
    if (cues[mid]!.start <= time) low = mid + 1; else high = mid;
  }
  const shown: string[] = [];
  for (let i = low - 1; i >= 0 && shown.length < 3; i--) {
    const cue = cues[i]!;
    if (cue.end > time) shown.unshift(cue.text);
    if (time - cue.start > 60) break;
  }
  return shown.join("\n");
}

/** When the shown text next changes after `time`: a cue starts or one showing ends. */
export function nextCueChange(cues: SubtitleCue[], time: number): number | undefined {
  let next: number | undefined;
  for (const cue of cues) {
    if (cue.start > time) { next = next === undefined ? cue.start : Math.min(next, cue.start); break; }
    if (cue.end > time) next = next === undefined ? cue.end : Math.min(next, cue.end);
  }
  return next;
}

const timers = new Map<string, ReturnType<typeof setTimeout>>();

/**
 * Renders again `delay` ms from now for `key` (one pending per key): a cue appears or
 * goes on time between the media's `timeupdate`s. `undefined` cancels.
 */
export function scheduleCueRender(key: string, delay: number | undefined): void {
  const pending = timers.get(key);
  if (pending !== undefined) clearTimeout(pending);
  timers.delete(key);
  if (delay === undefined || !Number.isFinite(delay)) return;
  const app = (globalThis as Record<symbol, { update(): void } | undefined>)[ACTIVE_APP];
  const timer = setTimeout(() => { timers.delete(key); app?.update(); }, Math.max(0, Math.ceil(delay)));
  (timer as { unref?: () => void }).unref?.();
  timers.set(key, timer);
}

interface Entry { cues?: SubtitleCue[]; error?: string }
const cache = new Map<string, Entry>();
const ACTIVE_APP = Symbol.for("tarve.activeApp");

async function read(src: string): Promise<string> {
  if (/^https?:\/\//i.test(src)) {
    const response = await fetch(src);
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return response.text();
  }
  const { readFile } = await import("node:fs/promises");
  const path = src.startsWith("file://") ? decodeURIComponent(new URL(src).pathname).replace(/^\/([A-Za-z]:)/, "$1") : src;
  return readFile(path, "utf8");
}

/**
 * The cues of `src`, or undefined while it loads (the app renders again once it has).
 * A file that fails to load shows no cues and logs why once.
 */
export function loadSubtitles(src: string): SubtitleCue[] | undefined {
  const known = cache.get(src);
  if (known) return known.cues;
  const entry: Entry = {};
  cache.set(src, entry);
  const app = (globalThis as Record<symbol, { update(): void } | undefined>)[ACTIVE_APP];
  read(src).then(text => { entry.cues = parseSubtitles(text); }, (error: unknown) => {
    entry.cues = [];
    entry.error = error instanceof Error ? error.message : String(error);
    console.warn(`[tarve] subtitles ${src}: ${entry.error}`);
  }).finally(() => app?.update());
  return undefined;
}

/** Forgets loaded subtitle files (a file changed on disk). */
export function clearSubtitleCache(): void {
  cache.clear();
}
