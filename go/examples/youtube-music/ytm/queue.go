package ytm

// Queue rules, as youtube-music-queue.ts: a song (one artist's title) is in the queue once,
// even when YouTube lists it under different videos (the official video, the audio track, a
// lyric video, "Artist - Title" uploads), and shuffle spreads songs and artists out.

import (
	"math/rand"
	"regexp"
	"strings"
	"unicode"
)

var (
	// Version tags YouTube adds to a title that do not make it a different song.
	keyNoise    = regexp.MustCompile(`\b(official|video|audio|lyrics?|visuali[sz]er|music|clip|videoclipe|mv|hd|hq|4k|remaster(ed)?|explicit|letra|legendado|ao vivo|live)\b`)
	keyBrackets = regexp.MustCompile(`[(\[{]([^)\]}]*)[)\]}]`)
	keyFeat     = regexp.MustCompile(`\b(feat|ft)\b`)
	keyTail     = regexp.MustCompile(`\s[-–|]\s(.*)$`)
	keyFeatTail = regexp.MustCompile(`\b(feat|ft)\.?\s.*$`)
	keyArtists  = regexp.MustCompile(`,|&|\s(?:x|e|and|feat\.?|ft\.?)\s|•`)
	keyRest     = regexp.MustCompile(`[^\p{L}\p{N}]+`)
	keyDash     = regexp.MustCompile(`^(.+?)\s[-–|]\s(.+)$`)
	keyChannel  = regexp.MustCompile(`(vevo|topic|official|oficial)$`)
)

// accents maps a precomposed Latin letter to its base letter: NFD without its combining marks.
var accents = func() map[rune]rune {
	m := map[rune]rune{}
	for base, all := range map[rune]string{
		'a': "àáâãäåāăą", 'c': "çćĉċč", 'd': "ď", 'e': "èéêëēĕėęě", 'g': "ĝğġģ", 'h': "ĥ", 'i': "ìíîïĩīĭįİ", 'j': "ĵ", 'k': "ķ",
		'l': "ĺļľ", 'n': "ñńņňǹ", 'o': "òóôõöōŏő", 'r': "ŕŗř", 's': "śŝşš", 't': "ţť", 'u': "ùúûüũūŭůűų", 'w': "ŵ", 'y': "ýÿŷ", 'z': "źżž",
	} {
		for _, r := range all {
			m[r] = base
		}
	}
	return m
}()

func foldAccents(s string) string {
	return strings.Map(func(r rune) rune {
		if unicode.Is(unicode.Mn, r) {
			return -1
		}
		if base, ok := accents[r]; ok {
			return base
		}
		return r
	}, s)
}

func cleanKey(s string) string {
	return strings.TrimSpace(keyRest.ReplaceAllString(foldAccents(s), " "))
}

// artistKey is the first artist, compared without spaces or channel suffixes: "The Weeknd",
// "TheWeekndVEVO" and "The Weeknd - Topic" match.
func artistKey(artist string) string {
	first := cleanKey(keyArtists.Split(strings.ToLower(artist), 2)[0])
	return keyChannel.ReplaceAllString(strings.ReplaceAll(first, " ", ""), "")
}

// SongKey is the same song under any of its videos: its first artist and its title without version tags.
func SongKey(song *Item) string {
	artist := artistKey(song.Artist)
	title := strings.ToLower(song.Title)
	title = keyBrackets.ReplaceAllStringFunc(title, func(all string) string {
		inner := keyBrackets.FindStringSubmatch(all)[1]
		if keyNoise.MatchString(inner) || keyFeat.MatchString(inner) {
			return " "
		}
		return all
	})
	// Uploads titled "Artist - Title" (or "Title - Artist"): the artist part is not the title.
	if dash := keyDash.FindStringSubmatch(title); dash != nil && artist != "" {
		if artistKey(dash[1]) == artist {
			title = dash[2]
		} else if artistKey(dash[2]) == artist {
			title = dash[1]
		}
	}
	title = keyTail.ReplaceAllStringFunc(title, func(all string) string {
		if keyNoise.MatchString(keyTail.FindStringSubmatch(all)[1]) {
			return " "
		}
		return all
	})
	title = cleanKey(keyFeatTail.ReplaceAllString(title, " "))
	if title == "" {
		return "id:" + song.ID
	}
	return artist + "|" + title
}

// SameSong reports whether a and b are one song (the same video, or two videos of it).
func SameSong(a, b *Item) bool {
	return a != nil && b != nil && (a.ID == b.ID || SongKey(a) == SongKey(b))
}

// Distinct keeps each song once (its first copy), so it cannot come back a song or two later;
// the song at index (the one picked) wins over earlier copies, and the index follows it.
func Distinct(songs []*Item, index int) ([]*Item, int) {
	picked := ""
	if index >= 0 && index < len(songs) {
		picked = SongKey(songs[index])
	}
	seen := map[string]bool{}
	out := []*Item{}
	at := 0
	for i, song := range songs {
		key := SongKey(song)
		if i == index {
			at = len(out)
			out = append(out, song)
			seen[key] = true
			continue
		}
		if seen[key] || (i < index && key == picked) {
			continue
		}
		seen[key] = true
		out = append(out, song)
	}
	return out, at
}

func artistOf(song *Item) string {
	if song == nil {
		return "\x00"
	}
	return strings.SplitN(SongKey(song), "|", 2)[0]
}

// Spread orders songs so neighbours differ: never the same song twice in a row (nor after
// then itself), and, where the list allows, not the same artist back to back.
func Spread(songs []*Item, after *Item) []*Item {
	rest := append([]*Item{}, songs...)
	out := []*Item{}
	for len(rest) > 0 {
		previous := after
		if len(out) > 0 {
			previous = out[len(out)-1]
		}
		pick := -1
		for i, song := range rest {
			if !SameSong(song, previous) && (previous == nil || artistOf(song) != artistOf(previous)) {
				pick = i
				break
			}
		}
		if pick < 0 {
			for i, song := range rest {
				if !SameSong(song, previous) {
					pick = i
					break
				}
			}
		}
		// Only repeats of the previous song are left: they would play back to back, so they go.
		if pick < 0 {
			break
		}
		out = append(out, rest[pick])
		rest = append(rest[:pick:pick], rest[pick+1:]...)
	}
	return out
}

// Shuffled is a random order where neighbours still differ (see Spread).
func Shuffled(songs []*Item, after *Item) []*Item {
	list := append([]*Item{}, songs...)
	for i := len(list) - 1; i > 0; i-- {
		j := rand.Intn(i + 1)
		list[i], list[j] = list[j], list[i]
	}
	return Spread(list, after)
}
