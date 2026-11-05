// The last session of the youtube-music example: the queue, the song and where it was,
// volume and playback modes. Reopening the app picks up where it was left, paused,
// instead of an empty player (the official web app forgets its queue on reload).
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { dataDir, type Song } from "./youtube-music-source";
import { state, type Repeat } from "./youtube-music-view";

const sessionFile = join(dataDir, "session.json");
/** Songs kept around the current one: enough history and up-next, a small file. */
const KEPT = 200;

interface Session {
  queue: Song[]; index: number; time: number; source: string;
  volume: number; muted: boolean; shuffle: boolean; repeat: Repeat; autoplay: boolean;
}

const isSong = (value: unknown): value is Song =>
  !!value && typeof value === "object" && (value as Song).kind === "song" && typeof (value as Song).id === "string" && typeof (value as Song).title === "string";

export function restoreSession(): void {
  let saved: Partial<Session>;
  try { saved = existsSync(sessionFile) ? JSON.parse(readFileSync(sessionFile, "utf8")) : {}; } catch { return; }
  if (typeof saved.volume === "number" && saved.volume >= 0 && saved.volume <= 1) state.volume = saved.volume;
  if (typeof saved.muted === "boolean") state.muted = saved.muted;
  if (typeof saved.shuffle === "boolean") state.shuffle = saved.shuffle;
  if (saved.repeat === "off" || saved.repeat === "all" || saved.repeat === "one") state.repeat = saved.repeat;
  if (typeof saved.autoplay === "boolean") state.autoplay = saved.autoplay;
  const queue = Array.isArray(saved.queue) ? saved.queue.filter(isSong) : [];
  const index = typeof saved.index === "number" ? Math.floor(saved.index) : -1;
  if (!queue[index]) return;
  state.queue = queue;
  state.index = index;
  state.source = typeof saved.source === "string" ? saved.source : "";
  state.time = typeof saved.time === "number" && saved.time > 0 ? saved.time : 0;
  state.duration = queue[index]!.duration ?? 0;
}

let written = "";
export function saveSession(): void {
  const from = Math.max(0, state.index - 20);
  const session: Session = {
    queue: state.queue.slice(from, from + KEPT), index: state.index - from, time: Math.floor(state.time), source: state.source,
    volume: state.volume, muted: state.muted, shuffle: state.shuffle, repeat: state.repeat, autoplay: state.autoplay,
  };
  const text = JSON.stringify(session);
  if (text === written) return;
  try {
    mkdirSync(dataDir, { recursive: true });
    writeFileSync(sessionFile, text);
    written = text;
  } catch { /* A read-only home only loses the session. */ }
}
