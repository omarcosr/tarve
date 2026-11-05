package ytm

import (
	"strings"
	"testing"
)

func qsong(id, title, artist string) *Item {
	d := 180.0
	return &Item{Kind: "song", ID: id, Title: title, Artist: artist, Duration: &d}
}

// The same cases as youtube-music-queue.test.ts.
func TestSongKey(t *testing.T) {
	same := [][2]*Item{
		{qsong("1", "Blinding Lights (Official Video)", "The Weeknd"), qsong("2", "Blinding Lights", "The Weeknd")},
		{qsong("1", "Evidências - Ao Vivo", "Chitãozinho & Xororó"), qsong("2", "Evidencias (Ao Vivo)", "Chitaozinho")},
		{qsong("1", "Song (feat. B)", "A"), qsong("2", "Song", "A, B")},
		{qsong("1", "The Weeknd - Blinding Lights (Official Video)", "TheWeekndVEVO"), qsong("2", "Blinding Lights", "The Weeknd")},
		{qsong("1", "Blinding Lights - The Weeknd", "The Weeknd - Topic"), qsong("2", "Blinding Lights", "The Weeknd")},
	}
	for _, pair := range same {
		if SongKey(pair[0]) != SongKey(pair[1]) {
			t.Errorf("%q and %q: %q != %q", pair[0].Title, pair[1].Title, SongKey(pair[0]), SongKey(pair[1]))
		}
	}
	// Another artist's song of the same name is another song, and so is a remix.
	if SameSong(qsong("1", "One", "A"), qsong("2", "Two", "A")) || SameSong(qsong("1", "Song", "A"), qsong("2", "Song (Remix)", "A")) || SameSong(qsong("1", "Song", "A"), qsong("2", "Song", "B")) {
		t.Error("different songs matched")
	}
}

func TestDistinct(t *testing.T) {
	list := []*Item{qsong("a", "a", "A"), qsong("a", "a", "A"), qsong("b", "B", "A"), qsong("c", "C", "A"), qsong("b2", "B (Lyric Video)", "A"), qsong("a3", "a (Audio)", "A"), qsong("d", "D", "A")}
	ids := func(songs []*Item) string {
		out := []string{}
		for _, s := range songs {
			out = append(out, s.ID)
		}
		return strings.Join(out, ",")
	}
	if songs, index := Distinct(list, 3); ids(songs) != "a,b,c,d" || index != 2 {
		t.Fatalf("got %s, index %d", ids(songs), index)
	}
	// The picked copy wins over an earlier one.
	if songs, index := Distinct(list, 4); ids(songs) != "a,c,b2,d" || index != 2 {
		t.Fatalf("got %s, index %d", ids(songs), index)
	}
}

func TestShuffledNeighboursDiffer(t *testing.T) {
	list := []*Item{qsong("x1", "X", "P"), qsong("x2", "X (Official Audio)", "P"), qsong("y", "Y", "P"), qsong("z", "Z", "Q"), qsong("w", "W", "Q")}
	for run := 0; run < 50; run++ {
		order := Shuffled(list, qsong("y0", "Y", "P"))
		if order[0].Title == "Y" {
			t.Fatal("the song just played came first")
		}
		for i := 1; i < len(order); i++ {
			if SameSong(order[i], order[i-1]) {
				t.Fatal("a song follows itself")
			}
			if i < 3 && order[i].Artist == order[i-1].Artist {
				t.Fatal("artists did not alternate")
			}
		}
	}
	got := Spread([]*Item{qsong("a", "A", "P"), qsong("b", "B", "P"), qsong("c", "C", "Q")}, nil)
	if got[0].ID != "a" || got[1].ID != "c" || got[2].ID != "b" {
		t.Fatalf("spread order %s %s %s", got[0].ID, got[1].ID, got[2].ID)
	}
}
