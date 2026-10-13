// Lyrics for the song playing: time-synced from LRCLIB (lrclib.net, a free,
// open lyrics database), else the plain text YouTube Music shows.
import { songLyrics, type Song } from "./youtube-music-source";

export interface LyricLine { time: number; text: string }
export interface Lyrics {
  /** Lines with their start time in seconds, when the lyrics are synced. */
  lines: LyricLine[] | null;
  /** The whole text, when they are not. */
  plain: string | null;
  source: string;
}

/** Parses LRC: `[mm:ss.xx] text`, several stamps per line allowed, plus an `[offset:ms]` tag. */
export function parseLrc(text: string): LyricLine[] {
  let offset = 0;
  const lines: LyricLine[] = [];
  for (const raw of text.split(/\r?\n/)) {
    const tag = /^\[offset:\s*([+-]?\d+)\]/i.exec(raw);
    if (tag) { offset = Number(tag[1]) / 1000; continue; }
    const stamps: number[] = [];
    let rest = raw;
    for (let match; (match = /^\[(\d+):(\d+(?:[.:]\d+)?)\]/.exec(rest));) {
      stamps.push(Number(match[1]) * 60 + Number(match[2]!.replace(":", ".")));
      rest = rest.slice(match[0].length);
    }
    for (const time of stamps) lines.push({ time: Math.max(0, time - offset), text: rest.trim() });
  }
  return lines.sort((a, b) => a.time - b.time);
}

/** The line being sung at `time`: the last one that started, or -1 before the first. */
export function lineAt(lines: readonly LyricLine[], time: number): number {
  let low = 0, high = lines.length - 1, found = -1;
  while (low <= high) {
    const middle = (low + high) >> 1;
    if (lines[middle]!.time <= time + 0.15) { found = middle; low = middle + 1; } else high = middle - 1;
  }
  return found;
}

const LRCLIB = "https://lrclib.net/api";
interface LrclibTrack { trackName: string; artistName: string; duration: number; instrumental: boolean; plainLyrics: string | null; syncedLyrics: string | null }

/** Throws when LRCLIB could not be asked (network, 5xx, 429); null when it answered that it has nothing. */
async function lrclib(song: Song, signal?: AbortSignal): Promise<LrclibTrack | null> {
  const artist = song.artist.split(/,| & /)[0]!.trim();
  // A remaster or "feat." suffix is part of YouTube's title, rarely of LRCLIB's.
  const title = song.title.replace(/\s*[([](feat\.?|ft\.|with|from|remaster|\d{4} remaster)[^)\]]*[)\]]/gi, "").trim() || song.title;
  const headers = { "user-agent": "tarve-youtube-music-example (https://github.com/omarcosr/tarve)" };
  const timeout = AbortSignal.timeout(15_000);
  const signals = signal ? AbortSignal.any([signal, timeout]) : timeout;
  const exact = new URLSearchParams({ artist_name: artist, track_name: title });
  if (song.duration) exact.set("duration", String(song.duration));
  const got = await fetch(`${LRCLIB}/get?${exact}`, { headers, signal: signals });
  if (got.ok) return await got.json() as LrclibTrack;
  if (got.status !== 404) throw new Error(`LRCLIB answered HTTP ${got.status}`);
  // No exact match: the closest search hit within a few seconds of the song's length.
  const found = await fetch(`${LRCLIB}/search?${new URLSearchParams({ artist_name: artist, track_name: title })}`, { headers, signal: signals });
  if (!found.ok) throw new Error(`LRCLIB answered HTTP ${found.status}`);
  const hits = (await found.json() as LrclibTrack[]).filter(hit => !song.duration || Math.abs(hit.duration - song.duration) <= 5);
  return hits.find(hit => hit.syncedLyrics) ?? hits.find(hit => hit.plainLyrics || hit.instrumental) ?? null;
}

/**
 * Synced lyrics when LRCLIB has them, else YouTube Music's plain text, else
 * LRCLIB's. Null means neither has lyrics for the song; a failure to ask throws,
 * so the caller can try again later instead of remembering "no lyrics".
 */
export async function lyricsFor(song: Song, signal?: AbortSignal): Promise<Lyrics | null> {
  // A lookup that failed is remembered and thrown only if nothing else answers.
  let failure: unknown = null;
  const attempt = <T>(lookup: Promise<T>): Promise<T | null> => lookup.catch(error => {
    if (signal?.aborted) throw error;
    failure ??= error;
    return null;
  });
  const track = await attempt(lrclib(song, signal));
  const lines = track?.syncedLyrics ? parseLrc(track.syncedLyrics).filter((line, i, all) => line.text || all[i - 1]?.text) : [];
  if (lines.length) return { lines, plain: null, source: "LRCLIB" };
  if (track?.instrumental) return { lines: null, plain: "♪ Instrumental", source: "LRCLIB" };
  const youtube = await attempt(songLyrics(song.id, signal));
  if (youtube) return { lines: null, plain: youtube.text, source: youtube.source };
  if (track?.plainLyrics) return { lines: null, plain: track.plainLyrics, source: "LRCLIB" };
  if (failure) throw failure;
  return null;
}
