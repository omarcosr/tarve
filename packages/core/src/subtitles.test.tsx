import { describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Window } from "./components";
import { applyMediaEvent } from "./media-element";
import { compileTree } from "./reconciler";
import { clearSubtitleCache, cueAt, loadSubtitles, nextCueChange, parseSubtitles } from "./subtitles";

const VTT = "WEBVTT\n\n1\n00:00:01.000 --> 00:00:02.500 line:90%\n<i>Olá</i> &amp; tchau\n\n00:03.000 --> 00:04.000\nSegunda\nlinha\n";
const SRT = "1\r\n00:00:01,000 --> 00:00:02,000\r\n{\\an8}Hello\r\n\r\n2\r\n00:00:05,250 --> 00:00:06,000\r\nWorld\r\n";

describe("subtitles", () => {
  test("WebVTT and SubRip parse into cues without markup", () => {
    expect(parseSubtitles(VTT)).toEqual([
      { start: 1, end: 2.5, text: "Olá & tchau" },
      { start: 3, end: 4, text: "Segunda\nlinha" },
    ]);
    expect(parseSubtitles(SRT)).toEqual([{ start: 1, end: 2, text: "Hello" }, { start: 5.25, end: 6, text: "World" }]);
    const cues = parseSubtitles(VTT);
    expect([cueAt(cues, 0.5), cueAt(cues, 1.2), cueAt(cues, 3.5), cueAt(cues, 4.2)]).toEqual(["", "Olá & tchau", "Segunda\nlinha", ""]);
    expect([nextCueChange(cues, 0), nextCueChange(cues, 1.2), nextCueChange(cues, 2.6), nextCueChange(cues, 5)]).toEqual([1, 2.5, 3, undefined]);
  });

  test("a video shows the cue under the current time of the chosen track", async () => {
    clearSubtitleCache();
    const dir = mkdtempSync(join(tmpdir(), "tarve-subs-"));
    const path = join(dir, "pt.vtt");
    writeFileSync(path, VTT);
    const scope = {};
    const view = (subtitle: number | null) => <Window><video id="v" src="a.mp4" subtitles={[{ src: path, label: "Português" }]} subtitle={subtitle} /></Window>;
    expect(compileTree(view(0), false, "auto", [], scope).nodes.has("v-subtitle")).toBe(false);
    expect(loadSubtitles(path)).toBeUndefined();
    for (let i = 0; i < 50 && !loadSubtitles(path); i++) await new Promise(resolve => setTimeout(resolve, 10));
    const tree = compileTree(view(0), false, "auto", [], scope);
    applyMediaEvent({ id: "v", event: "timeupdate", time: 1.5 }, tree.media!.get("v"), scope);
    const shown = compileTree(view(0), false, "auto", [], scope);
    expect([...shown.nodes.values()].some(node => node.text === "Olá & tchau")).toBe(true);
    expect(compileTree(view(null), false, "auto", [], scope).nodes.has("v-subtitle")).toBe(false);
  });

  test("audiotracks events reach onAudioTracksChange", () => {
    const seen: unknown[] = [];
    const scope = {};
    const tree = compileTree(<Window><video id="w" src="a.mp4" onAudioTracksChange={info => seen.push(info.audioTracks)} /></Window>, false, "auto", [], scope);
    const tracks = [{ id: 1, label: "Portugues", language: "por", enabled: true }, { id: 2, label: "English", language: "eng", enabled: false }];
    applyMediaEvent({ id: "w", event: "audiotracks", audioTracks: tracks }, tree.media!.get("w"), scope)?.();
    expect(seen).toEqual([tracks]);
  });
});
