package ytm

import (
	"context"
	"encoding/json"
	"fmt"
	"math"
	"net/http"
	"net/url"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"time"
)

// Lyrics for the song playing: time-synced from LRCLIB (lrclib.net), else the plain text YouTube Music shows.

var (
	offsetTag = regexp.MustCompile(`(?i)^\[offset:\s*([+-]?\d+)\]`)
	stamp     = regexp.MustCompile(`^\[(\d+):(\d+(?:[.:]\d+)?)\]`)
)

// ParseLrc parses LRC: [mm:ss.xx] text, several stamps per line allowed, plus an [offset:ms] tag.
func ParseLrc(text string) []LyricLine {
	offset := 0.0
	lines := []LyricLine{}
	for _, raw := range lineBreak.Split(text, -1) {
		if m := offsetTag.FindStringSubmatch(raw); m != nil {
			v, _ := strconv.ParseFloat(m[1], 64)
			offset = v / 1000
			continue
		}
		var stamps []float64
		rest := raw
		for {
			m := stamp.FindStringSubmatch(rest)
			if m == nil {
				break
			}
			minutes, _ := strconv.ParseFloat(m[1], 64)
			secs, _ := strconv.ParseFloat(strings.Replace(m[2], ":", ".", 1), 64)
			stamps = append(stamps, minutes*60+secs)
			rest = rest[len(m[0]):]
		}
		for _, t := range stamps {
			lines = append(lines, LyricLine{Time: math.Max(0, t-offset), Text: strings.TrimSpace(rest)})
		}
	}
	sort.SliceStable(lines, func(i, j int) bool { return lines[i].Time < lines[j].Time })
	return lines
}

const lrclibAPI = "https://lrclib.net/api"

type lrclibTrack struct {
	TrackName    string  `json:"trackName"`
	ArtistName   string  `json:"artistName"`
	Duration     float64 `json:"duration"`
	Instrumental bool    `json:"instrumental"`
	PlainLyrics  *string `json:"plainLyrics"`
	SyncedLyrics *string `json:"syncedLyrics"`
}

var (
	artistSplit = regexp.MustCompile(`,| & `)
	titleSuffix = regexp.MustCompile(`(?i)\s*[(\[](feat\.?|ft\.|with|from|remaster|\d{4} remaster)[^)\]]*[)\]]`)
)

func getJSON(ctx context.Context, link string, out any) (int, error) {
	req, _ := http.NewRequestWithContext(ctx, "GET", link, nil)
	req.Header.Set("user-agent", "tarve-youtube-music-example (https://github.com/omarcosr/tarve)")
	res, err := httpClient.Do(req)
	if err != nil {
		return 0, err
	}
	defer res.Body.Close()
	if res.StatusCode >= 200 && res.StatusCode < 300 {
		return res.StatusCode, json.NewDecoder(res.Body).Decode(out)
	}
	return res.StatusCode, nil
}

// lrclib errors when LRCLIB could not be asked; nil, nil when it has nothing.
func lrclib(ctx context.Context, song *Item) (*lrclibTrack, error) {
	artist := strings.TrimSpace(artistSplit.Split(song.Artist, 2)[0])
	title := strings.TrimSpace(titleSuffix.ReplaceAllString(song.Title, ""))
	if title == "" {
		title = song.Title
	}
	ctx, cancel := context.WithTimeout(ctx, 15*time.Second)
	defer cancel()
	exact := url.Values{"artist_name": {artist}, "track_name": {title}}
	if song.Duration != nil && *song.Duration != 0 {
		exact.Set("duration", formatJS(*song.Duration))
	}
	var track lrclibTrack
	status, err := getJSON(ctx, lrclibAPI+"/get?"+encodeOrdered(exact, "artist_name", "track_name", "duration"), &track)
	if err != nil {
		return nil, err
	}
	if status >= 200 && status < 300 {
		return &track, nil
	}
	if status != 404 {
		return nil, fmt.Errorf("LRCLIB answered HTTP %d", status)
	}
	var hits []lrclibTrack
	status, err = getJSON(ctx, lrclibAPI+"/search?"+encodeOrdered(url.Values{"artist_name": {artist}, "track_name": {title}}, "artist_name", "track_name"), &hits)
	if err != nil {
		return nil, err
	}
	if status < 200 || status > 299 {
		return nil, fmt.Errorf("LRCLIB answered HTTP %d", status)
	}
	var near []lrclibTrack
	for _, h := range hits {
		if song.Duration == nil || *song.Duration == 0 || math.Abs(h.Duration-*song.Duration) <= 5 {
			near = append(near, h)
		}
	}
	for _, h := range near {
		if h.SyncedLyrics != nil && *h.SyncedLyrics != "" {
			return &h, nil
		}
	}
	for _, h := range near {
		if (h.PlainLyrics != nil && *h.PlainLyrics != "") || h.Instrumental {
			return &h, nil
		}
	}
	return nil, nil
}

func formatJS(f float64) string { return strconv.FormatFloat(f, 'f', -1, 64) }

func encodeOrdered(v url.Values, keys ...string) string {
	var parts []string
	for _, k := range keys {
		if x, ok := v[k]; ok {
			parts = append(parts, url.QueryEscape(k)+"="+url.QueryEscape(x[0]))
		}
	}
	return strings.Join(parts, "&")
}

// LyricsFor is synced lyrics when LRCLIB has them, else YouTube Music's plain text, else LRCLIB's.
// nil, nil means neither has lyrics; an error means asking failed, so the caller can try later.
func LyricsFor(ctx context.Context, song *Item) (*Lyrics, error) {
	var failure error
	track, err := lrclib(ctx, song)
	if err != nil {
		if ctx.Err() != nil {
			return nil, err
		}
		failure = err
	}
	if track != nil && track.SyncedLyrics != nil {
		all := ParseLrc(*track.SyncedLyrics)
		lines := []LyricLine{}
		for i, l := range all {
			if l.Text != "" || (i > 0 && all[i-1].Text != "") {
				lines = append(lines, l)
			}
		}
		if len(lines) > 0 {
			return &Lyrics{Lines: lines, Source: "LRCLIB"}, nil
		}
	}
	if track != nil && track.Instrumental {
		s := "♪ Instrumental"
		return &Lyrics{Plain: &s, Source: "LRCLIB"}, nil
	}
	text, source, err := SongLyrics(ctx, song.ID)
	if err != nil {
		if ctx.Err() != nil {
			return nil, err
		}
		if failure == nil {
			failure = err
		}
	}
	if text != "" {
		return &Lyrics{Plain: &text, Source: source}, nil
	}
	if track != nil && track.PlainLyrics != nil && *track.PlainLyrics != "" {
		return &Lyrics{Plain: track.PlainLyrics, Source: "LRCLIB"}, nil
	}
	return nil, failure
}
