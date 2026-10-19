import { afterEach, expect, test } from "bun:test";

const originalCookie = process.env.YTM_COOKIE;
process.env.YTM_COOKIE = "x";
const { home } = await import("./youtube-music-source");
if (originalCookie === undefined) delete process.env.YTM_COOKIE;
else process.env.YTM_COOKIE = originalCookie;
const originalFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = originalFetch; });

function page(title: string, continuation?: string) {
  return {
    contents: { musicCarouselShelfRenderer: {
      header: { title: { runs: [{ text: title }] } },
      contents: [{ musicTwoRowItemRenderer: {
        title: { runs: [{ text: `${title} song` }] },
        subtitle: { runs: [{ text: "Artist" }] },
        navigationEndpoint: { watchEndpoint: { videoId: title } },
      } }],
    } },
    ...(continuation ? { continuationCommand: { token: continuation } } : {}),
  };
}

test("home publishes the first shelf before the continuation finishes", async () => {
  let release!: () => void;
  const pending = new Promise<void>(resolve => { release = resolve; });
  let requests = 0;
  globalThis.fetch = (async () => {
    requests++;
    if (requests === 2) await pending;
    return new Response(JSON.stringify(requests === 1 ? page("First", "next") : page("Second")), { status: 200 });
  }) as unknown as typeof fetch;
  const snapshots: string[][] = [];
  const loading = home(shelves => { snapshots.push(shelves.map(shelf => shelf.title)); });
  try {
    for (let i = 0; i < 20 && requests < 2; i++) await Bun.sleep(1);
    expect(requests).toBe(2);
    expect(snapshots).toEqual([["First"]]);
  } finally {
    release();
  }
  expect((await loading).map(shelf => shelf.title)).toEqual(["First", "Second"]);
  expect(snapshots).toEqual([["First"], ["First", "Second"]]);
});

test("a continuation failure preserves the first shelf", async () => {
  let requests = 0;
  globalThis.fetch = (async () => {
    requests++;
    return requests === 1
      ? new Response(JSON.stringify(page("First", "next")))
      : new Response("unavailable", { status: 503 });
  }) as unknown as typeof fetch;
  const snapshots: string[][] = [];
  await expect(home(shelves => snapshots.push(shelves.map(shelf => shelf.title)))).rejects.toThrow("503");
  expect(snapshots).toEqual([["First"]]);
});

test("a playlist shows its first song while later pages are pending", async () => {
  const { collection } = await import("./youtube-music-source");
  const row = (id: string) => ({ musicResponsiveListItemRenderer: {
    playlistItemData: { videoId: id },
    flexColumns: [{ musicResponsiveListItemFlexColumnRenderer: { text: { runs: [{ text: id }] } } }],
  } });
  let release!: () => void;
  const pending = new Promise<void>(resolve => { release = resolve; });
  let requests = 0;
  globalThis.fetch = (async () => {
    requests++;
    if (requests === 2) await pending;
    return new Response(JSON.stringify(requests === 1
      ? { contents: { musicPlaylistShelfRenderer: { contents: [row("first")], nextContinuationData: { continuation: "next" } } } }
      : { onResponseReceivedActions: [{ appendContinuationItemsAction: { continuationItems: [row("second"), row("first")] } }] }));
  }) as unknown as typeof fetch;
  const snapshots: string[][] = [];
  const loading = collection({ kind: "playlist", id: "VL123", title: "Playlist" }, value => snapshots.push(value.songs.map(song => song.id)));
  try {
    for (let i = 0; i < 20 && requests < 2; i++) await Bun.sleep(1);
    expect(snapshots).toEqual([["first"]]);
  } finally { release(); }
  expect((await loading).songs.map(song => song.id)).toEqual(["first", "second"]);
  expect(snapshots).toEqual([["first"], ["first", "second"]]);
});

test("an aborted feed keeps its published shelf and stops the continuation", async () => {
  let requests = 0;
  globalThis.fetch = (async (_url: string, options?: RequestInit) => {
    requests++;
    if (requests === 1) return new Response(JSON.stringify(page("First", "next")));
    await new Promise<void>((_resolve, reject) => {
      options?.signal?.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")), { once: true });
    });
    throw new Error("unexpected response");
  }) as unknown as typeof fetch;
  const abort = new AbortController();
  const snapshots: string[][] = [];
  const loading = home(shelves => { snapshots.push(shelves.map(shelf => shelf.title)); }, abort.signal);
  for (let i = 0; i < 20 && requests < 2; i++) await Bun.sleep(1);
  expect(snapshots).toEqual([["First"]]);
  abort.abort();
  await expect(loading).rejects.toHaveProperty("name", "AbortError");
  expect(snapshots).toEqual([["First"]]);
});

test("the music window intercepts the titlebar close and hides instead of quitting", async () => {
  // Public API only (this folder is a standalone consumer project): a Window with
  // onCloseRequest intercepts its title bar's close button.
  const { YouTubeMusicView, state } = await import("./youtube-music-view");
  const window = YouTubeMusicView() as unknown as { props: { onCloseRequest?: (event: { defaultPrevented: boolean; preventDefault(): void }) => void } };
  expect(typeof window.props.onCloseRequest).toBe("function");
  let hidden = false;
  state.hide = () => { hidden = true; };
  let prevented = false;
  window.props.onCloseRequest?.({
    defaultPrevented: false,
    preventDefault() { prevented = true; },
  });
  expect(hidden).toBe(true);
  expect(prevented).toBe(true);
});

/** A fake YouTube backend: the radio of any song is its id with -1 … -3 after it; player answers for every id except "bad" and "bot". */
function backend() {
  const calls: string[] = [];
  globalThis.fetch = (async (url: string, options?: RequestInit) => {
    const body = JSON.parse(String(options?.body ?? "{}"));
    const endpoint = /youtubei\/v1\/(\w+)/.exec(String(url))?.[1] ?? "";
    calls.push(endpoint === "next" ? `next:${body.videoId}` : endpoint === "player" ? `player:${body.videoId}` : endpoint);
    if (endpoint === "next") {
      const ids = [body.videoId, `${body.videoId}-1`, `${body.videoId}-2`, `${body.videoId}-3`];
      return new Response(JSON.stringify({ contents: ids.map(id => ({ playlistPanelVideoRenderer: { videoId: id, title: { runs: [{ text: id }] }, lengthText: { runs: [{ text: "3:00" }] } } })) }));
    }
    if (endpoint === "player") {
      if (body.videoId === "bad") return new Response(JSON.stringify({ playabilityStatus: { status: "ERROR", reason: "unavailable" } }));
      if (body.videoId === "bot") return new Response(JSON.stringify({ playabilityStatus: { status: "LOGIN_REQUIRED", reason: "Sign in to confirm you're not a bot" } }));
      return new Response(JSON.stringify({ playabilityStatus: { status: "OK" }, streamingData: { adaptiveFormats: [{ itag: 140, mimeType: "audio/mp4", url: `https://cdn.test/${body.videoId}?expire=${Math.floor(Date.now() / 1000) + 3600}` }] } }));
    }
    return new Response(JSON.stringify({ responseContext: { visitorData: "v" } }));
  }) as unknown as typeof fetch;
  return calls;
}

async function connected() {
  const { connect } = await import("./youtube-music-actions");
  const { state } = await import("./youtube-music-view");
  let close!: () => void;
  const app = {
    closed: new Promise<void>(resolve => { close = resolve; }),
    update() {}, hide() {}, show() {}, systemMedia() {}, registerHotkey() { return () => {}; },
    media: () => ({ play() {}, pause() {}, seek() {} }),
  };
  connect(app as never);
  return { state, close };
}

const song = (id: string) => ({ kind: "song" as const, id, title: id, artist: "", album: "", duration: 180, thumbnail: null });
const until = async (predicate: () => boolean) => { for (let i = 0; i < 300 && !predicate(); i++) await Bun.sleep(10); };

test("autoplay adds the radio of the last song when the queue runs low", async () => {
  backend();
  const { state, close } = await connected();
  try {
    state.repeat = "off";
    state.play([song("a")], 0, "Search");
    await until(() => state.queue.length > 1);
    expect(state.queue.map(item => item.id)).toEqual(["a", "a-1", "a-2", "a-3"]);
    expect(state.source).toBe("Search · radio");
    state.next();
    expect(state.queue[state.index]?.id).toBe("a-1");
  } finally { close(); }
});

test("next at the very end waits for the radio instead of stopping", async () => {
  backend();
  const { state, close } = await connected();
  try {
    state.repeat = "all";
    state.play([song("b")], 0);
    state.repeat = "off";
    await until(() => state.path !== undefined);
    expect(state.queue.length).toBe(1);
    state.next();
    await until(() => state.index === 1);
    expect(state.queue[state.index]?.id).toBe("b-1");
  } finally { close(); }
});

test("an unplayable song is skipped", async () => {
  backend();
  const { state, close } = await connected();
  try {
    state.repeat = "off";
    state.play([song("bad"), song("good")], 0);
    await until(() => state.playError !== null);
    expect(state.playError).toContain("unavailable");
    await until(() => state.index === 1);
    expect(state.queue[state.index]?.id).toBe("good");
  } finally { close(); }
});

test("a bot check stays on the song instead of skipping through the queue", async () => {
  const calls = backend();
  const { state, close } = await connected();
  try {
    state.repeat = "off";
    state.play([song("bot"), song("good")], 0);
    await until(() => state.playError !== null);
    expect(state.playError).toContain("bot");
    await new Promise(resolve => setTimeout(resolve, 1800));
    expect(state.index).toBe(0);
    expect(calls).not.toContain("player:good");
  } finally { close(); }
});

test("a song the player refuses is retried once with a fresh visitor id", async () => {
  const { streamUrl, forgetStreamUrl } = await import("./youtube-music-source");
  let visitors = 0;
  const seen: string[] = [];
  globalThis.fetch = (async (url: string, options?: RequestInit) => {
    const body = JSON.parse(String(options?.body ?? "{}"));
    if (String(url).includes("/browse")) return new Response(JSON.stringify({ responseContext: { visitorData: `v${++visitors}` } }));
    const visitor = body.context.client.visitorData;
    seen.push(visitor);
    // The first id the player sees has gone stale; only a newer one is accepted.
    if (seen.length === 1 || visitor !== `v${visitors}`) return new Response(JSON.stringify({ playabilityStatus: { status: "LOGIN_REQUIRED", reason: "Sign in to confirm you're not a bot" } }));
    return new Response(JSON.stringify({ playabilityStatus: { status: "OK" }, streamingData: { adaptiveFormats: [{ itag: 140, mimeType: "audio/mp4", url: "https://cdn.test/x?expire=9999999999" }] } }));
  }) as unknown as typeof fetch;
  forgetStreamUrl("stale");
  expect(await streamUrl("stale")).toBe("https://cdn.test/x?expire=9999999999");
  expect(seen.at(-1)).toBe(`v${visitors}`);
  expect(seen.length).toBe(2);
});
