// YouTube Music for the youtube-music example: a small InnerTube client (the
// private JSON API YouTube Music's own web app uses), which also finds each
// song's audio URL; Tarve's <audio> streams it.
// It lives in the example only; Tarve itself knows nothing about YouTube and
// streams the URL with <audio>. Talking to InnerTube outside
// YouTube's apps is against YouTube's Terms of Service; this is a personal demo.
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export interface Song {
  kind: "song";
  id: string;
  title: string;
  artist: string;
  album: string;
  /** Seconds, when YouTube reports it. */
  duration: number | null;
  thumbnail: string | null;
}
export interface Collection {
  kind: "playlist" | "album" | "artist";
  /** InnerTube browse id: VL… playlist, MPRE… album, UC… artist. */
  id: string;
  title: string;
  subtitle: string;
  thumbnail: string | null;
}
export type Item = Song | Collection;
export interface Shelf { title: string; items: Item[] }
export interface CollectionPage { header: Collection; songs: Song[] }

const dataDir = join(homedir(), ".tarve-youtube-music");
const cookieFile = join(dataDir, "cookies.txt");
const ORIGIN = "https://music.youtube.com";
const USER_AGENT = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36";

// ---- session --------------------------------------------------------------

let cookie: string | null = process.env.YTM_COOKIE ?? (existsSync(cookieFile) ? readFileSync(cookieFile, "utf8").trim() || null : null);

let parsed: { from: string | null; values: Map<string, string> } = { from: null, values: new Map() };
function cookieValue(name: string): string | null {
  if (parsed.from !== cookie) {
    const values = new Map<string, string>();
    for (const pair of cookie?.split(/;\s*/) ?? []) {
      const at = pair.indexOf("=");
      if (at > 0) values.set(pair.slice(0, at), pair.slice(at + 1));
    }
    parsed = { from: cookie, values };
  }
  return parsed.values.get(name) ?? null;
}

export function signedIn(): boolean {
  return !!(cookieValue("SAPISID") ?? cookieValue("__Secure-3PAPISID"));
}

/** Keeps a `Cookie` header that proves a signed-in Google account. */
export function useCookies(header: string): void {
  const pairs = header.split(";").map(part => part.trim()).filter(pair => /^[^=\s]+=\S*$/.test(pair));
  const next = pairs.join("; ");
  if (!/(^|; )(SAPISID|__Secure-3PAPISID)=/.test(next)) throw new Error("Those cookies carry no SAPISID: sign in to music.youtube.com first.");
  cookie = next;
  mkdirSync(dataDir, { recursive: true });
  writeFileSync(cookieFile, next);
}

export function signOut(): void {
  cookie = null;
  rmSync(cookieFile, { force: true });
}

/** Google's request signature for a signed-in session: SHA-1 of time, SAPISID and origin. */
function authorization(): string | null {
  const sapisid = cookieValue("SAPISID") ?? cookieValue("__Secure-3PAPISID");
  if (!sapisid) return null;
  const now = Math.floor(Date.now() / 1000);
  return `SAPISIDHASH ${now}_${createHash("sha1").update(`${now} ${sapisid} ${ORIGIN}`).digest("hex")}`;
}

async function call(endpoint: "browse" | "search", body: Record<string, unknown>, query = ""): Promise<any> {
  const headers: Record<string, string> = { "content-type": "application/json", origin: ORIGIN, "x-origin": ORIGIN, "user-agent": USER_AGENT };
  const auth = authorization();
  if (cookie && auth) Object.assign(headers, { cookie, authorization: auth, "x-goog-authuser": "0" });
  const context = { client: { clientName: "WEB_REMIX", clientVersion: "1.20250101.01.00", hl: "en", gl: "US" } };
  const response = await fetch(`${ORIGIN}/youtubei/v1/${endpoint}?prettyPrint=false${query}`, { method: "POST", headers, body: JSON.stringify({ context, ...body }) });
  if (!response.ok) throw new Error(`YouTube Music answered HTTP ${response.status}${response.status === 401 ? " (signed out? sign in again)" : ""}`);
  return response.json();
}

// ---- parsing --------------------------------------------------------------

/** Every value under `key` anywhere in `node`, in document order (not descending into matches). */
function findAll(node: any, key: string, out: any[] = []): any[] {
  if (Array.isArray(node)) for (const child of node) findAll(child, key, out);
  else if (node && typeof node === "object") {
    for (const [name, value] of Object.entries(node)) {
      if (name === key) out.push(value);
      else findAll(value, key, out);
    }
  }
  return out;
}
const first = (node: any, key: string) => findAll(node, key)[0];
const runs = (text: any): any[] => text?.runs ?? [];
const plain = (text: any): string => runs(text).map(run => run.text).join("") || text?.simpleText || "";

function thumbnail(node: any): string | null {
  const list: any[] = first(node, "thumbnails") ?? [];
  return list.at(-1)?.url ?? null;
}
function seconds(label: string): number | null {
  if (!/^\d+(:\d\d)+$/.test(label)) return null;
  return label.split(":").reduce((total, part) => total * 60 + Number(part), 0);
}
const pageTypes: Record<string, Collection["kind"]> = {
  MUSIC_PAGE_TYPE_ALBUM: "album", MUSIC_PAGE_TYPE_AUDIOBOOK: "album", MUSIC_PAGE_TYPE_PLAYLIST: "playlist", MUSIC_PAGE_TYPE_ARTIST: "artist", MUSIC_PAGE_TYPE_USER_CHANNEL: "artist",
};
function browseTarget(node: any): { id: string; kind: Collection["kind"] } | null {
  const endpoint = first(node, "browseEndpoint");
  const kind = pageTypes[endpoint?.browseEndpointContextSupportedConfigs?.browseEndpointContextMusicConfig?.pageType];
  return endpoint?.browseId && kind ? { id: endpoint.browseId, kind } : null;
}

/** A song row: search results, playlists, albums, artist top songs. */
function listItem(row: any, album?: Collection): Song | null {
  const columns = (row.flexColumns ?? []).map((column: any) => column.musicResponsiveListItemFlexColumnRenderer?.text);
  const id = row.playlistItemData?.videoId ?? first(columns[0], "watchEndpoint")?.videoId ?? first(row.overlay, "watchEndpoint")?.videoId;
  const title = plain(columns[0]);
  if (!id || !title) return null;
  const details: any[] = columns.slice(1).flatMap(runs);
  const artists = details.filter(run => ["artist"].includes(browseTarget(run)?.kind ?? "")).map(run => run.text);
  const albumRun = details.find(run => browseTarget(run)?.kind === "album");
  const fixed = plain(first(row.fixedColumns, "text"));
  const durationRun = details.map(run => String(run.text)).find(text => seconds(text) !== null);
  // Album tracks list plain text artists, or none at all (the album's artist then).
  const fallbackArtist = details.map(run => String(run.text)).filter(text => text !== " • " && seconds(text) === null && !/^(Song|Video|Episode)$/.test(text))[0] ?? "";
  return {
    kind: "song", id, title,
    artist: artists.join(", ") || fallbackArtist || album?.subtitle.split(" • ")[1] || "",
    album: albumRun?.text ?? album?.title ?? "",
    duration: seconds(fixed) ?? seconds(durationRun ?? ""),
    thumbnail: thumbnail(row.thumbnail) ?? album?.thumbnail ?? null,
  };
}

/** A card: home shelves, library grids. */
function twoRowItem(card: any): Item | null {
  const title = plain(card.title);
  const subtitle = plain(card.subtitle);
  const video = first(card.navigationEndpoint, "watchEndpoint")?.videoId;
  if (video) {
    const parts = subtitle.split(" • ").filter(part => !/^(Song|Video)$/.test(part));
    return { kind: "song", id: video, title, artist: parts[0] ?? "", album: "", duration: null, thumbnail: thumbnail(card.thumbnailRenderer) };
  }
  const target = browseTarget(card.navigationEndpoint);
  return target && title ? { kind: target.kind, id: target.id, title, subtitle, thumbnail: thumbnail(card.thumbnailRenderer) } : null;
}

function shelfItems(contents: any[]): Item[] {
  return (contents ?? []).map((entry: any) => entry.musicTwoRowItemRenderer ? twoRowItem(entry.musicTwoRowItemRenderer)
    : entry.musicResponsiveListItemRenderer ? listItem(entry.musicResponsiveListItemRenderer) : null)
    .filter((item: Item | null): item is Item => item !== null);
}

const continuationOf = (json: any): string | null =>
  first(json, "continuationCommand")?.token ?? first(json, "nextContinuationData")?.continuation ?? null;

// ---- api ------------------------------------------------------------------

export async function home(): Promise<Shelf[]> {
  const shelves: Shelf[] = [];
  let json = await call("browse", { browseId: "FEmusic_home" });
  // The first page holds a few shelves; the web app loads the rest as you scroll.
  for (let page = 0; page < 4; page++) {
    for (const shelf of findAll(json, "musicCarouselShelfRenderer")) {
      const items = shelfItems(shelf.contents);
      const title = plain(first(shelf.header, "title"));
      if (title && items.length) shelves.push({ title, items });
    }
    const token = continuationOf(json);
    if (!token) break;
    json = await call("browse", {}, `&ctoken=${token}&continuation=${token}&type=next`);
  }
  return shelves;
}

export async function search(query: string): Promise<Song[]> {
  // params selects the "Songs" filter.
  const json = await call("search", { query, params: "EgWKAQIIAWoKEAkQBRAKEAMQBA%3D%3D" });
  return findAll(json, "musicResponsiveListItemRenderer").map(row => listItem(row)).filter((song): song is Song => song !== null);
}

/** A playlist, album or artist page with its songs (long playlists up to ~1000). */
export async function collection(entry: Pick<Collection, "kind" | "id"> & Partial<Collection>): Promise<CollectionPage> {
  let json = await call("browse", { browseId: entry.id });
  const head = first(json, "musicResponsiveHeaderRenderer") ?? first(json, "musicImmersiveHeaderRenderer") ?? first(json, "musicVisualHeaderRenderer") ?? first(json, "musicDetailHeaderRenderer");
  const header: Collection = {
    kind: entry.kind, id: entry.id,
    title: plain(head?.title) || entry.title || "",
    subtitle: [plain(head?.straplineTextOne), plain(head?.subtitle)].filter(Boolean).join(" • ") || entry.subtitle || "",
    thumbnail: thumbnail(head?.thumbnail ?? head?.foregroundThumbnail) ?? entry.thumbnail ?? null,
  };
  const albumContext = entry.kind === "album" ? { ...header, subtitle: `Album • ${plain(head?.straplineTextOne)}` } : undefined;
  const songs: Song[] = [];
  const seen = new Set<string>();
  const take = (node: any) => {
    for (const row of findAll(node, "musicResponsiveListItemRenderer")) {
      const song = listItem(row, albumContext);
      if (song && !seen.has(song.id)) { seen.add(song.id); songs.push(song); }
    }
  };
  // Artist pages: only the songs shelf, not every carousel of albums/videos.
  take(entry.kind === "artist" ? findAll(json, "musicShelfRenderer").slice(0, 1) : first(json, "contents"));
  for (let page = 0; page < 10 && entry.kind === "playlist"; page++) {
    const token = continuationOf(first(json, "musicPlaylistShelfRenderer") ?? json.continuationContents ?? json.onResponseReceivedActions ?? null);
    if (!token) break;
    json = await call("browse", { continuation: token });
    take(json.onResponseReceivedActions ?? json.continuationContents);
  }
  return { header, songs };
}

/** The signed-in user's playlists, liked music first. */
export async function library(): Promise<Collection[]> {
  if (!signedIn()) return [];
  const json = await call("browse", { browseId: "FEmusic_liked_playlists" });
  const playlists = findAll(json, "musicTwoRowItemRenderer").map(twoRowItem)
    .filter((item): item is Collection => !!item && item.kind !== "song" && item.id !== "VLLM");
  const seen = new Set<string>();
  const unique = playlists.filter(item => !seen.has(item.id) && !!seen.add(item.id));
  return [{ kind: "playlist", id: "VLLM", title: "Liked music", subtitle: "Auto playlist", thumbnail: null }, ...unique];
}

// ---- audio ----------------------------------------------------------------

// YouTube's visionOS client gets plain audio URLs: no signature to decipher, no
// proof-of-origin token, so no JavaScript runtime or yt-dlp is needed.
const VISION_UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 15_7_3) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.0 Safari/605.1.15";
const VISION_CLIENT = {
  clientName: "VISIONOS", clientVersion: "1.02", userAgent: VISION_UA, hl: "en", gl: "US", utcOffsetMinutes: 0,
  deviceMake: "Apple", deviceModel: "RealityDevice17,1", osName: "visionOS", osVersion: "26.5.23O471",
};

/** A visitor id, as a browser keeps in a cookie: the player answers "are you a bot?" without one. */
let visitor: Promise<string> | null = null;
function visitorData(): Promise<string> {
  visitor ??= call("browse", { browseId: "FEmusic_home" }).then(json => String(json?.responseContext?.visitorData ?? ""), error => { visitor = null; throw error; });
  return visitor;
}

interface Resolved { url: string; expires: number }
const resolved = new Map<string, Promise<Resolved>>();

/** A direct, range-requestable AAC (M4A) URL for a song, cached until it expires. */
/** Starts the visitor-id request early, so the first play waits only for its own URL. */
export function warmUp(): void {
  void visitorData().catch(() => undefined);
}

export function streamUrl(id: string): Promise<string> {
  const cached = resolved.get(id);
  if (cached) {
    return cached.then(entry => entry.expires - Date.now() > 10 * 60_000 ? entry.url : (resolved.delete(id), streamUrl(id)));
  }
  const job = (async (): Promise<Resolved> => {
    const visitorId = await visitorData();
    const response = await fetch("https://www.youtube.com/youtubei/v1/player?prettyPrint=false", {
      method: "POST",
      headers: { "content-type": "application/json", "user-agent": VISION_UA, "x-youtube-client-name": "101", "x-youtube-client-version": VISION_CLIENT.clientVersion, "x-goog-visitor-id": visitorId },
      body: JSON.stringify({ context: { client: { ...VISION_CLIENT, visitorData: visitorId } }, videoId: id, contentCheckOk: true, racyCheckOk: true }),
    });
    if (!response.ok) throw new Error(`YouTube player answered HTTP ${response.status}`);
    const json: any = await response.json();
    const status = json?.playabilityStatus;
    if (status?.status !== "OK") throw new Error(status?.reason || `not playable (${status?.status ?? "no status"})`);
    const formats: any[] = (json?.streamingData?.adaptiveFormats ?? []).filter((format: any) => format.url && String(format.mimeType).startsWith("audio/mp4"));
    // AAC in MP4, the codec Tarve's <audio> decodes; 256 kbps (141) when offered.
    const format = formats.find(f => f.itag === 141) ?? formats.find(f => f.itag === 140) ?? formats.sort((a, b) => (b.bitrate ?? 0) - (a.bitrate ?? 0))[0];
    if (!format) throw new Error("no AAC audio for this song");
    const expire = Number(new URL(format.url).searchParams.get("expire"));
    return { url: format.url, expires: Number.isFinite(expire) && expire > 0 ? expire * 1000 : Date.now() + 3_600_000 };
  })();
  resolved.set(id, job);
  job.catch(() => resolved.delete(id));
  return job.then(entry => entry.url);
}
