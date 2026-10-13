import { afterEach, expect, test } from "bun:test";
import { lineAt, lyricsFor, parseLrc } from "./youtube-music-lyrics";
import { forgetStreamUrl, streamUrl } from "./youtube-music-source";

const realFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = realFetch; });
const song = { kind: "song" as const, id: "s1", title: "Yellow (2000 Remaster)", artist: "Coldplay, Someone", album: "", duration: 267, thumbnail: null };
const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status });

test("LRC lines keep their times, several stamps per line and the offset tag", () => {
  const lines = parseLrc("[offset:+500]\n[00:12.50]Look at the stars\n[00:05.00][01:00.00]Chorus\n[00:20.00]\nnot a lyric");
  expect(lines).toEqual([
    { time: 4.5, text: "Chorus" },
    { time: 12, text: "Look at the stars" },
    { time: 19.5, text: "" },
    { time: 59.5, text: "Chorus" },
  ]);
  expect(lineAt(lines, 0)).toBe(-1);
  expect(lineAt(lines, 4.5)).toBe(0);
  expect(lineAt(lines, 15)).toBe(1);
  expect(lineAt(lines, 600)).toBe(3);
});

test("synced lyrics come from LRCLIB, asked with the first artist and a clean title", async () => {
  const asked: string[] = [];
  globalThis.fetch = (async (url: string) => {
    asked.push(String(url));
    return json({ trackName: "Yellow", artistName: "Coldplay", duration: 267, instrumental: false, plainLyrics: "x", syncedLyrics: "[00:01.00]Look at the stars" });
  }) as unknown as typeof fetch;
  const lyrics = await lyricsFor(song);
  expect(lyrics).toEqual({ lines: [{ time: 1, text: "Look at the stars" }], plain: null, source: "LRCLIB" });
  const query = new URL(asked[0]!).searchParams;
  expect([query.get("artist_name"), query.get("track_name"), query.get("duration")]).toEqual(["Coldplay", "Yellow", "267"]);
});

test("without synced lyrics, YouTube Music's text; a definitive miss is null", async () => {
  let youtube: unknown = { contents: { browseId: "MPLYt_x" } };
  globalThis.fetch = (async (url: string, options?: RequestInit) => {
    if (String(url).includes("lrclib")) return String(url).includes("/get") ? json({ code: 404 }, 404) : json([{ duration: 300, syncedLyrics: "[00:01.00]wrong song" }]);
    const body = JSON.parse(String(options?.body));
    if (body.videoId) return json(youtube);
    return json({ musicDescriptionShelfRenderer: { description: { runs: [{ text: "Look at the stars" }] }, footer: { runs: [{ text: "Source: Musixmatch" }] } } });
  }) as unknown as typeof fetch;
  expect(await lyricsFor(song)).toEqual({ lines: null, plain: "Look at the stars", source: "Musixmatch" });
  youtube = { contents: {} };
  expect(await lyricsFor(song)).toBeNull();
});

test("a lookup that could not ask throws instead of reporting no lyrics", async () => {
  globalThis.fetch = (async (url: string) => {
    if (String(url).includes("lrclib")) return json({}, 503);
    return json({ contents: {} });
  }) as unknown as typeof fetch;
  await expect(lyricsFor(song)).rejects.toThrow("LRCLIB answered HTTP 503");
});

test("a stream that serves only a preview falls back to the other player client", async () => {
  const clients: string[] = [];
  const probed: string[] = [];
  globalThis.fetch = (async (url: string, options?: RequestInit) => {
    if (String(url).includes("/browse")) return json({ responseContext: { visitorData: "v" } });
    if (String(url).startsWith("https://cdn.test/")) {
      probed.push(`${url} ${new Headers(options?.headers).get("range")}`);
      return new Response("x", { status: String(url).includes("vision") ? 403 : 206 });
    }
    const client = JSON.parse(String(options?.body)).context.client.clientName;
    clients.push(client);
    const name = client === "VISIONOS" ? "vision" : "vr";
    return json({ playabilityStatus: { status: "OK" }, streamingData: { adaptiveFormats: [{ itag: 140, mimeType: "audio/mp4", contentLength: "1000", url: `https://cdn.test/${name}?expire=9999999999` }] } });
  }) as unknown as typeof fetch;
  forgetStreamUrl("preview");
  expect(await streamUrl("preview")).toBe("https://cdn.test/vr?expire=9999999999");
  expect(clients).toEqual(["VISIONOS", "VISIONOS", "ANDROID_VR"]);
  expect(probed.at(-1)).toBe("https://cdn.test/vr?expire=9999999999 bytes=999-");
});
