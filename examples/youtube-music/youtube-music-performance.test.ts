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






