import { expect, test } from "bun:test";
import { distinct, sameSong, shuffled, songKey, spread } from "./youtube-music-queue";

const song = (id: string, title = id, artist = "A") => ({ kind: "song" as const, id, title, artist, album: "", duration: 180, thumbnail: null });

test("the videos of one song share its key", () => {
  expect(songKey(song("1", "Blinding Lights (Official Video)", "The Weeknd"))).toBe(songKey(song("2", "Blinding Lights", "The Weeknd")));
  expect(songKey(song("1", "Evidências - Ao Vivo", "Chitãozinho & Xororó"))).toBe(songKey(song("2", "Evidencias (Ao Vivo)", "Chitaozinho")));
  expect(songKey(song("1", "Song (feat. B)", "A"))).toBe(songKey(song("2", "Song", "A, B")));
  expect(sameSong(song("1", "One"), song("2", "Two"))).toBe(false);
  expect(songKey(song("1", "The Weeknd - Blinding Lights (Official Video)", "TheWeekndVEVO"))).toBe(songKey(song("2", "Blinding Lights", "The Weeknd")));
  expect(songKey(song("1", "Blinding Lights - The Weeknd", "The Weeknd - Topic"))).toBe(songKey(song("2", "Blinding Lights", "The Weeknd")));
  // Another artist's song of the same name is another song, and so is a remix.
  expect(sameSong(song("1", "Song", "A"), song("2", "Song", "B"))).toBe(false);
  expect(sameSong(song("1", "Song"), song("2", "Song (Remix)"))).toBe(false);
});

test("a song listed more than once plays once, and the index follows the picked song", () => {
  const list = [song("a"), song("a"), song("b", "B"), song("c", "C"), song("b2", "B (Lyric Video)"), song("a3", "a (Audio)"), song("d", "D")];
  const clean = distinct(list, 3);
  expect(clean.songs.map(item => item.id)).toEqual(["a", "b", "c", "d"]);
  expect(clean.index).toBe(2);
  // The picked copy wins over an earlier one.
  const picked = distinct(list, 4);
  expect(picked.songs.map(item => item.id)).toEqual(["a", "c", "b2", "d"]);
  expect(picked.index).toBe(2);
});

test("shuffle never puts a song after itself and alternates artists where it can", () => {
  const list = [song("x1", "X", "P"), song("x2", "X (Official Audio)", "P"), song("y", "Y", "P"), song("z", "Z", "Q"), song("w", "W", "Q")];
  for (let run = 0; run < 50; run++) {
    const order = shuffled(list, song("y0", "Y", "P"));
    expect(order[0]!.title).not.toBe("Y");
    for (let i = 1; i < order.length; i++) {
      expect(sameSong(order[i], order[i - 1])).toBe(false);
      expect(order[i]!.artist !== order[i - 1]!.artist || i >= 3).toBe(true);
    }
  }
  expect(spread([song("a", "A", "P"), song("b", "B", "P"), song("c", "C", "Q")]).map(item => item.id)).toEqual(["a", "c", "b"]);
});
