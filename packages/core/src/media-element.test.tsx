import { describe, expect, test } from "bun:test";
import { Window } from "./components";
import { compileTree } from "./reconciler";
import { applyMediaEvent, mediaRequest, mediaState } from "./media-element";

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
