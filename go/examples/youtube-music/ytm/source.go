package ytm

import (
	"bytes"
	"context"
	"crypto/sha1"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"math"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"
	"sync"
	"time"
)

// The YouTube side of the example: a small InnerTube client (the private JSON API YouTube Music's
// web app uses) that also finds each song's audio URL. Personal-use demo: YouTube's Terms of
// Service forbid third-party clients.

const (
	origin    = "https://music.youtube.com"
	userAgent = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36"
)

var (
	dataDir    = func() string { h, _ := os.UserHomeDir(); return filepath.Join(h, ".tarve-youtube-music") }()
	cookieFile = filepath.Join(dataDir, "cookies.txt")
	sessionMu  sync.Mutex
	cookie     = func() string {
		if c := os.Getenv("YTM_COOKIE"); c != "" {
			return c
		}
		b, _ := os.ReadFile(cookieFile)
		return strings.TrimSpace(string(b))
	}()
	httpClient = &http.Client{}
)

func cookieValue(name string) string {
	sessionMu.Lock()
	defer sessionMu.Unlock()
	for _, pair := range regexp.MustCompile(`;\s*`).Split(cookie, -1) {
		if at := strings.Index(pair, "="); at > 0 && pair[:at] == name {
			return pair[at+1:]
		}
	}
	return ""
}

func sapisid() string {
	if v := cookieValue("SAPISID"); v != "" {
		return v
	}
	return cookieValue("__Secure-3PAPISID")
}

func SignedIn() bool { return sapisid() != "" }

var cookiePair = regexp.MustCompile(`^[^=\s]+=\S*$`)
var sapisidPair = regexp.MustCompile(`(^|; )(SAPISID|__Secure-3PAPISID)=`)

// UseCookies keeps a Cookie header that proves a signed-in Google account.
func UseCookies(header string) error {
	var pairs []string
	for _, part := range strings.Split(header, ";") {
		if p := strings.TrimSpace(part); cookiePair.MatchString(p) {
			pairs = append(pairs, p)
		}
	}
	next := strings.Join(pairs, "; ")
	if !sapisidPair.MatchString(next) {
		return errors.New("Those cookies carry no SAPISID: sign in to music.youtube.com first.")
	}
	sessionMu.Lock()
	cookie = next
	sessionMu.Unlock()
	os.MkdirAll(dataDir, 0o755)
	return os.WriteFile(cookieFile, []byte(next), 0o600)
}

func SignOut() {
	sessionMu.Lock()
	cookie = ""
	sessionMu.Unlock()
	os.Remove(cookieFile)
}

func authorization() string {
	id := sapisid()
	if id == "" {
		return ""
	}
	now := time.Now().Unix()
	sum := sha1.Sum([]byte(fmt.Sprintf("%d %s %s", now, id, origin)))
	return fmt.Sprintf("SAPISIDHASH %d_%s", now, hex.EncodeToString(sum[:]))
}

func call(ctx context.Context, endpoint string, body map[string]any, query string) (any, error) {
	if ctx == nil {
		ctx = context.Background()
	}
	payload := map[string]any{"context": map[string]any{"client": map[string]any{"clientName": "WEB_REMIX", "clientVersion": "1.20250101.01.00", "hl": "en", "gl": "US"}}}
	for k, v := range body {
		payload[k] = v
	}
	data, _ := json.Marshal(payload)
	req, err := http.NewRequestWithContext(ctx, "POST", origin+"/youtubei/v1/"+endpoint+"?prettyPrint=false"+query, bytes.NewReader(data))
	if err != nil {
		return nil, err
	}
	req.Header.Set("content-type", "application/json")
	req.Header.Set("origin", origin)
	req.Header.Set("x-origin", origin)
	req.Header.Set("user-agent", userAgent)
	sessionMu.Lock()
	c := cookie
	sessionMu.Unlock()
	if auth := authorization(); c != "" && auth != "" {
		req.Header.Set("cookie", c)
		req.Header.Set("authorization", auth)
		req.Header.Set("x-goog-authuser", "0")
	}
	res, err := httpClient.Do(req)
	if err != nil {
		return nil, err
	}
	defer res.Body.Close()
	if res.StatusCode < 200 || res.StatusCode > 299 {
		extra := ""
		if res.StatusCode == 401 {
			extra = " (signed out? sign in again)"
		}
		return nil, fmt.Errorf("YouTube Music answered HTTP %d%s", res.StatusCode, extra)
	}
	raw, err := io.ReadAll(res.Body)
	if err != nil {
		return nil, err
	}
	return decodeOrdered(raw)
}

func runsOf(text any) []any {
	r, _ := get(text, "runs").([]any)
	return r
}

func plain(text any) string {
	var b strings.Builder
	for _, run := range runsOf(text) {
		b.WriteString(gstr(run, "text"))
	}
	if b.Len() > 0 {
		return b.String()
	}
	return gstr(text, "simpleText")
}

func thumbnail(node any) *string {
	list, _ := first(node, "thumbnails").([]any)
	if len(list) == 0 {
		return nil
	}
	if u, ok := get(list[len(list)-1], "url").(string); ok {
		return &u
	}
	return nil
}

var durationLabel = regexp.MustCompile(`^\d+(:\d\d)+$`)

func seconds(label string) *float64 {
	if !durationLabel.MatchString(label) {
		return nil
	}
	total := 0.0
	for _, part := range strings.Split(label, ":") {
		n, _ := strconv.Atoi(part)
		total = total*60 + float64(n)
	}
	return &total
}

var pageTypes = map[string]string{"MUSIC_PAGE_TYPE_ALBUM": "album", "MUSIC_PAGE_TYPE_AUDIOBOOK": "album", "MUSIC_PAGE_TYPE_PLAYLIST": "playlist",
	"MUSIC_PAGE_TYPE_ARTIST": "artist", "MUSIC_PAGE_TYPE_USER_CHANNEL": "artist"}

func browseTarget(node any) (id, kind string) {
	endpoint := first(node, "browseEndpoint")
	kind = pageTypes[gstr(endpoint, "browseEndpointContextSupportedConfigs", "browseEndpointContextMusicConfig", "pageType")]
	id = gstr(endpoint, "browseId")
	if id == "" || kind == "" {
		return "", ""
	}
	return id, kind
}

var songWord = regexp.MustCompile(`^(Song|Video|Episode)$`)

func listItem(row any, album *Item) *Item {
	var columns []any
	flex, _ := get(row, "flexColumns").([]any)
	for _, column := range flex {
		columns = append(columns, get(column, "musicResponsiveListItemFlexColumnRenderer", "text"))
	}
	var col0 any
	if len(columns) > 0 {
		col0 = columns[0]
	}
	id := gstr(row, "playlistItemData", "videoId")
	if id == "" {
		id = gstr(first(col0, "watchEndpoint"), "videoId")
	}
	if id == "" {
		id = gstr(first(get(row, "overlay"), "watchEndpoint"), "videoId")
	}
	title := plain(col0)
	if id == "" || title == "" {
		return nil
	}
	var details []any
	if len(columns) > 1 {
		for _, column := range columns[1:] {
			details = append(details, runsOf(column)...)
		}
	}
	var artists []string
	albumText, hasAlbum := "", false
	durationRun := ""
	fallbackArtist, hasFallback := "", false
	for _, run := range details {
		text := gstr(run, "text")
		if _, kind := browseTarget(run); kind == "artist" {
			artists = append(artists, text)
		} else if kind == "album" && !hasAlbum {
			albumText, hasAlbum = text, true
		}
		if seconds(text) != nil && durationRun == "" {
			durationRun = text
		}
		if !hasFallback && text != " • " && seconds(text) == nil && !songWord.MatchString(text) {
			fallbackArtist, hasFallback = text, true
		}
	}
	song := &Item{Kind: "song", ID: id, Title: title}
	song.Artist = strings.Join(artists, ", ")
	if song.Artist == "" {
		song.Artist = fallbackArtist
	}
	if song.Artist == "" && album != nil {
		if parts := strings.Split(album.Subtitle, " • "); len(parts) > 1 {
			song.Artist = parts[1]
		}
	}
	if hasAlbum {
		song.Album = albumText
	} else if album != nil {
		song.Album = album.Title
	}
	song.Duration = seconds(plain(first(get(row, "fixedColumns"), "text")))
	if song.Duration == nil {
		song.Duration = seconds(durationRun)
	}
	song.Thumbnail = thumbnail(get(row, "thumbnail"))
	if song.Thumbnail == nil && album != nil {
		song.Thumbnail = album.Thumbnail
	}
	return song
}

func twoRowItem(card any) *Item {
	title, subtitle := plain(get(card, "title")), plain(get(card, "subtitle"))
	if video := gstr(first(get(card, "navigationEndpoint"), "watchEndpoint"), "videoId"); video != "" {
		artist := ""
		for _, part := range strings.Split(subtitle, " • ") {
			if part != "Song" && part != "Video" {
				artist = part
				break
			}
		}
		return &Item{Kind: "song", ID: video, Title: title, Artist: artist, Thumbnail: thumbnail(get(card, "thumbnailRenderer"))}
	}
	id, kind := browseTarget(get(card, "navigationEndpoint"))
	if id == "" || title == "" {
		return nil
	}
	return &Item{Kind: kind, ID: id, Title: title, Subtitle: subtitle, Thumbnail: thumbnail(get(card, "thumbnailRenderer"))}
}

func shelfItems(contents any) []*Item {
	list, _ := contents.([]any)
	var items []*Item
	for _, entry := range list {
		var item *Item
		if r := get(entry, "musicTwoRowItemRenderer"); r != nil {
			item = twoRowItem(r)
		} else if r := get(entry, "musicResponsiveListItemRenderer"); r != nil {
			item = listItem(r, nil)
		}
		if item != nil {
			items = append(items, item)
		}
	}
	return items
}

func continuationOf(v any) string {
	if t := gstr(first(v, "continuationCommand"), "token"); t != "" {
		return t
	}
	return gstr(first(v, "nextContinuationData"), "continuation")
}

func Home(ctx context.Context, onProgress func([]*Shelf)) ([]*Shelf, error) {
	var shelves []*Shelf
	data, err := call(ctx, "browse", map[string]any{"browseId": "FEmusic_home"}, "")
	if err != nil {
		return nil, err
	}
	for page := 0; page < 4; page++ {
		for _, shelf := range findAll(data, "musicCarouselShelfRenderer", nil) {
			items := shelfItems(get(shelf, "contents"))
			title := plain(first(get(shelf, "header"), "title"))
			if title != "" && len(items) > 0 {
				shelves = append(shelves, &Shelf{Title: title, Items: items})
			}
		}
		if onProgress != nil {
			onProgress(append([]*Shelf(nil), shelves...))
		}
		token := continuationOf(data)
		if token == "" || page == 3 {
			break
		}
		if data, err = call(ctx, "browse", map[string]any{}, "&ctoken="+token+"&continuation="+token+"&type=next"); err != nil {
			return nil, err
		}
	}
	return shelves, nil
}

func Search(query string) ([]*Item, error) {
	data, err := call(nil, "search", map[string]any{"query": query, "params": "EgWKAQIIAWoKEAkQBRAKEAMQBA%3D%3D"}, "")
	if err != nil {
		return nil, err
	}
	songs := []*Item{}
	for _, row := range findAll(data, "musicResponsiveListItemRenderer", nil) {
		if s := listItem(row, nil); s != nil {
			songs = append(songs, s)
		}
	}
	return songs, nil
}

func orFirst(v any, keys ...string) any {
	for _, k := range keys {
		if f := first(v, k); f != nil {
			return f
		}
	}
	return nil
}

func CollectionOf(ctx context.Context, entry *Item, onProgress func(*Opened)) (*Opened, error) {
	data, err := call(ctx, "browse", map[string]any{"browseId": entry.ID}, "")
	if err != nil {
		return nil, err
	}
	head := orFirst(data, "musicResponsiveHeaderRenderer", "musicImmersiveHeaderRenderer", "musicVisualHeaderRenderer", "musicDetailHeaderRenderer")
	header := &Item{Kind: entry.Kind, ID: entry.ID, Title: plain(get(head, "title"))}
	if header.Title == "" {
		header.Title = entry.Title
	}
	var subtitleParts []string
	for _, s := range []string{plain(get(head, "straplineTextOne")), plain(get(head, "subtitle"))} {
		if s != "" {
			subtitleParts = append(subtitleParts, s)
		}
	}
	header.Subtitle = strings.Join(subtitleParts, " • ")
	if header.Subtitle == "" {
		header.Subtitle = entry.Subtitle
	}
	thumbSource := get(head, "thumbnail")
	if thumbSource == nil {
		thumbSource = get(head, "foregroundThumbnail")
	}
	header.Thumbnail = thumbnail(thumbSource)
	if header.Thumbnail == nil {
		header.Thumbnail = entry.Thumbnail
	}
	var albumContext *Item
	if entry.Kind == "album" {
		c := *header
		c.Subtitle = "Album • " + plain(get(head, "straplineTextOne"))
		albumContext = &c
	}
	songs := []*Item{}
	seen := map[string]bool{}
	take := func(node any) {
		for _, row := range findAll(node, "musicResponsiveListItemRenderer", nil) {
			if s := listItem(row, albumContext); s != nil && !seen[s.ID] {
				seen[s.ID] = true
				songs = append(songs, s)
			}
		}
	}
	if entry.Kind == "artist" {
		all := findAll(data, "musicShelfRenderer", nil)
		if len(all) > 1 {
			all = all[:1]
		}
		take(all)
	} else {
		take(first(data, "contents"))
	}
	if onProgress != nil {
		onProgress(&Opened{Header: header, Songs: append([]*Item(nil), songs...)})
	}
	for page := 0; page < 10 && entry.Kind == "playlist"; page++ {
		source := first(data, "musicPlaylistShelfRenderer")
		if source == nil {
			source = get(data, "continuationContents")
		}
		if source == nil {
			source = get(data, "onResponseReceivedActions")
		}
		token := continuationOf(source)
		if token == "" {
			break
		}
		if data, err = call(ctx, "browse", map[string]any{"continuation": token}, ""); err != nil {
			return nil, err
		}
		if a := get(data, "onResponseReceivedActions"); a != nil {
			take(a)
		} else {
			take(get(data, "continuationContents"))
		}
		if onProgress != nil {
			onProgress(&Opened{Header: header, Songs: append([]*Item(nil), songs...)})
		}
	}
	return &Opened{Header: header, Songs: songs}, nil
}

func panelItem(row any) *Item {
	id, title := gstr(row, "videoId"), plain(get(row, "title"))
	if id == "" || title == "" {
		return nil
	}
	byline := get(row, "longBylineText")
	if byline == nil {
		byline = get(row, "shortBylineText")
	}
	var artists []string
	albumText := ""
	for _, run := range runsOf(byline) {
		_, kind := browseTarget(run)
		if kind == "artist" {
			artists = append(artists, gstr(run, "text"))
		} else if kind == "album" && albumText == "" {
			albumText = gstr(run, "text")
		}
	}
	artist := strings.Join(artists, ", ")
	if artist == "" {
		artist = plain(get(row, "shortBylineText"))
	}
	return &Item{Kind: "song", ID: id, Title: title, Artist: artist, Album: albumText, Duration: seconds(plain(get(row, "lengthText"))), Thumbnail: thumbnail(get(row, "thumbnail"))}
}

// Radio is what YouTube Music plays after a song: songs like it, the song itself first.
func Radio(id string) ([]*Item, error) {
	data, err := call(nil, "next", map[string]any{"videoId": id, "playlistId": "RDAMVM" + id, "isAudioOnly": true, "enablePersistentPlaylistPanel": true, "tunerSettingValue": "AUTOMIX_SETTING_NORMAL"}, "")
	if err != nil {
		return nil, err
	}
	seen := map[string]bool{}
	var songs []*Item
	for _, row := range findAll(data, "playlistPanelVideoRenderer", nil) {
		if s := panelItem(row); s != nil && !seen[s.ID] {
			seen[s.ID] = true
			songs = append(songs, s)
		}
	}
	return songs, nil
}

// Library is the signed-in user's playlists, liked music first.
func Library() ([]*Item, error) {
	if !SignedIn() {
		return []*Item{}, nil
	}
	data, err := call(nil, "browse", map[string]any{"browseId": "FEmusic_liked_playlists"}, "")
	if err != nil {
		return nil, err
	}
	list := []*Item{{Kind: "playlist", ID: "VLLM", Title: "Liked music", Subtitle: "Auto playlist"}}
	seen := map[string]bool{}
	for _, card := range findAll(data, "musicTwoRowItemRenderer", nil) {
		if it := twoRowItem(card); it != nil && it.Kind != "song" && it.ID != "VLLM" && !seen[it.ID] {
			seen[it.ID] = true
			list = append(list, it)
		}
	}
	return list, nil
}

var sourcePrefix = regexp.MustCompile(`(?i)^Source:\s*`)

// SongLyrics is the plain-text lyrics YouTube Music shows for a song, or "" when it has none.
func SongLyrics(ctx context.Context, id string) (text, source string, err error) {
	next, err := call(ctx, "next", map[string]any{"videoId": id}, "")
	if err != nil {
		return "", "", err
	}
	browseID := ""
	for _, v := range findAll(next, "browseId", nil) {
		if s, ok := v.(string); ok && strings.HasPrefix(s, "MPLY") {
			browseID = s
			break
		}
	}
	if browseID == "" {
		return "", "", nil
	}
	page, err := call(ctx, "browse", map[string]any{"browseId": browseID}, "")
	if err != nil {
		return "", "", err
	}
	shelf := first(page, "musicDescriptionShelfRenderer")
	text = strings.TrimSpace(plain(get(shelf, "description")))
	if text == "" {
		return "", "", nil
	}
	source = sourcePrefix.ReplaceAllString(plain(get(shelf, "footer")), "")
	if source == "" {
		source = "YouTube Music"
	}
	return text, source, nil
}

// ---- audio ----

type playerClient struct {
	name, id string
	context  map[string]any
}

const (
	visionUA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 15_7_3) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.0 Safari/605.1.15"
	vrUA     = "com.google.android.apps.youtube.vr.oculus/1.65.10 (Linux; U; Android 12L; eureka-user Build/SQ3A.220605.009.A1) gzip"
	botCheck = "YouTube is blocking this network as a bot (VPN or proxy on?)"
)

var clients = []playerClient{
	{"visionOS", "101", map[string]any{"clientName": "VISIONOS", "clientVersion": "1.02", "userAgent": visionUA, "hl": "en", "gl": "US", "utcOffsetMinutes": 0, "deviceMake": "Apple", "deviceModel": "RealityDevice17,1", "osName": "visionOS", "osVersion": "26.5.23O471"}},
	{"Android VR", "28", map[string]any{"clientName": "ANDROID_VR", "clientVersion": "1.65.10", "userAgent": vrUA, "hl": "en", "gl": "US", "utcOffsetMinutes": 0, "deviceMake": "Oculus", "deviceModel": "Quest 3", "androidSdkVersion": 32, "osName": "Android", "osVersion": "12L"}},
}

const visitorTTL = 30 * time.Minute

type visitorEntry struct {
	done chan struct{}
	id   string
	err  error
	at   time.Time
}

var (
	visitorMu sync.Mutex
	visitor   *visitorEntry
)

func visitorData(fresh bool) (string, error) {
	visitorMu.Lock()
	e := visitor
	if fresh || e == nil || time.Since(e.at) > visitorTTL {
		e = &visitorEntry{done: make(chan struct{}), at: time.Now()}
		visitor = e
		go func() {
			data, err := call(nil, "browse", map[string]any{"browseId": "FEmusic_home"}, "")
			e.id, e.err = gstr(data, "responseContext", "visitorData"), err
			if err != nil {
				visitorMu.Lock()
				if visitor == e {
					visitor = nil
				}
				visitorMu.Unlock()
			}
			close(e.done)
		}()
	}
	visitorMu.Unlock()
	<-e.done
	return e.id, e.err
}

// WarmUp starts the visitor-id request early, so the first play waits only for its own URL.
func WarmUp() { go visitorData(false) }

type resolved struct {
	done        chan struct{}
	url         string
	usableUntil time.Time
	err         error
}

const (
	maxResolved  = 64
	expiryMargin = 10 * time.Minute
)

var (
	resolvedMu    sync.Mutex
	resolvedJobs  = map[string]*resolved{}
	resolvedOrder []string
)

func touch(id string) {
	for i, k := range resolvedOrder {
		if k == id {
			resolvedOrder = append(resolvedOrder[:i], resolvedOrder[i+1:]...)
			break
		}
	}
	resolvedOrder = append(resolvedOrder, id)
}

// ForgetStreamURL drops a song's cached URL, e.g. after the CDN refused it.
func ForgetStreamURL(id string) {
	resolvedMu.Lock()
	delete(resolvedJobs, id)
	resolvedMu.Unlock()
}

func forget(id string, job *resolved) {
	resolvedMu.Lock()
	if resolvedJobs[id] == job {
		delete(resolvedJobs, id)
	}
	resolvedMu.Unlock()
}

// StreamURL is a direct, range-requestable AAC (M4A) URL for a song, cached until shortly before it expires.
// It blocks: call it from a goroutine.
func StreamURL(id string) (string, error) {
	resolvedMu.Lock()
	if job := resolvedJobs[id]; job != nil {
		touch(id)
		resolvedMu.Unlock()
		<-job.done
		if job.err != nil {
			return "", job.err
		}
		if time.Now().Before(job.usableUntil) {
			return job.url, nil
		}
		forget(id, job)
		return StreamURL(id)
	}
	job := &resolved{done: make(chan struct{})}
	resolvedJobs[id] = job
	touch(id)
	for len(resolvedJobs) > maxResolved && len(resolvedOrder) > 0 {
		delete(resolvedJobs, resolvedOrder[0])
		resolvedOrder = resolvedOrder[1:]
	}
	resolvedMu.Unlock()
	job.url, job.usableUntil, job.err = func() (string, time.Time, error) {
		v, err := visitorData(false)
		if err == nil {
			if u, until, err2 := resolve(id, clients[0], v); err2 == nil {
				return u, until, nil
			} else {
				err = err2
			}
		}
		fresh, ferr := visitorData(true)
		if ferr != nil {
			return "", time.Time{}, err
		}
		if u, until, err2 := resolve(id, clients[0], fresh); err2 == nil {
			return u, until, nil
		}
		if u, until, err2 := resolve(id, clients[1], fresh); err2 == nil {
			return u, until, nil
		}
		return "", time.Time{}, err
	}()
	close(job.done)
	if job.err != nil {
		forget(id, job)
		return "", job.err
	}
	return job.url, nil
}

func resolve(id string, client playerClient, visitorID string) (string, time.Time, error) {
	ctxClient := map[string]any{"visitorData": visitorID}
	for k, v := range client.context {
		ctxClient[k] = v
	}
	body, _ := json.Marshal(map[string]any{"context": map[string]any{"client": ctxClient}, "videoId": id, "contentCheckOk": true, "racyCheckOk": true})
	req, _ := http.NewRequest("POST", "https://www.youtube.com/youtubei/v1/player?prettyPrint=false", bytes.NewReader(body))
	req.Header.Set("content-type", "application/json")
	req.Header.Set("user-agent", client.context["userAgent"].(string))
	req.Header.Set("x-youtube-client-name", client.id)
	req.Header.Set("x-youtube-client-version", client.context["clientVersion"].(string))
	req.Header.Set("x-goog-visitor-id", visitorID)
	res, err := httpClient.Do(req)
	if err != nil {
		return "", time.Time{}, err
	}
	raw, err := io.ReadAll(res.Body)
	res.Body.Close()
	if err != nil {
		return "", time.Time{}, err
	}
	if res.StatusCode < 200 || res.StatusCode > 299 {
		return "", time.Time{}, fmt.Errorf("YouTube player answered HTTP %d", res.StatusCode)
	}
	data, err := decodeOrdered(raw)
	if err != nil {
		return "", time.Time{}, err
	}
	status := get(data, "playabilityStatus")
	if gstr(status, "status") == "LOGIN_REQUIRED" && strings.Contains(strings.ToLower(gstr(status, "reason")), "bot") {
		return "", time.Time{}, errors.New(botCheck)
	}
	if s := gstr(status, "status"); s != "OK" {
		if reason := gstr(status, "reason"); reason != "" {
			return "", time.Time{}, errors.New(reason)
		}
		if s == "" {
			s = "no status"
		}
		return "", time.Time{}, fmt.Errorf("not playable (%s)", s)
	}
	formats, _ := get(data, "streamingData", "adaptiveFormats").([]any)
	var audio []any
	for _, f := range formats {
		if gstr(f, "url") != "" && strings.HasPrefix(gstr(f, "mimeType"), "audio/mp4") {
			audio = append(audio, f)
		}
	}
	var format any
	for _, itag := range []float64{141, 140} {
		for _, f := range audio {
			if get(f, "itag") == itag {
				format = f
				break
			}
		}
		if format != nil {
			break
		}
	}
	if format == nil {
		best := -1.0
		for _, f := range audio {
			b, _ := get(f, "bitrate").(float64)
			if b > best {
				best, format = b, f
			}
		}
	}
	if format == nil {
		return "", time.Time{}, errors.New("no AAC audio for this song")
	}
	link := gstr(format, "url")
	length, _ := strconv.ParseFloat(gstr(format, "contentLength"), 64)
	if err := ServesWholeFile(link, length, client.name); err != nil {
		return "", time.Time{}, err
	}
	lifetime := time.Hour
	if u, err := url.Parse(link); err == nil {
		if expire, err := strconv.ParseFloat(u.Query().Get("expire"), 64); err == nil && expire > 0 {
			lifetime = time.Until(time.Unix(int64(expire), 0))
		}
	}
	margin := time.Duration(math.Min(float64(expiryMargin), float64(lifetime/10)))
	return link, time.Now().Add(lifetime - margin), nil
}

// ServesWholeFile asks for the file's last byte: a URL gated to a preview fails here, not a minute into the song.
func ServesWholeFile(link string, length float64, client string) error {
	if length <= 0 || math.IsNaN(length) {
		return nil
	}
	ctx, cancel := context.WithTimeout(context.Background(), 8*time.Second)
	defer cancel()
	req, _ := http.NewRequestWithContext(ctx, "GET", link, nil)
	req.Header.Set("range", fmt.Sprintf("bytes=%d-", int64(length)-1))
	res, err := httpClient.Do(req)
	if err != nil {
		return err
	}
	res.Body.Close()
	if res.StatusCode != 206 {
		return fmt.Errorf("the %s stream serves only part of this song (HTTP %d)", client, res.StatusCode)
	}
	return nil
}
