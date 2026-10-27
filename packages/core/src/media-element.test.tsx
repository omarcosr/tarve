import { describe, expect, test } from "bun:test";
import { Window } from "./components";
import { compileTree } from "./reconciler";
import { applyMediaEvent, mediaRequest, mediaState } from "./media-element";
import { createMediaSync } from "./app/media";

describe("mediaRequest", () => {
  test("defaults and clamps the element's flags", () => {
    expect(mediaRequest({ src: "a.mp3" })).toMatchObject({ src: "a.mp3", loop: false, muted: false, volume: 1, autoPlay: false });
    expect(mediaRequest({ volume: 4, loop: true }).volume).toBe(1);
    expect(mediaRequest({ volume: -1 }).volume).toBe(0);
    expect("src" in mediaRequest({})).toBe(false);
  });
});

describe("applyMediaEvent", () => {
  test("tracks playback per scope and returns the matching handler", () => {
    const scope = {};
    const seen: string[] = [];
    const request = mediaRequest({ src: "a.mp3", onPlay: info => { seen.push(`play:${info.paused}`); }, onEnded: info => { seen.push(`ended:${info.currentTime}`); } });
    expect(mediaState("song", scope)).toEqual({ paused: true, time: 0, duration: null, ended: false });
    applyMediaEvent({ id: "song", event: "loadedmetadata", duration: 120 }, request, scope);
    applyMediaEvent({ id: "song", event: "play", paused: false }, request, scope)?.();
    applyMediaEvent({ id: "song", event: "timeupdate", time: 42 }, request, scope);
    expect(mediaState("song", scope)).toMatchObject({ paused: false, time: 42, duration: 120, ended: false });
    applyMediaEvent({ id: "song", event: "ended" }, request, scope)?.();
    expect(mediaState("song", scope)).toMatchObject({ paused: true, ended: true });
    expect(seen).toEqual(["play:false", "ended:42"]);
    // Another app (scope) knows nothing about this element.
    expect(mediaState("song", {}).time).toBe(0);
  });

  test("an error keeps the message and calls onError", () => {
    const scope = {};
    const errors: string[] = [];
    const request = mediaRequest({ onError: message => { errors.push(message); } });
    applyMediaEvent({ id: "m", event: "error", message: "404" }, request, scope)?.();
    expect(mediaState("m", scope).error).toBe("404");
    expect(errors).toEqual(["404"]);
    const codes: string[] = [];
    const coded = mediaRequest({ onError: (_message, error) => { codes.push(error.code); } });
    applyMediaEvent({ id: "n", event: "error", message: "HTTP 404", code: "network" }, coded, scope)?.();
    applyMediaEvent({ id: "n", event: "error", message: "?" }, coded, scope)?.();
    expect(codes).toEqual(["network", "decode"]);
    const seen: string[] = [];
    const buffering = mediaRequest({ onWaiting: info => { seen.push(`waiting:${info.waiting}`); }, onCanPlay: info => { seen.push(`canplay:${info.waiting}:${info.buffered}`); }, onProgress: info => { seen.push(`progress:${info.buffered}`); }, onLoadedMetadata: info => { seen.push(`meta:${info.filename}`); } });
    applyMediaEvent({ id: "b", event: "loadedmetadata", filename: "ep 1.mp4", buffered: 4 }, buffering, scope)?.();
    applyMediaEvent({ id: "b", event: "waiting" }, buffering, scope)?.();
    expect(mediaState("b", scope).stalled).toBe(true);
    applyMediaEvent({ id: "b", event: "progress", buffered: 9 }, buffering, scope)?.();
    applyMediaEvent({ id: "b", event: "canplay" }, buffering, scope)?.();
    expect(seen).toEqual(["meta:ep 1.mp4", "waiting:true", "progress:9", "canplay:false:9"]);
    // Without a handler nothing is returned.
    expect(applyMediaEvent({ id: "m", event: "pause" }, undefined, scope)).toBeUndefined();
  });
});

describe("<audio>", () => {
  test("registers its media request and renders nothing without controls", () => {
    const tree = compileTree(<Window title="audio"><audio id="song" src="a.mp3" loop /></Window>);
    expect(tree.media?.get("song")).toMatchObject({ src: "a.mp3", loop: true });
    expect(tree.nodes.get("song")?.style.display).toBe("none");
    expect(tree.nodes.has("song-play")).toBe(false);
  });

  test("controls follow the playback state of the rendering app", () => {
    const scope = {};
    const view = () => <Window title="audio"><audio id="song" src="a.mp3" controls /></Window>;
    const before = compileTree(view(), false, "auto", [], scope);
    expect(before.nodes.get("song-play")?.control?.label).toBe("Play");
    expect(before.nodes.get("song-time")?.text).toBe("0:00 / --:--");
    applyMediaEvent({ id: "song", event: "loadedmetadata", duration: 95 }, before.media?.get("song"), scope);
    applyMediaEvent({ id: "song", event: "play", paused: false, time: 61 }, before.media?.get("song"), scope);
    const after = compileTree(view(), false, "auto", [], scope);
    expect(after.nodes.get("song-play")?.control?.label).toBe("Pause");
    expect(after.nodes.get("song-time")?.text).toBe("1:01 / 1:35");
  });
});

describe("<video>", () => {
  test("is a native video node the decoder fills, contain by default, registered as video media", () => {
    const tree = compileTree(<Window title="video"><video id="clip" src="clip.mp4" style={{ width: 320, radius: 8 }} /></Window>);
    const node = tree.nodes.get("clip")!;
    expect(node.kind).toBe("video");
    expect((node as { fit?: string }).fit).toBe("contain");
    expect(node.style.width).toBe(320);
    expect(tree.media?.get("clip")).toMatchObject({ src: "clip.mp4", video: true });
    expect(compileTree(<Window title="v"><video id="c" src="c.mp4" fit="cover" /></Window>).nodes.get("c")).toMatchObject({ fit: "cover" });
    expect(compileTree(<Window title="v"><video id="c" src="c.mp4" style={{ objectFit: "fill" }} /></Window>).nodes.get("c")).toMatchObject({ fit: "fill" });
    expect(compileTree(<Window title="v"><video id="c" src="c.mp4" className="object-cover" /></Window>).nodes.get("c")).toMatchObject({ fit: "cover" });
  });

  test("controls overlay the picture and follow playback, with the video's size", () => {
    const scope = {};
    const view = () => <Window title="video"><video id="clip" src="clip.mp4" controls style={{ width: 480, height: 270 }} /></Window>;
    const before = compileTree(view(), false, "auto", [], scope);
    expect(before.nodes.get("clip-player")?.style).toMatchObject({ width: 480, height: 270, position: "relative" });
    expect(before.nodes.get("clip")?.style).toMatchObject({ width: "100%", height: "100%" });
    expect(before.nodes.get("clip-controls")?.style.position).toBe("absolute");
    expect(before.nodes.get("clip-play")?.control?.label).toBe("Play");
    const seen: number[] = [];
    const request = { ...before.media!.get("clip")!, handlers: { onLoadedMetadata: (info: { videoWidth: number; videoHeight: number }) => { seen.push(info.videoWidth, info.videoHeight); } } };
    applyMediaEvent({ id: "clip", event: "loadedmetadata", duration: 10, videoWidth: 1920, videoHeight: 1080 }, request as never, scope)?.();
    expect(seen).toEqual([1920, 1080]);
    applyMediaEvent({ id: "clip", event: "play", paused: false, time: 3 }, request as never, scope);
    expect(compileTree(view(), false, "auto", [], scope).nodes.get("clip-play")?.control?.label).toBe("Pause");
  });

  test("a spinner in the middle while it opens or seeks, a large play button while paused", () => {
    const scope = {};
    const view = () => <Window title="video"><video id="clip" src="clip.mp4" controls style={{ width: 480, height: 270 }} /></Window>;
    const opening = compileTree(view(), false, "auto", [], scope);
    expect(opening.nodes.get("clip-spinner")?.control).toEqual({ role: "progress", label: "Loading" });
    expect(opening.nodes.has("clip-big-play")).toBe(false);
    const request = opening.media!.get("clip")!;
    applyMediaEvent({ id: "clip", event: "loadedmetadata", duration: 10, videoWidth: 1920, videoHeight: 1080 }, request, scope);
    const paused = compileTree(view(), false, "auto", [], scope);
    expect(paused.nodes.has("clip-spinner")).toBe(false);
    expect(paused.nodes.get("clip-big-play")?.control?.label).toBe("Play");
    applyMediaEvent({ id: "clip", event: "play", paused: false, time: 1 }, request, scope);
    const playing = compileTree(view(), false, "auto", [], scope);
    expect(playing.nodes.has("clip-big-play") || playing.nodes.has("clip-spinner")).toBe(false);
    expect(playing.nodes.get("clip-play")?.control?.label).toBe("Pause");
    applyMediaEvent({ id: "clip", event: "error", message: "404" }, request, scope);
    expect(compileTree(view(), false, "auto", [], scope).nodes.has("clip-spinner")).toBe(false);
  });

  test("the mute button toggles an element without a muted attribute, until the attribute changes", () => {
    const scope = {};
    const sent: boolean[] = [];
    const key = Symbol.for("tarve.activeApp");
    const before = (globalThis as Record<symbol, unknown>)[key];
    (globalThis as Record<symbol, unknown>)[key] = { media: () => ({ setMuted: (muted: boolean) => sent.push(muted) }) };
    try {
      const view = (muted?: boolean) => <Window title="video"><video id="clip" src="clip.mp4" controls muted={muted} /></Window>;
      compileTree(view(), false, "auto", [], scope).handlers.get("clip-mute")!.onClick!();
      const muted = compileTree(view(), false, "auto", [], scope);
      expect(muted.nodes.get("clip-mute")?.control?.label).toBe("Unmute");
      muted.handlers.get("clip-mute")!.onClick!();
      expect(sent).toEqual([true, false]);
      expect(compileTree(view(), false, "auto", [], scope).nodes.get("clip-mute")?.control?.label).toBe("Mute");
      compileTree(view(), false, "auto", [], scope).handlers.get("clip-mute")!.onClick!();
      // The app sets the attribute: it wins over the controls' choice.
      expect(compileTree(view(false), false, "auto", [], scope).nodes.get("clip-mute")?.control?.label).toBe("Unmute");
      expect(compileTree(view(true), false, "auto", [], scope).nodes.get("clip-mute")?.control?.label).toBe("Unmute");
    } finally {
      (globalThis as Record<symbol, unknown>)[key] = before;
    }
  });

  test("a new src shows the spinner again and forgets the old error and time", () => {
    const scope = {};
    const view = (src: string) => <Window title="video"><video id="clip" src={src} controls style={{ width: 480, height: 270 }} /></Window>;
    const a = compileTree(view("a.mp4"), false, "auto", [], scope);
    applyMediaEvent({ id: "clip", event: "loadedmetadata", duration: 10 }, a.media!.get("clip"), scope);
    applyMediaEvent({ id: "clip", event: "error", message: "decode", time: 7 }, a.media!.get("clip"), scope);
    const b = compileTree(view("b.mp4"), false, "auto", [], scope);
    expect(b.nodes.has("clip-spinner")).toBe(true);
    expect(b.nodes.get("clip-time")?.text).toBe("0:00 / --:--");
    applyMediaEvent({ id: "clip", event: "loadedmetadata", duration: 4 }, b.media!.get("clip"), scope);
    expect(mediaState("clip", scope)).toMatchObject({ src: "b.mp4", duration: 4, time: 0, loaded: true });
    expect(mediaState("clip", scope).error).toBeUndefined();
    expect(compileTree(view("b.mp4"), false, "auto", [], scope).nodes.has("clip-spinner")).toBe(false);
  });

  test("loads through the platform video decoder; switching between audio and video reloads", () => {
    const sent: Record<string, unknown>[] = [];
    const sync = createMediaSync(command => { sent.push(command); });
    sync(compileTree(<Window title="v"><video id="m" src="clip.mp4" autoPlay muted /></Window>));
    expect(sent).toEqual([
      { type: "media", id: "m", action: "load", src: "clip.mp4", loop: false, muted: true, volume: 1, kind: "video" },
      { type: "media", id: "m", action: "play" },
    ]);
    sent.length = 0;
    sync(compileTree(<Window title="v"><audio id="m" src="clip.mp4" muted /></Window>));
    expect(sent).toEqual([{ type: "media", id: "m", action: "load", src: "clip.mp4", loop: false, muted: true, volume: 1 }]);
  });
});
