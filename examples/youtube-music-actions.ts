// Connects the YouTube Music view to the data source, the sign-in window and the app.
import type { createApp } from "@tarve/core";
import { signInWithBrowser } from "./youtube-music-login";
import * as source from "./youtube-music-source";
import { AUDIO_ID, state, type Page } from "./youtube-music-view";

export function connect(app: ReturnType<typeof createApp>): void {
  // One render per burst: artwork arriving for a page of rows must not render it once per cover.
  let queued = false;
  const refresh = () => {
    if (queued) return;
    queued = true;
    setTimeout(() => { queued = false; app.update(); }, 16);
  };
  const message = (error: unknown) => (error instanceof Error ? error.message : String(error));
  state.refresh = refresh;
  state.media = () => app.media(AUDIO_ID);

  // The likeliest next click (Play, or the top result) resolves its stream URL ahead.
  const prefetch = (song: { id: string } | undefined) => { if (song) void source.streamUrl(song.id).catch(() => undefined); };
  source.warmUp();

  let pageToken = 0;
  async function load<T>(token: number, task: Promise<T>, apply: (value: T) => void): Promise<void> {
    try {
      const value = await task;
      if (token === pageToken) apply(value);
    } catch (error) {
      if (token === pageToken) state.pageError = message(error);
    }
    refresh();
  }
  function show(page: Page): void {
    const token = ++pageToken;
    state.page = page;
    state.pageError = null;
    state.listOffset = 0;
    if (page.kind === "home") { if (!state.shelves) void load(token, source.home(), shelves => { state.shelves = shelves; }); }
    else if (page.kind === "search") { state.results = null; if (page.query) void load(token, source.search(page.query), songs => { state.results = songs; prefetch(songs[0]); }); }
    else if (page.kind === "library") { if (state.signedIn) void load(token, source.library(), list => { state.library = list; }); }
    else if (page.kind === "playing") { /* the queue already holds it */ }
    else if (state.opened?.header.id !== page.entry.id) { state.opened = null; void load(token, source.collection(page.entry), opened => { state.opened = opened; prefetch(opened.songs[0]); }); }
    refresh();
  }
  state.open = page => {
    if (JSON.stringify(page) !== JSON.stringify(state.page)) state.back.push(state.page);
    show(page);
  };
  state.goBack = () => { const page = state.back.pop(); if (page) show(page); };

  let playToken = 0;
  function start(): void {
    const song = state.queue[state.index];
    if (!song) return;
    const token = ++playToken;
    state.path = undefined;
    state.playing = false;
    state.time = 0;
    state.duration = song.duration ?? 0;
    state.playError = null;
    state.loading = 0;
    source.streamUrl(song.id).then(url => {
      if (token !== playToken) return;
      // <audio> streams it: playback starts with the first chunk.
      state.loading = null;
      state.path = url;
      refresh();
      // Resolve the next song meanwhile so it starts at once.
      const upcoming = state.queue[state.index + 1];
      if (upcoming) void source.streamUrl(upcoming.id).catch(() => undefined);
    }, error => {
      if (token !== playToken) return;
      state.loading = null;
      state.playError = message(error);
      refresh();
    });
    refresh();
  }
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
    for (let i = rest.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [rest[i], rest[j]] = [rest[j]!, rest[i]!]; }
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
  void app.closed.then(() => { clearInterval(closeWatch); signInAbort?.abort(); });

  app.registerHotkey("Space", () => { if (!state.path) return; if (state.playing) state.media()?.pause(); else state.media()?.play(); });
  state.signedIn = source.signedIn();
  show({ kind: "home" });
  if (state.signedIn) void source.library().then(list => { state.library = list; refresh(); }, () => undefined);
}
