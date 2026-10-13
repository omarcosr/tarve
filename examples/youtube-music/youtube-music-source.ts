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

async function call(endpoint: "browse" | "search" | "next", body: Record<string, unknown>, query = "", signal?: AbortSignal): Promise<any> {
  const headers: Record<string, string> = { "content-type": "application/json", origin: ORIGIN, "x-origin": ORIGIN, "user-agent": USER_AGENT };
  const auth = authorization();
  if (cookie && auth) Object.assign(headers, { cookie, authorization: auth, "x-goog-authuser": "0" });
  const context = { client: { clientName: "WEB_REMIX", clientVersion: "1.20250101.01.00", hl: "en", gl: "US" } };
  const response = await fetch(`${ORIGIN}/youtubei/v1/${endpoint}?prettyPrint=false${query}`, { method: "POST", headers, body: JSON.stringify({ context, ...body }), signal });
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

export async function home(onProgress?: (shelves: Shelf[]) => void, signal?: AbortSignal): Promise<Shelf[]> {
  const shelves: Shelf[] = [];
  let json = await call("browse", { browseId: "FEmusic_home" }, "", signal);
  for (let page = 0; page < 4; page++) {
    for (const shelf of findAll(json, "musicCarouselShelfRenderer")) {
      const items = shelfItems(shelf.contents);
      const title = plain(first(shelf.header, "title"));
      if (title && items.length) shelves.push({ title, items });
    }
    onProgress?.([...shelves]);
    const token = continuationOf(json);
    if (!token || page === 3) break;
    json = await call("browse", {}, `&ctoken=${token}&continuation=${token}&type=next`, signal);
  }
  return shelves;
}

export async function search(query: string): Promise<Song[]> {
  // params selects the "Songs" filter.
  const json = await call("search", { query, params: "EgWKAQIIAWoKEAkQBRAKEAMQBA%3D%3D" });
  return findAll(json, "musicResponsiveListItemRenderer").map(row => listItem(row)).filter((song): song is Song => song !== null);
}

export async function collection(entry: Pick<Collection, "kind" | "id"> & Partial<Collection>, onProgress?: (page: CollectionPage) => void, signal?: AbortSignal): Promise<CollectionPage> {
  let json = await call("browse", { browseId: entry.id }, "", signal);
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
  take(entry.kind === "artist" ? findAll(json, "musicShelfRenderer").slice(0, 1) : first(json, "contents"));
  onProgress?.({ header, songs: [...songs] });
  for (let page = 0; page < 10 && entry.kind === "playlist"; page++) {
    const token = continuationOf(first(json, "musicPlaylistShelfRenderer") ?? json.continuationContents ?? json.onResponseReceivedActions ?? null);
    if (!token) break;
    json = await call("browse", { continuation: token }, "", signal);
    take(json.onResponseReceivedActions ?? json.continuationContents);
    onProgress?.({ header, songs: [...songs] });
  }
  return { header, songs };
}

/** A queue row of the "next" endpoint (Up next, radio). */
function panelItem(row: any): Song | null {
  const id = row.videoId;
  const title = plain(row.title);
  if (!id || !title) return null;
  const byline: any[] = runs(row.longBylineText ?? row.shortBylineText);
  const artists = byline.filter(run => browseTarget(run)?.kind === "artist").map(run => run.text);
  const albumRun = byline.find(run => browseTarget(run)?.kind === "album");
  return {
    kind: "song", id, title,
    artist: artists.join(", ") || plain(row.shortBylineText),
    album: albumRun?.text ?? "",
    duration: seconds(plain(row.lengthText)),
    thumbnail: thumbnail(row.thumbnail),
  };
}

/**
 * The radio YouTube Music plays after a song (its "Up next"): songs like it,
 * the song itself first. Signed in, it follows the account's taste.
 */
export async function radio(id: string, signal?: AbortSignal): Promise<Song[]> {
  const json = await call("next", { videoId: id, playlistId: `RDAMVM${id}`, isAudioOnly: true, enablePersistentPlaylistPanel: true, tunerSettingValue: "AUTOMIX_SETTING_NORMAL" }, "", signal);
  const seen = new Set<string>();
  return findAll(json, "playlistPanelVideoRenderer").map(panelItem)
    .filter((song): song is Song => !!song && !seen.has(song.id) && !!seen.add(song.id));
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

// ---- lyrics ----

/** The plain-text lyrics YouTube Music shows for a song, or null when it has none. */
export async function songLyrics(id: string, signal?: AbortSignal): Promise<{ text: string; source: string } | null> {
  const next = await call("next", { videoId: id }, "", signal);
  const browseId = findAll(next, "browseId").find(value => String(value).startsWith("MPLY"));
  if (!browseId) return null;
  const shelf = first(await call("browse", { browseId }, "", signal), "musicDescriptionShelfRenderer");
  const text = plain(shelf?.description).trim();
  return text ? { text, source: plain(shelf?.footer).replace(/^Source:\s*/i, "") || "YouTube Music" } : null;
}

// ---- audio ----------------------------------------------------------------

// Two InnerTube player clients hand out plain audio URLs: no signature to
// decipher, no JavaScript runtime or yt-dlp. visionOS gives whole files; the
// Quest (Android VR) client is the fallback, and some of its URLs only serve a
// preview, which the tail check below catches.
interface PlayerClient { name: string; id: string; context: Record<string, unknown> }
const VISION_UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 15_7_3) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.0 Safari/605.1.15";
const VR_UA = "com.google.android.apps.youtube.vr.oculus/1.65.10 (Linux; U; Android 12L; eureka-user Build/SQ3A.220605.009.A1) gzip";
const CLIENTS: PlayerClient[] = [
  {
    name: "visionOS", id: "101",
    context: { clientName: "VISIONOS", clientVersion: "1.02", userAgent: VISION_UA, hl: "en", gl: "US", utcOffsetMinutes: 0, deviceMake: "Apple", deviceModel: "RealityDevice17,1", osName: "visionOS", osVersion: "26.5.23O471" },
  },
  {
    name: "Android VR", id: "28",
    context: { clientName: "ANDROID_VR", clientVersion: "1.65.10", userAgent: VR_UA, hl: "en", gl: "US", utcOffsetMinutes: 0, deviceMake: "Oculus", deviceModel: "Quest 3", androidSdkVersion: 32, osName: "Android", osVersion: "12L" },
  },
];

const VISITOR_TTL = 30 * 60_000;
let visitor: { id: Promise<string>; at: number } | null = null;
function visitorData(fresh = false): Promise<string> {
  if (fresh || !visitor || Date.now() - visitor.at > VISITOR_TTL) {
    const id = call("browse", { browseId: "FEmusic_home" }).then(json => String(json?.responseContext?.visitorData ?? ""));
    const entry = { id, at: Date.now() };
    visitor = entry;
    id.catch(() => { if (visitor === entry) visitor = null; });
  }
  return visitor!.id;
}

/** A resolved URL and how long it stays usable, on the monotonic clock (immune to wall-clock changes). */
interface Resolved { url: string; usableUntil: number }
/** Least recently used first; a long session plays hundreds of songs, their URLs die within hours. */
const resolved = new Map<string, Promise<Resolved>>();
const MAX_RESOLVED = 64;
/** A URL is re-opened at every seek and dropped connection: hand it out only while a song's length remains. */
const EXPIRY_MARGIN = 10 * 60_000;

/** Starts the visitor-id request early, so the first play waits only for its own URL. */
export function warmUp(): void {
  void visitorData().catch(() => undefined);
}

/** Drops a song's cached URL, e.g. after the CDN refused it, so the next streamUrl resolves a fresh one. */
export function forgetStreamUrl(id: string): void {
  resolved.delete(id);
}

/** A direct, range-requestable AAC (M4A) URL for a song, cached until shortly before it expires. */
export function streamUrl(id: string): Promise<string> {
  const cached = resolved.get(id);
  if (cached) {
    resolved.delete(id);
    resolved.set(id, cached);
    return cached.then(entry => performance.now() < entry.usableUntil ? entry.url : (forget(id, cached), streamUrl(id)));
  }
  const job = (async (): Promise<Resolved> => {
    const [main, fallback] = CLIENTS;
    try {
      return await resolve(id, main!, await visitorData());
    } catch (error) {
      // A stale visitor id is the usual reason a song that played an hour ago is refused now;
      // then the other client, which some songs only play on.
      const visitorId = await visitorData(true).catch(() => { throw error; });
      return resolve(id, main!, visitorId).catch(() => resolve(id, fallback!, visitorId)).catch(() => { throw error; });
    }
  })();
  resolved.set(id, job);
  while (resolved.size > MAX_RESOLVED) resolved.delete(resolved.keys().next().value!);
  job.catch(() => forget(id, job));
  return job.then(entry => entry.url);
}
function forget(id: string, job: Promise<Resolved>): void {
  if (resolved.get(id) === job) resolved.delete(id);
}

async function resolve(id: string, client: PlayerClient, visitorId: string): Promise<Resolved> {
  const userAgent = String(client.context.userAgent);
  const response = await fetch("https://www.youtube.com/youtubei/v1/player?prettyPrint=false", {
    method: "POST",
    headers: { "content-type": "application/json", "user-agent": userAgent, "x-youtube-client-name": client.id, "x-youtube-client-version": String(client.context.clientVersion), "x-goog-visitor-id": visitorId },
    body: JSON.stringify({ context: { client: { ...client.context, visitorData: visitorId } }, videoId: id, contentCheckOk: true, racyCheckOk: true }),
  });
  if (!response.ok) throw new Error(`YouTube player answered HTTP ${response.status}`);
  const json: any = await response.json();
  const status = json?.playabilityStatus;
  if (status?.status !== "OK") throw new Error(status?.reason || `not playable (${status?.status ?? "no status"})`);
  const formats: any[] = (json?.streamingData?.adaptiveFormats ?? []).filter((format: any) => format.url && String(format.mimeType).startsWith("audio/mp4"));
  // AAC in MP4, the codec Tarve's <audio> decodes; 256 kbps (141) when offered.
  const format = formats.find(f => f.itag === 141) ?? formats.find(f => f.itag === 140) ?? formats.sort((a, b) => (b.bitrate ?? 0) - (a.bitrate ?? 0))[0];
  if (!format) throw new Error("no AAC audio for this song");
  await servesWholeFile(format.url, Number(format.contentLength), client.name);
  const expire = Number(new URL(format.url).searchParams.get("expire"));
  const lifetime = Number.isFinite(expire) && expire > 0 ? expire * 1000 - Date.now() : 3_600_000;
  return { url: format.url, usableUntil: performance.now() + lifetime - Math.min(EXPIRY_MARGIN, lifetime / 10) };
}

/**
 * Asks for the file's last byte. A URL gated to a preview opens and plays, then
 * answers 403 once playback passes the first minute; this catches it before.
 */
export async function servesWholeFile(url: string, length: number, client = "player"): Promise<void> {
  if (!Number.isFinite(length) || length <= 0) return;
  const response = await fetch(url, { headers: { range: `bytes=${length - 1}-` }, signal: AbortSignal.timeout(8000) });
  await response.body?.cancel();
  if (response.status !== 206) throw new Error(`the ${client} stream serves only part of this song (HTTP ${response.status})`);
}
