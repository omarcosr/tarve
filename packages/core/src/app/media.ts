import type { NativeCommand } from "../protocol";
import { clampRate, type MediaController, type MediaRequest } from "../media-element";
import type { CompiledTree } from "../reconciler";
import { isAbsolute } from "node:path";
import { nativeAssetPath } from "#tarve/assets";

type MediaCommand = Extract<NativeCommand, { type: "media" }>;

/**
 * A path the native decoder can open: `file://` URLs as paths, relative paths as given
 * (the runtime resolves them from the working directory), and files embedded in an executable (`import film from
 * "./film.mp4" with { type: "file" }`) extracted once. Other URLs pass through.
 */
function resolveMediaPath(src: string): string {
  const path = src.startsWith("file://") ? decodeURIComponent(new URL(src).pathname).replace(/^\/([A-Za-z]:)/, "$1") : src;
  if (/^[a-z][a-z0-9+.-]+:\/\//i.test(path) || path.startsWith("data:")) return path;
  return isAbsolute(path) ? nativeAssetPath(path) : path;
}

/**
 * Keeps native media in step with the elements of each committed render: loads
 * new sources, updates changed flags, unloads elements that went away.
 * `send` receives the command and the error-event name for reporting.
 */
export function createMediaSync(send: (command: MediaCommand, event: string, targetId: string) => void): (committed: CompiledTree) => void {
  const loaded = new Map<string, MediaRequest>();
  return committed => {
    const wanted = committed.media ?? new Map<string, MediaRequest>();
    for (const id of [...loaded.keys()]) {
      if (!wanted.has(id) || !wanted.get(id)!.src) {
        loaded.delete(id);
        send({ type: "media", id, action: "unload" }, "media:unload", id);
      }
    }
    for (const [id, request] of wanted) {
      if (!request.src) continue;
      const previous = loaded.get(id);
      const src = resolveMediaPath(request.src);
      if (!previous || resolveMediaPath(previous.src!) !== src || previous.video !== request.video) {
        send({ type: "media", id, action: "load", src, loop: request.loop, muted: request.muted, volume: request.volume, ...(request.video ? { kind: "video" as const } : {}) }, "media:load", id);
        if (request.rate !== 1) send({ type: "media", id, action: "rate", rate: request.rate }, "media:rate", id);
        if (request.autoPlay) send({ type: "media", id, action: "play" }, "media:play", id);
      } else {
        if (previous.loop !== request.loop || previous.muted !== request.muted || previous.volume !== request.volume) {
          send({ type: "media", id, action: "set", loop: request.loop, muted: request.muted, volume: request.volume }, "media:set", id);
        }
        if (previous.rate !== request.rate) send({ type: "media", id, action: "rate", rate: request.rate }, "media:rate", id);
      }
      loaded.set(id, request);
    }
  };
}

/** HTMLMediaElement methods for the element `id`, each a native media command. */
export function mediaController(id: string, send: (command: MediaCommand) => void): MediaController {
  const command = (rest: Omit<MediaCommand, "type" | "id">) => send({ type: "media", id, ...rest } as MediaCommand);
  return {
    play: () => command({ action: "play" }),
    pause: () => command({ action: "pause" }),
    seek: seconds => command({ action: "seek", time: Math.max(0, seconds) }),
    setVolume: volume => command({ action: "set", volume: Math.min(1, Math.max(0, volume)) }),
    setMuted: muted => command({ action: "set", muted }),
    setPlaybackRate: rate => command({ action: "rate", rate: clampRate(rate) }),
    setAudioTrack: track => command({ action: "audioTrack", track }),
    setTextTrack: track => command(track === null ? { action: "textTrack" } : { action: "textTrack", track }),
  };
}
