// Queue rules for the youtube-music example: a song (one artist's title) is in the queue
// once, even when YouTube lists it under different videos (the official video, the audio
// track, a lyric video, "Artist - Title" uploads), and shuffle spreads songs and artists out.
import type { Song } from "./youtube-music-source";

/** Version tags YouTube adds to a title that do not make it a different song. */
const NOISE = /\b(official|video|audio|lyrics?|visuali[sz]er|music|clip|videoclipe|mv|hd|hq|4k|remaster(ed)?|explicit|letra|legendado|ao vivo|live)\b/;

const clean = (text: string) => text.normalize("NFD").replace(/[\u0300-\u036f]/g, "").replace(/[^\p{L}\p{N}]+/gu, " ").trim();

/** The first artist, compared without spaces or channel suffixes: "The Weeknd", "TheWeekndVEVO" and "The Weeknd - Topic" match. */
function artistKey(artist: string): string {
  return clean(artist.toLowerCase().split(/,|&|\s(?:x|e|and|feat\.?|ft\.?)\s|•/)[0]!).replace(/ /g, "").replace(/(vevo|topic|official|oficial)$/, "");
}

/** The same song under any of its videos: its first artist and its title without version tags. */
export function songKey(song: Pick<Song, "id" | "title" | "artist">): string {
  const artist = artistKey(song.artist);
  let title = song.title.toLowerCase()
    .replace(/[([{]([^)\]}]*)[)\]}]/g, (all, inner: string) => (NOISE.test(inner) || /\b(feat|ft)\b/.test(inner) ? " " : all));
  // Uploads titled "Artist - Title" (or "Title - Artist"): the artist part is not the title.
  const dash = /^(.+?)\s[-–|]\s(.+)$/.exec(title);
  if (dash && artist) {
    if (artistKey(dash[1]!) === artist) title = dash[2]!;
    else if (artistKey(dash[2]!) === artist) title = dash[1]!;
  }
  title = clean(title
    .replace(/\s[-–|]\s(.*)$/, (all, tail: string) => (NOISE.test(tail) ? " " : all))
    .replace(/\b(feat|ft)\.?\s.*$/, " "));
  return title ? `${artist}|${title}` : `id:${song.id}`;
}

export function sameSong(a: Song | undefined, b: Song | undefined): boolean {
  return !!a && !!b && (a.id === b.id || songKey(a) === songKey(b));
}

/** Drops each song that repeats the one just before it; `index` follows the song it pointed at. */
/**
 * Keeps each song once (its first copy), so it cannot come back a song or two later; the song
 * at `index` (the one picked) wins over earlier copies, and `index` follows it.
 */
export function distinct(songs: readonly Song[], index = 0): { songs: Song[]; index: number } {
  const picked = songs[index] ? songKey(songs[index]!) : null;
  const seen = new Set<string>();
  const out: Song[] = [];
  let at = 0;
  songs.forEach((song, i) => {
    const key = songKey(song);
    if (i === index) { at = out.length; out.push(song); seen.add(key); return; }
    if (seen.has(key) || (i < index && key === picked)) return;
    seen.add(key);
    out.push(song);
  });
  return { songs: out, index: at };
}

/**
 * Orders `songs` so neighbours differ: never the same song twice in a row (nor `after`
 * then itself), and, where the list allows, not the same artist back to back.
 */
export function spread(songs: readonly Song[], after?: Song): Song[] {
  const rest = [...songs];
  const out: Song[] = [];
  const artist = (song: Song | undefined) => (song ? songKey(song).split("|")[0] : undefined);
  while (rest.length) {
    const previous = out.at(-1) ?? after;
    let pick = rest.findIndex(song => !sameSong(song, previous) && artist(song) !== artist(previous));
    if (pick < 0) pick = rest.findIndex(song => !sameSong(song, previous));
    // Only repeats of the previous song are left: they would play back to back, so they go.
    if (pick < 0) break;
    out.push(rest.splice(pick, 1)[0]!);
  }
  return out;
}

/** A random order where neighbours still differ (see `spread`). */
export function shuffled(songs: readonly Song[], after?: Song, random: () => number = Math.random): Song[] {
  const list = [...songs];
  for (let i = list.length - 1; i > 0; i--) { const j = Math.floor(random() * (i + 1));[list[i], list[j]] = [list[j]!, list[i]!]; }
  return spread(list, after);
}
