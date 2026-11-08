// Connects the YouTube Music view to the data source, the sign-in window and the app.
import type { createApp } from "@tarve/core";
import { signInWithBrowser } from "./youtube-music-login";
import { phone } from "./youtube-music-mobile";
import { lineAt, lyricsFor, type Lyrics } from "./youtube-music-lyrics";
import { distinct, sameSong, shuffled, songKey, spread } from "./youtube-music-queue";
import * as source from "./youtube-music-source";
import type { Song } from "./youtube-music-source";
import { AUDIO_ID, clock, clockText, LYRICS_LIST, lyricsShown, playTime, state, type Page } from "./youtube-music-view";

/** Waits before retrying a song the bot check refused (VPN exits change; the block often lifts). */
const BLOCKED_RETRIES = [20_000, 60_000, 180_000];
/** Fresh stream URLs tried for one song when playback stops without advancing in between. */
const RESUME_RETRIES = 2;

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
        if (action === "play") { if (state.path) state.media()?.play(); else state.togglePlay(); }
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

  // The clock and the seek bar follow `playTime` on their own; the view renders again only
  // when the lyric line being sung changes (the line it highlights).
  let shownLine = -1;
  playTime.subscribe(() => {
    clockText.value = clock(playTime.value);
    state.followLyrics();
    const song = state.queue[state.index];
    const lines = state.page.kind === "playing" && state.lyrics?.id === song?.id ? state.lyrics?.data?.lines : null;
    const line = lines ? lineAt(lines, playTime.value) : -1;
    if (line !== shownLine) { shownLine = line; refresh(); }
  });

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
  /** The play whose stream was re-resolved after an error, how often without progress, and where. */
  let retriedToken = -1;
  let retries = 0;
  let retriedAt = 0;
  /** Songs skipped in a row because they would not play; stops a run of failures from looping. */
  let skipped = 0;
  /** Retries of the current song after YouTube's bot check refused the network. */
  let blocked = 0;

  // Autoplay, as YouTube Music does: when the queue runs low, the radio of its
  // last song is added after it, so playback never just stops.
  /** Songs heard lately (by songKey), so autoplay does not bring back what just played. */
  const recent: string[] = [];
  const RECENT = 60;
  let radioFor: string | null = null;
  let radioLoad: Promise<void> | null = null;
  function extendQueue(): Promise<void> {
    const seed = state.queue.at(-1);
    if (!seed || state.repeat !== "off" || !state.autoplay) return Promise.resolve();
    if (seed.id === radioFor && radioLoad) return radioLoad;
    radioFor = seed.id;
    const queueAtStart = state.queue;
    radioLoad = source.radio(seed.id).then(songs => {
      // A new queue (another song played) replaces this one; its own radio comes later.
      if (state.queue !== queueAtStart) return;
      // Every video of a song already queued counts as that song, and so does one heard lately
      // (unless the radio has nothing else); what is left is spread so neighbours differ.
      const have = new Set(state.queue.flatMap(song => [song.id, songKey(song)]));
      const fresh = songs.filter(song => {
        const key = songKey(song);
        if (have.has(song.id) || have.has(key)) return false;
        have.add(key);
        return true;
      });
      // A radio of only songs heard lately still keeps playing, with the latest ones left out.
      const heardIn = (last: number) => fresh.filter(song => !recent.slice(-last).includes(songKey(song)));
      const unheard = heardIn(RECENT);
      const more = spread(unheard.length ? unheard : heardIn(10), seed);
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
    const token = playToken;
    // The bot check refuses the network, not the song: every next song would fail the same
    // way, so skipping would only spam YouTube. Retry this one a few times, slower each time.
    if (failure === source.BOT_CHECK) {
      if (blocked < BLOCKED_RETRIES.length) {
        const index = state.index;
        setTimeout(() => { if (token === playToken && state.index === index) { blocked++; start(); } }, BLOCKED_RETRIES[blocked]);
      }
      refresh();
      return;
    }
    if (++skipped > 3) { refresh(); return; }
    setTimeout(() => { if (token === playToken) state.next(); }, 1500);
    refresh();
  }
  // Stream URLs expire and the CDN sometimes refuses one mid-song (403, dropped
  // connections): resolve a fresh URL once and continue where it stopped.
  state.mediaFailed = failure => {
    const song = state.queue[state.index];
    const token = playToken;
    if (retriedToken !== token) { retriedToken = token; retries = 0; retriedAt = -Infinity; }
    // A long song can lose its stream more than once; it gives up only when retries make no progress.
    if (state.time > retriedAt + 5) retries = 0;
    if (!song || retries >= RESUME_RETRIES) {
      skipUnplayable(failure);
      return;
    }
    retries++;
    retriedAt = state.time;
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
  // A stream cut short (a CDN closing the connection, a decode error) ends without an
  // error event: far from its duration it resumes instead of skipping the rest of the song.
  state.mediaEnded = () => {
    const duration = state.duration || state.queue[state.index]?.duration || 0;
    if (duration > 0 && state.time < duration - 5) { state.mediaFailed("the stream ended early"); return; }
    state.playing = false;
    state.next();
  };
  /** The song whose stream is loaded in <audio>. */
  let loadedId: string | null = null;
  function start(at = 0): void {
    const song = state.queue[state.index];
    if (!song) return;
    const key = songKey(song);
    const heard = recent.indexOf(key);
    if (heard >= 0) recent.splice(heard, 1);
    recent.push(key);
    if (recent.length > RECENT) recent.shift();
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
    state.time = at;
    state.duration = song.duration ?? 0;
    state.playError = null;
    state.resumeAt = at;
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
      if (upcoming && !blocked) void source.streamUrl(upcoming.id).catch(() => undefined);
    }, error => {
      if (token !== playToken) return;
      state.loading = null;
      skipUnplayable(message(error));
    });
    if (state.index + 3 >= state.queue.length) void extendQueue();
    refresh();
  }
  state.played = () => { skipped = 0; blocked = 0; };
  state.play = (queue, index, from = "") => {
    // A list with a song more than once (two videos of it, a duplicated playlist entry) plays it once.
    const clean = distinct(queue, index);
    state.queue = clean.songs;
    state.index = clean.index;
    state.source = from;
    if (state.shuffle) { state.shuffle = false; state.toggleShuffle(); }
    start();
  };
  state.jump = index => { if (index !== state.index && state.queue[index]) { state.index = index; start(); } };
  /** The next queue entry that is not the song playing again. */
  const following = () => {
    const current = state.queue[state.index];
    let i = state.index + 1;
    while (i < state.queue.length && sameSong(state.queue[i], current)) i++;
    return i;
  };
  state.next = () => {
    const ahead = following();
    if (ahead < state.queue.length) { state.index = ahead; start(); }
    else if (state.repeat === "all" && state.queue.length) { state.index = 0; start(); }
    else if (state.queue.length) {
      // The end of the queue: wait for its radio, then go on.
      const token = playToken;
      state.loading = 0;
      refresh();
      void extendQueue().then(() => {
        if (token !== playToken) return;
        state.loading = null;
        const after = following();
        if (after < state.queue.length) { state.index = after; start(); } else refresh();
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
    // Neighbours differ: never one song twice in a row, and artists alternate where they can.
    const current = state.queue[state.index];
    state.queue = [...state.queue.slice(0, state.index + 1), ...shuffled(state.queue.slice(state.index + 1), current)];
  };

  /** Play/pause; a queue restored from the last session (no stream yet) starts where it stopped. */
  state.togglePlay = () => {
    if (state.path) { if (state.playing) state.media()?.pause(); else state.media()?.play(); return; }
    if (state.loading === null && state.queue[state.index]) start(state.playError ? 0 : state.time);
    refresh();
  };
  state.seekBy = seconds => {
    if (!state.path) return;
    const duration = state.duration || state.queue[state.index]?.duration || 0;
    const time = Math.max(0, Math.min(duration > 0 ? duration - 1 : Infinity, state.time + seconds));
    state.media()?.seek(time);
    state.time = time;
    state.followLyrics();
    refresh();
  };
  let noticeTimer: ReturnType<typeof setTimeout> | undefined;
  state.notify = text => {
    state.notice = text;
    clearTimeout(noticeTimer);
    noticeTimer = setTimeout(() => { state.notice = null; refresh(); }, 2500);
    refresh();
  };
  /** Nothing playing: the song starts. Otherwise it goes in at `at`, moved there if it was already coming up. */
  const enqueue = (song: Song, at: number, done: string) => {
    if (!state.queue[state.index]) { state.play([song], 0, "Queue"); return; }
    if (sameSong(song, state.queue[state.index])) { state.notify("Already playing"); return; }
    const queue = state.queue.filter((item, i) => i <= state.index || !sameSong(item, song));
    // Its upcoming copies went above; the current song was checked, so it plays once from here.
    queue.splice(Math.min(at, queue.length), 0, song);
    state.queue = queue;
    state.notify(done);
  };
  state.playNext = song => enqueue(song, state.index + 1, `"${song.title}" plays next`);
  state.addToQueue = song => enqueue(song, state.queue.length, `"${song.title}" added to queue`);
  state.removeFromQueue = index => {
    if (index === state.index || !state.queue[index]) return;
    state.queue = state.queue.filter((_, i) => i !== index);
    if (index < state.index) state.index--;
    refresh();
  };
  state.clearUpNext = () => {
    state.queue = state.queue.slice(0, state.index + 1);
    radioFor = null;
    refresh();
  };
  state.toggleAutoplay = () => {
    state.autoplay = !state.autoplay;
    if (state.autoplay && state.index >= 0 && state.index + 3 >= state.queue.length) void extendQueue();
    refresh();
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
  const ANDROID_SIGN_IN = "https://accounts.google.com/ServiceLogin?ltmpl=music&service=youtube&passive=true&continue=" + encodeURIComponent("https://www.youtube.com/signin?action_handle_signin=true&next=https://music.youtube.com/");
  state.signInWithBrowser = () => {
    signInAbort?.abort();
    const abort = signInAbort = new AbortController();
    state.signIn = "browser";
    state.signInError = null;
    // Android: Google's sign-in in the app's WebView (Tarve's webSignIn); desktops: a browser window.
    const signIn = phone
      ? app.webSignIn({ url: ANDROID_SIGN_IN, cookieUrl: "https://music.youtube.com", cookies: ["SAPISID", "__Secure-3PAPISID"] })
      : signInWithBrowser(abort.signal);
    signIn.then(cookies => {
      // Backed out of Google's page: nothing to report.
      if (!cookies) { state.signIn = "closed"; refresh(); return; }
      source.useCookies(cookies);
      signedIn();
    }, error => {
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

  // YouTube's keyboard shortcuts. A focused text field keeps its keys, so typing a search is unaffected.
  const keys: [string, () => void][] = [
    ["Space", state.togglePlay], ["K", state.togglePlay],
    ["J", () => state.seekBy(-10)], ["L", () => state.seekBy(10)],
    ["Shift+N", state.next], ["Shift+P", state.previous],
    ["M", () => { state.muted = !state.muted; }],
    ["=", () => { state.volume = Math.min(1, Math.round(state.volume * 100 + 5) / 100); state.muted = false; }],
    ["-", () => { state.volume = Math.max(0, Math.round(state.volume * 100 - 5) / 100); }],
    ["S", state.toggleShuffle],
    ["R", () => { state.repeat = state.repeat === "off" ? "all" : state.repeat === "all" ? "one" : "off"; }],
    ["Q", () => { state.showQueue = !state.showQueue; }],
  ];
  for (const [key, run] of keys) app.registerHotkey(key, () => { run(); refresh(); });
  state.signedIn = source.signedIn();
  show({ kind: "home" });
  if (state.signedIn) void source.library().then(list => { state.library = list; refresh(); }, () => undefined);
}
