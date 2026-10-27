import { describe, expect, test } from "bun:test";
import type { NativeCommand } from "../protocol";
import type { CompiledTree } from "../reconciler";
import { mediaRequest } from "../media-element";
import { createMediaSync, mediaController } from "./media";

type MediaCommand = Extract<NativeCommand, { type: "media" }>;

function tree(requests: Record<string, Parameters<typeof mediaRequest>[0]>): CompiledTree {
  return { media: new Map(Object.entries(requests).map(([id, props]) => [id, mediaRequest(props)])) } as unknown as CompiledTree;
}

describe("createMediaSync", () => {
  test("loads new sources, updates flags in place, and unloads elements that left", () => {
    const sent: [MediaCommand, string][] = [];
    const sync = createMediaSync((command, event) => { sent.push([command, event]); });
    sync(tree({ song: { src: "a.mp3", autoPlay: true }, other: { src: "b.mp3" } }));
    expect(sent.map(([command, event]) => `${command.id}:${command.action}:${event}`)).toEqual([
      "song:load:media:load", "song:play:media:play", "other:load:media:load",
    ]);
    sent.length = 0;
    sync(tree({ song: { src: "a.mp3", muted: true }, other: { src: "b.mp3" } }));
    expect(sent).toEqual([[{ type: "media", id: "song", action: "set", loop: false, muted: true, volume: 1 }, "media:set"]]);
    sent.length = 0;
    sync(tree({ song: { src: "c.mp3", muted: true } }));
    expect(sent.map(([command]) => `${command.id}:${command.action}`)).toEqual(["other:unload", "song:load"]);
    sent.length = 0;
    sync(tree({ song: { src: "c.mp3", muted: true } }));
    expect(sent).toEqual([]);
    sync(tree({ song: { src: "c.mp3", muted: true, playbackRate: 1.5 } }));
    expect(sent).toEqual([[{ type: "media", id: "song", action: "rate", rate: 1.5 }, "media:rate"]]);
    sent.length = 0;
    sync(tree({ song: { src: "d.mp3", playbackRate: 2 } }));
    expect(sent.map(([command]) => `${command.action}:${command.rate ?? ""}`)).toEqual(["load:", "rate:2"]);
  });

  test("a file URL loads by path and an element without src is unloaded", () => {
    const sent: MediaCommand[] = [];
    const sync = createMediaSync(command => { sent.push(command); });
    sync(tree({ song: { src: "file:///C:/music/a.mp3" } }));
    expect(sent[0]).toMatchObject({ action: "load", src: "C:/music/a.mp3" });
    sync(tree({ song: {} }));
    expect(sent[1]).toMatchObject({ id: "song", action: "unload" });
  });
});

describe("mediaController", () => {
  test("maps HTMLMediaElement methods to clamped native commands", () => {
    const sent: MediaCommand[] = [];
    const media = mediaController("song", command => { sent.push(command); });
    media.play(); media.pause(); media.seek(-5); media.setVolume(2); media.setMuted(true); media.setPlaybackRate(99); media.setPlaybackRate(Number.NaN); media.setAudioTrack(2);
    expect(sent).toEqual([
      { type: "media", id: "song", action: "play" },
      { type: "media", id: "song", action: "pause" },
      { type: "media", id: "song", action: "seek", time: 0 },
      { type: "media", id: "song", action: "set", volume: 1 },
      { type: "media", id: "song", action: "set", muted: true },
      { type: "media", id: "song", action: "rate", rate: 16 },
      { type: "media", id: "song", action: "rate", rate: 1 },
      { type: "media", id: "song", action: "audioTrack", track: 2 },
    ]);
  });
});
