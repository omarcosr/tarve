import type { NativeCommand } from "../protocol";
import type { MediaController, MediaRequest } from "../media-element";
import type { CompiledTree } from "../reconciler";

type MediaCommand = Extract<NativeCommand, { type: "media" }>;

function resolveMediaPath(src: string): string {
  return src.startsWith("file://") ? new URL(src).pathname.replace(/^\/([A-Za-z]:)/, "$1") : src;
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
      if (!previous || resolveMediaPath(previous.src!) !== src) {
        send({ type: "media", id, action: "load", src, loop: request.loop, muted: request.muted, volume: request.volume }, "media:load", id);
        if (request.autoPlay) send({ type: "media", id, action: "play" }, "media:play", id);
      } else if (previous.loop !== request.loop || previous.muted !== request.muted || previous.volume !== request.volume) {
        send({ type: "media", id, action: "set", loop: request.loop, muted: request.muted, volume: request.volume }, "media:set", id);
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
  };
}
