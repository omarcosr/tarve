// Connects the YouTube Music view to the data source, the sign-in window and the app.
import type { createApp } from "@tarve/core";
import { signInWithBrowser } from "./youtube-music-login";
import { lineAt, lyricsFor, type Lyrics } from "./youtube-music-lyrics";
import * as source from "./youtube-music-source";
import { AUDIO_ID, LYRICS_LIST, lyricsShown, state, type Page } from "./youtube-music-view";

export function connect(app: ReturnType<typeof createApp>): void {
  // One system-media sync per burst of state changes; app.update() batches the render itself.
  let queued = false;
  let mediaKey = "";
  const syncSystemMedia = () => {
    const song = state.queue[state.index];
    const duration = state.duration || song?.duration || 0;
    const key = song ? [song.id, state.playing, duration, Math.floor(state.time), state.index > 0].join("|") : "";
    if (key === mediaKey) return;
    mediaKey = key;
    app.systemMedia(song ? {
      title: song.title,
      artist: song.artist,
      album: song.album,
      artwork: song.thumbnail?.replace(/=w\d+-h\d+/, "=w544-h544").replace(/=s\d+/, "=s544"),
      playing: state.playing,
      duration: duration || undefined,
      position: state.time,
      canSeek: !!state.path && duration > 0,
      // Autoplay adds the radio at the end of the queue, so there is always a next song.
      canNext: state.queue.length > 0,
      canPrevious: state.index >= 0,
      onAction: (action, time) => {
        if (action === "play") state.media()?.play();
        else if (action === "pause") state.media()?.pause();
        else if (action === "next") state.next();
        else if (action === "previous") state.previous();
        else if (time !== undefined) { state.media()?.seek(time); state.time = time; }
        refresh();
      },
    } : null);
  };
  const refresh = () => {
    if (queued) return;
    queued = true;
    queueMicrotask(() => { queued = false; syncSystemMedia(); app.update(); });
  };
  const message = (error: unknown) => (error instanceof Error ? error.message : String(error));
  state.refresh = refresh;
  state.hide = () => app.hide();
  state.media = () => app.media(AUDIO_ID);

  // The likeliest next click (Play, or the top result) resolves its stream URL ahead.
  const prefetch = (song: { id: string } | undefined) => { if (song) void source.streamUrl(song.id).catch(() => undefined); };
  source.warmUp();

  // The synced lyrics follow the song, unless the user scrolled them in the last few seconds.
  let followed = -2;
  let userScrolledAt = -Infinity;
  state.lyricsScrolled = (offset, info) => {
    state.lyricsOffset = offset;
    if (info.source === "user") userScrolledAt = performance.now();
  };
  state.followLyrics = () => {
    const song = state.queue[state.index];
    const lines = state.lyrics?.id === song?.id ? state.lyrics?.data?.lines : null;
    // Hidden (another page, a narrow window): the first update once shown jumps to the line.
    if (!lines || !lyricsShown()) { followed = -2; return; }
    const line = lineAt(lines, state.time);
    if (line === followed || performance.now() - userScrolledAt < 4000) return;
    // A jump (first show, a seek) lands at once; the next line eases in.
    const smooth = followed >= 0 && line === followed + 1;
    followed = line;
    app.scrollToItem(LYRICS_LIST, Math.max(0, line), -Math.round((state.stage?.height ?? 600) * 0.3), { smooth });
  };

  // Lyrics load for the song playing while the now-playing page is open. A song
  // without lyrics is remembered; one whose lookup failed is tried again later.
  const lyricsCache = new Map<string, Lyrics | null>();
  const LYRICS_CACHED = 100;
  let lyricsAbort: AbortController | null = null;
  function loadLyrics(): void {
    const song = state.queue[state.index];
    if (!song || state.page.kind !== "playing") return;
    if (state.lyrics?.id === song.id && state.lyrics.status !== "error") return;
    state.lyricsOffset = 0;
    followed = -2;
    lyricsAbort?.abort();
    if (lyricsCache.has(song.id)) {
      const data = lyricsCache.get(song.id);
      state.lyrics = data ? { id: song.id, status: "ready", data } : { id: song.id, status: "none" };
      return;
    }
    const abort = lyricsAbort = new AbortController();
    state.lyrics = { id: song.id, status: "loading" };
    lyricsFor(song, abort.signal).then(data => {
      lyricsCache.set(song.id, data);
      while (lyricsCache.size > LYRICS_CACHED) lyricsCache.delete(lyricsCache.keys().next().value!);
      if (abort.signal.aborted) return;
      state.lyrics = data ? { id: song.id, status: "ready", data } : { id: song.id, status: "none" };
      refresh();
    }, error => {
      if (abort.signal.aborted) return;
      state.lyrics = { id: song.id, status: "error", error: message(error) };
      refresh();
    });
  }

  let pageToken = 0;
  let pageAbort: AbortController | null = null;
  async function load<T>(token: number, task: Promise<T>, apply: (value: T) => void): Promise<void> {
    try {
      const value = await task;
      if (token === pageToken) apply(value);
    } catch (error) {
      if (token === pageToken && !(state.page.kind === "home" && state.shelves) && !(state.page.kind === "collection" && state.opened)) state.pageError = message(error);
    }
    refresh();
  }
  function show(page: Page): void {
    pageAbort?.abort();
    const abort = pageAbort = new AbortController();
    const token = ++pageToken;
    state.page = page;
    state.pageError = null;
    state.listOffset = 0;
    if (page.kind === "home") {
      if (!state.shelves) void load(token, source.home(shelves => {
        if (token !== pageToken) return;
        state.shelves = shelves;
        refresh();
      }, abort.signal), shelves => { state.shelves = shelves; });
    } else if (page.kind === "search") {
      state.results = null;
      if (page.query) void load(token, source.search(page.query), songs => { state.results = songs; prefetch(songs[0]); });
    } else if (page.kind === "library") {
      if (state.signedIn) void load(token, source.library(), list => { state.library = list; });
    } else if (page.kind === "collection" && state.opened?.header.id !== page.entry.id) {
      state.opened = null;
      void load(token, source.collection(page.entry, opened => {
        if (token !== pageToken) return;
        state.opened = opened;
        refresh();
      }, abort.signal), opened => { state.opened = opened; prefetch(opened.songs[0]); });
    } else if (page.kind === "playing") loadLyrics();
    refresh();
  }
  state.open = page => {
    if (JSON.stringify(page) !== JSON.stringify(state.page)) state.back.push(state.page);
    show(page);
  };
  state.goBack = () => { const page = state.back.pop(); if (page) show(page); };

  let playToken = 0;
  /** The play whose stream was already re-resolved once after an error. */
  let retriedToken = -1;
  /** Songs skipped in a row because they would not play; stops a run of failures from looping. */
  let skipped = 0;

  // Autoplay, as YouTube Music does: when the queue runs low, the radio of its
  // last song is added after it, so playback never just stops.
  let radioFor: string | null = null;
  let radioLoad: Promise<void> | null = null;
  function extendQueue(): Promise<void> {
    const seed = state.queue.at(-1);
    if (!seed || state.repeat !== "off") return Promise.resolve();
    if (seed.id === radioFor && radioLoad) return radioLoad;
    radioFor = seed.id;
    const queueAtStart = state.queue;
    radioLoad = source.radio(seed.id).then(songs => {
      // A new queue (another song played) replaces this one; its own radio comes later.
      if (state.queue !== queueAtStart) return;
      const have = new Set(state.queue.map(song => song.id));
      const more = songs.filter(song => !have.has(song.id));
      if (!more.length) return;
      state.queue = [...state.queue, ...more];
      if (!state.source.endsWith("radio")) state.source = state.source ? `${state.source} · radio` : `${seed.title} radio`;
      refresh();
    }, () => { radioFor = null; }).finally(() => { radioLoad = null; });
    return radioLoad;
  }
  /** After a song that cannot play: on to the next one, unless several failed in a row. */
  function skipUnplayable(failure: string): void {
    state.playError = failure;
    state.playing = false;
    if (++skipped > 3) { refresh(); return; }
    const token = playToken;
    setTimeout(() => { if (token === playToken) state.next(); }, 1500);
    refresh();
  }
  // Stream URLs expire and the CDN sometimes refuses one mid-song (403, dropped
  // connections): resolve a fresh URL once and continue where it stopped.
  state.mediaFailed = failure => {
    const song = state.queue[state.index];
    const token = playToken;
    if (!song || retriedToken === token) {
      skipUnplayable(failure);
      return;
    }
    retriedToken = token;
    const resumeAt = state.time;
    source.forgetStreamUrl(song.id);
    state.path = undefined;
    state.loading = 0;
    refresh();
    source.streamUrl(song.id).then(url => {
      if (token !== playToken) return;
      state.loading = null;
      state.resumeAt = resumeAt;
      state.path = url;
      refresh();
    }, error => {
      if (token !== playToken) return;
      state.loading = null;
      skipUnplayable(message(error));
    });
  };
  /** The song whose stream is loaded in <audio>. */
  let loadedId: string | null = null;
  function start(): void {
    const song = state.queue[state.index];
    if (!song) return;
    // The same song again (clicked twice, or picked by autoplay and by a click):
    // its stream is loaded, so it restarts in place. Reloading the same URL
    // would not reach <audio> at all and leave the player showing paused.
    if (song.id === loadedId && state.path && !state.playError) {
      ++playToken;
      // Play first: an ended track reopens from the start; a playing one then seeks back.
      state.media()?.play();
      state.media()?.seek(0);
      state.time = 0;
      refresh();
      return;
    }
    loadedId = null;
    loadLyrics();
    const token = ++playToken;
    state.path = undefined;
    state.playing = false;
    state.time = 0;
    state.duration = song.duration ?? 0;
    state.playError = null;
    state.resumeAt = 0;
    state.loading = 0;
    source.streamUrl(song.id).then(url => {
      if (token !== playToken) return;
      // <audio> streams it: playback starts with the first chunk.
      state.loading = null;
      state.path = url;
      loadedId = song.id;
      refresh();
      // Resolve the next song meanwhile so it starts at once.
      const upcoming = state.queue[state.index + 1];
      if (upcoming) void source.streamUrl(upcoming.id).catch(() => undefined);
    }, error => {
      if (token !== playToken) return;
      state.loading = null;
      skipUnplayable(message(error));
    });
    if (state.index + 3 >= state.queue.length) void extendQueue();
    refresh();
  }
  state.played = () => { skipped = 0; };
  state.play = (queue, index, from = "") => {
    state.queue = [...queue];
    state.index = index;
    state.source = from;
    if (state.shuffle) { state.shuffle = false; state.toggleShuffle(); }
    start();
  };
  state.jump = index => { if (index !== state.index && state.queue[index]) { state.index = index; start(); } };
  state.next = () => {
    if (state.index + 1 < state.queue.length) { state.index++; start(); }
    else if (state.repeat === "all" && state.queue.length) { state.index = 0; start(); }
    else if (state.queue.length) {
      // The end of the queue: wait for its radio, then go on.
      const token = playToken;
      state.loading = 0;
      refresh();
      void extendQueue().then(() => {
        if (token !== playToken) return;
        state.loading = null;
        if (state.index + 1 < state.queue.length) { state.index++; start(); } else refresh();
      });
    }
  };
  state.previous = () => {
    if (state.time > 3 || state.index === 0) { state.media()?.seek(0); state.time = 0; return; }
    state.index--;
    start();
  };
  state.toggleShuffle = () => {
    state.shuffle = !state.shuffle;
    if (!state.shuffle || state.index < 0) return;
    // Shuffle what is still to come; history and the current song stay put.
    const rest = state.queue.slice(state.index + 1);
    for (let i = rest.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1));[rest[i], rest[j]] = [rest[j]!, rest[i]!]; }
    state.queue = [...state.queue.slice(0, state.index + 1), ...rest];
  };

  function signedIn(): void {
    state.signedIn = source.signedIn();
    state.signIn = "closed";
    state.signInError = null;
    state.pastedCookies = "";
    state.library = null;
    state.shelves = null;
    state.opened = null;
    show(state.page.kind === "library" ? state.page : { kind: "home" });
    if (state.signedIn) void source.library().then(list => { state.library = list; refresh(); }, () => undefined);
  }
  let signInAbort: AbortController | null = null;
  state.signInWithBrowser = () => {
    signInAbort?.abort();
    const abort = signInAbort = new AbortController();
    state.signIn = "browser";
    state.signInError = null;
    signInWithBrowser(abort.signal).then(cookies => { source.useCookies(cookies); signedIn(); }, error => {
      if (abort.signal.aborted && state.signIn === "closed") return;
      state.signIn = "choose";
      state.signInError = message(error);
      refresh();
    });
    refresh();
  };
  state.savePastedCookies = () => {
    try { source.useCookies(state.pastedCookies); signedIn(); } catch (error) { state.signInError = message(error); }
  };
  state.signOut = () => { source.signOut(); signedIn(); };

  // Closing the dialog while the browser window is open cancels that sign-in.
  const closeWatch = setInterval(() => { if (state.signIn !== "browser" && signInAbort && !signInAbort.signal.aborted) signInAbort.abort(); }, 500);
  const mediaWatch = setInterval(syncSystemMedia, 1000);
  void app.closed.then(() => { clearInterval(closeWatch); clearInterval(mediaWatch); signInAbort?.abort(); });

  app.registerHotkey("Space", () => { if (!state.path) return; if (state.playing) state.media()?.pause(); else state.media()?.play(); });
  state.signedIn = source.signedIn();
  show({ kind: "home" });
  if (state.signedIn) void source.library().then(list => { state.library = list; refresh(); }, () => undefined);
}
