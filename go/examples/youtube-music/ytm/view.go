// Package ytm is the YouTube Music example (examples/youtube-music) on the Go host, node for node.
package ytm

import (
	"fmt"
	"math"
	"math/rand"
	"regexp"
	"strings"

	. "github.com/omarcosr/tarve/go/tarve"
)

const AudioID = "ytm-audio"

// Item is a song (Kind "song") or a playlist, album or artist.
type Item struct {
	Kind      string   `json:"kind"`
	ID        string   `json:"id"`
	Title     string   `json:"title"`
	Artist    string   `json:"artist,omitempty"`
	Album     string   `json:"album,omitempty"`
	Subtitle  string   `json:"subtitle,omitempty"`
	Duration  *float64 `json:"duration"`
	Thumbnail *string  `json:"thumbnail"`
}

type Shelf struct {
	Title string  `json:"title"`
	Items []*Item `json:"items"`
}

type Opened struct {
	Header *Item   `json:"header"`
	Songs  []*Item `json:"songs"`
}

type Page struct {
	Kind  string `json:"kind"`
	Query string `json:"query,omitempty"`
	Entry *Item  `json:"entry,omitempty"`
}

type LyricLine struct {
	Time float64 `json:"time"`
	Text string  `json:"text"`
}

type Lyrics struct {
	Lines  []LyricLine `json:"lines"`
	Plain  *string     `json:"plain"`
	Source string      `json:"source"`
}

type LyricsEntry struct {
	ID     string  `json:"id"`
	Status string  `json:"status"`
	Data   *Lyrics `json:"data,omitempty"`
	Error  *string `json:"error,omitempty"`
}

// State is the app state the view reads; actions.go wires the functions.
type State struct {
	Page          *Page        `json:"page"`
	Back          []*Page      `json:"back"`
	Shelves       []*Shelf     `json:"shelves"`
	Results       []*Item      `json:"results"`
	Opened        *Opened      `json:"opened"`
	Library       []*Item      `json:"library"`
	Query         string       `json:"query"`
	ListOffset    float64      `json:"listOffset"`
	PageError     *string      `json:"pageError"`
	SignedIn      bool         `json:"signedIn"`
	SignIn        string       `json:"signIn"`
	SignInError   *string      `json:"signInError"`
	PastedCookies string       `json:"pastedCookies"`
	Queue         []*Item      `json:"queue"`
	Index         int          `json:"index"`
	Source        string       `json:"source"`
	ShowQueue     bool         `json:"showQueue"`
	Path          string       `json:"path,omitempty"`
	Loading       *float64     `json:"loading"`
	PlayError     *string      `json:"playError"`
	ResumeAt      float64      `json:"resumeAt"`
	Playing       bool         `json:"playing"`
	Time          float64      `json:"time"`
	Duration      float64      `json:"duration"`
	Volume        float64      `json:"volume"`
	Muted         bool         `json:"muted"`
	Shuffle       bool         `json:"shuffle"`
	Repeat        string       `json:"repeat"`
	Lyrics        *LyricsEntry `json:"lyrics"`
	LyricsOffset  float64      `json:"lyricsOffset"`
	AccountOpen   bool         `json:"accountOpen"`
	Stage         *Size        `json:"stage"`
	// Shelves loaded (nil and empty differ: nil is "loading").
	ShelvesLoaded, ResultsLoaded, LibraryLoaded bool `json:"-"`

	Media                                                  func() *MediaController                       `json:"-"`
	Open                                                   func(*Page)                                   `json:"-"`
	GoBack                                                 func()                                        `json:"-"`
	Play                                                   func(queue []*Item, index int, source string) `json:"-"`
	Jump                                                   func(int)                                     `json:"-"`
	Next, Previous                                         func()                                        `json:"-"`
	ToggleShuffle                                          func()                                        `json:"-"`
	SignInWithBrowser, SavePastedCookies, SignOut, Refresh func()                                        `json:"-"`
	MediaFailed                                            func(string)                                  `json:"-"`
	Played                                                 func()                                        `json:"-"`
	LyricsScrolled                                         func(offset float64, info ScrollInfo)         `json:"-"`
	FollowLyrics                                           func()                                        `json:"-"`
	Hide                                                   func()                                        `json:"-"`
}

func NewState() *State {
	s := &State{Page: &Page{Kind: "home"}, Index: -1, SignIn: "closed", Volume: 0.8, Repeat: "off"}
	noop := func() {}
	s.Media = func() *MediaController { return nil }
	s.Open, s.GoBack, s.Play, s.Jump = func(*Page) {}, noop, func([]*Item, int, string) {}, func(int) {}
	s.Next, s.Previous, s.ToggleShuffle = noop, noop, noop
	s.SignInWithBrowser, s.SavePastedCookies, s.SignOut, s.Refresh = noop, noop, noop, noop
	s.MediaFailed, s.Played = func(string) {}, noop
	s.LyricsScrolled, s.FollowLyrics, s.Hide = func(float64, ScrollInfo) {}, noop, noop
	return s
}

var state = NewState()

// St is the state the view renders.
func St() *State { return state }

// SetState replaces the state (tests).
func SetState(s *State) { state = s }

func (s *State) current() *Item {
	if s.Index >= 0 && s.Index < len(s.Queue) {
		return s.Queue[s.Index]
	}
	return nil
}

func (s *State) media(fn func(MediaController)) {
	if m := s.Media(); m != nil {
		fn(*m)
	}
}

var c = struct{ window, panel, raised, row, hover, border, text, muted, accent, accentInk, selected, liked string }{
	"#030303", "#0f0f0f", "#212121", "#181818", "#ffffff12", "#ffffff14", "#f1f1f1", "#aaaaaa", "#ff0033", "#ffffff", "#2b2b2b", "#7a1426",
}

var ellipsis = S{"whiteSpace": "nowrap", "textOverflow": "ellipsis", "overflow": "hidden"}

func with(base S, extra S) S {
	out := S{}
	for k, v := range base {
		out[k] = v
	}
	for k, v := range extra {
		out[k] = v
	}
	return out
}

var ytmTheme = CreateTheme(DarkTheme, ThemeOverrides{Colors: map[string]string{
	"background": c.window, "card": c.panel, "foreground": c.text, "muted": c.selected, "mutedForeground": c.muted,
	"border": "#272727", "input": c.raised, "placeholder": "#8a8a8a", "selection": "#ff00334d",
	"ring": "#ffffff59", "ringSoft": "#ffffff33", "primary": c.accent, "primaryForeground": c.accentInk, "sliderThumb": c.text, "overlay": "#000000a8",
}})

func pad2(n int) string { return fmt.Sprintf("%02d", n) }

func clock(seconds *float64) string {
	if seconds == nil || math.IsInf(*seconds, 0) || math.IsNaN(*seconds) {
		return "-:--"
	}
	s := int(math.Max(0, math.Floor(*seconds)))
	h, m := s/3600, (s/60)%60
	head := fmt.Sprint(m)
	if h != 0 {
		head = fmt.Sprintf("%d:%s", h, pad2(m))
	}
	return head + ":" + pad2(s%60)
}

func ptr(f float64) *float64 { return &f }

var icons = struct{ play, pause, next, prev, shuffle, repeat, home, search, library, heart, volume, mute, queue, back, note, user, bars string }{
	play:    "M7 4.8v14.4a1 1 0 0 0 1.5.86l11.9-7.2a1 1 0 0 0 0-1.72L8.5 3.94A1 1 0 0 0 7 4.8z",
	pause:   "M7 4h3.5v16H7zM13.5 4H17v16h-3.5z",
	next:    "M6 5v14l9.5-7zM17 5h2v14h-2z",
	prev:    "M18 5v14L8.5 12zM5 5h2v14H5z",
	shuffle: "M16 3h5v5M4 20 21 3M21 16v5h-5M15 15l6 6M4 4l5 5",
	repeat:  "M17 2l4 4-4 4M3 11V9a3 3 0 0 1 3-3h15M7 22l-4-4 4-4M21 13v2a3 3 0 0 1-3 3H3",
	home:    "M3 10.5 12 3l9 7.5V20a1 1 0 0 1-1 1h-5v-6H9v6H4a1 1 0 0 1-1-1z",
	search:  "M11 18a7 7 0 1 0 0-14 7 7 0 0 0 0 14zM20 20l-4-4",
	library: "M5 3v18M10 3v18M15 4l5 16",
	heart:   "M20.8 4.6a5.5 5.5 0 0 0-7.8 0L12 5.7l-1-1.1a5.5 5.5 0 0 0-7.8 7.8L12 21l8.8-8.6a5.5 5.5 0 0 0 0-7.8z",
	volume:  "M11 5 6 9H2v6h4l5 4zM15.5 8.5a5 5 0 0 1 0 7M19 5a10 10 0 0 1 0 14",
	mute:    "M11 5 6 9H2v6h4l5 4zM22 9l-6 6M16 9l6 6",
	queue:   "M3 6h13M3 12h13M3 18h9M17 15v6l5-3z",
	back:    "M15 18l-6-6 6-6",
	note:    "M9 18V5l12-2v13M9 18a3 3 0 1 1-6 0 3 3 0 0 1 6 0zM21 16a3 3 0 1 1-6 0 3 3 0 0 1 6 0z",
	user:    "M12 12a4 4 0 1 0 0-8 4 4 0 0 0 0 8zM4 21a8 8 0 0 1 16 0",
	bars:    "M5 20V10M10 20V4M15 20v-8M20 20V7",
}

type glyph struct {
	d      string
	size   float64
	color  string
	fill   bool
	weight float64
}

func Glyph(g glyph) *VNode {
	if g.size == 0 {
		g.size = 18
	}
	if g.color == "" {
		g.color = c.text
	}
	if g.weight == 0 {
		g.weight = 2
	}
	fill, stroke := "none", g.color
	if g.fill {
		fill, stroke = g.color, "none"
	}
	return Svg(Props{"size": g.size, "viewBox": "0 0 24 24", "color": g.color, "fill": fill, "stroke": stroke, "strokeWidth": g.weight,
		"strokeLinecap": "round", "strokeLinejoin": "round"}, Path(g.d))
}

func Tip(id, label, side string, child Child) *VNode {
	if side == "" {
		side = "top"
	}
	return Tooltip(Props{"id": id + "-tip", "side": side, "label": label, "trigger": child,
		"content":      Text(Props{"size": 12, "color": c.text, "style": S{"whiteSpace": "nowrap"}}, label),
		"contentStyle": S{"background": "#333333", "borderColor": "#333333", "radius": 6}})
}

type iconButton struct {
	id, d, label           string
	onClick                func()
	size                   float64
	fill, active, disabled bool
	box                    float64
	tip                    string
}

func IconButton(b iconButton) *VNode {
	if b.size == 0 {
		b.size = 18
	}
	if b.box == 0 {
		b.box = 32
	}
	click := b.onClick
	if b.disabled {
		click = func() {}
	}
	cursor, opacity := "pointer", 1.0
	if b.disabled {
		cursor, opacity = "default", 0.35
	}
	bg, hover, color := "transparent", c.hover, c.text
	if b.active {
		bg, hover, color = c.selected, c.selected, c.accent
	}
	return Tip(b.id, b.label, b.tip, Pressable(Props{"id": b.id, "onClick": click, "control": S{"role": "button", "label": b.label},
		"style": S{"width": b.box, "height": b.box, "align": "center", "justify": "center", "radius": 8, "shrink": 0, "cursor": cursor, "opacity": opacity,
			"background": bg, "hover": S{"background": hover}}},
		Glyph(glyph{d: b.d, size: b.size, fill: b.fill, color: color})))
}

var (
	coverWH = regexp.MustCompile(`=w\d+-h\d+`)
	coverS  = regexp.MustCompile(`=s\d+`)
)

func replaceFirst(re *regexp.Regexp, s, with string) string {
	loc := re.FindStringIndex(s)
	if loc == nil {
		return s
	}
	return s[:loc[0]] + with + s[loc[1]:]
}

func cover(url string, size float64) string {
	px := int(math.Min(544, math.Ceil(size*1.5/30)*30))
	url = replaceFirst(coverWH, url, fmt.Sprintf("=w%d-h%d", px, px))
	return replaceFirst(coverS, url, fmt.Sprintf("=s%d", px))
}

func Art(url *string, size, radius float64, round bool) *VNode {
	r := radius
	if round {
		r = size / 2
	}
	shape := S{"width": size, "height": size, "shrink": 0, "radius": r, "overflow": "hidden", "background": c.raised, "placeholderBackground": c.raised}
	if url != nil && *url != "" {
		return Image(Props{"src": cover(*url, size), "width": size, "height": size, "fit": "cover", "style": shape})
	}
	return View(Props{"style": with(shape, S{"align": "center", "justify": "center"})}, Glyph(glyph{d: icons.note, size: math.Max(12, size/3), color: c.muted}))
}

func NavItem(id, d, label string, active bool, onClick func()) *VNode {
	bg, hover, gcolor, tcolor, weight := "transparent", c.hover, c.muted, "#c3cfd1", 400
	if active {
		bg, hover, gcolor, tcolor, weight = c.selected, c.selected, c.accent, c.text, 600
	}
	return Pressable(Props{"id": id, "onClick": onClick, "control": S{"role": "button", "label": label},
		"style": S{"height": 32, "padding": S{"left": 10, "right": 10}, "gap": 10, "direction": "row", "align": "center", "radius": 8, "cursor": "pointer",
			"background": bg, "hover": S{"background": hover}}},
		Glyph(glyph{d: d, size: 16, color: gcolor}),
		Text(Props{"size": 13, "color": tcolor, "weight": weight}, label))
}

func Sidebar() *VNode {
	page := state.Page
	current := state.current()
	var list Child
	if state.SignedIn {
		entries := []Child{}
		for j, entry := range state.Library {
			entry := entry
			open := page.Kind == "collection" && page.Entry != nil && page.Entry.ID == entry.ID
			playing := state.Playing && state.Source == entry.Title && current != nil
			var art Child
			if entry.ID == "VLLM" {
				art = View(Props{"style": S{"width": 36, "height": 36, "radius": 6, "background": c.liked, "align": "center", "justify": "center"}},
					Glyph(glyph{d: icons.heart, size: 16, fill: true, color: c.text}))
			} else {
				art = Art(entry.Thumbnail, 36, 6, false)
			}
			bg, hover, tc := "transparent", c.hover, c.text
			if open {
				bg, hover = c.selected, c.selected
			}
			if playing {
				tc = c.accent
			}
			entries = append(entries, Pressable(Props{"key": fmt.Sprintf("%d-%s", j, entry.ID), "id": fmt.Sprintf("side-%d", j),
				"onClick": func() { state.Open(&Page{Kind: "collection", Entry: entry}) }, "control": S{"role": "button", "label": entry.Title},
				"style": S{"padding": 6, "radius": 8, "gap": 10, "direction": "row", "align": "center", "cursor": "pointer", "background": bg, "hover": S{"background": hover}}},
				art,
				Column(Props{"gap": 1, "style": S{"flex": 1, "minWidth": 0}},
					Text(Props{"size": 13, "color": tc, "style": ellipsis}, entry.Title),
					Text(Props{"size": 11, "color": c.muted, "style": ellipsis}, entry.Subtitle))))
		}
		list = Scroll(Props{"flex": 1, "style": S{"minHeight": 0}}, Column(Props{"gap": 2}, entries))
	} else {
		list = Column(Props{"gap": 10, "style": S{"padding": S{"left": 10, "right": 10}}},
			Text(Props{"size": 12, "color": c.muted}, "Sign in to see your playlists and liked music."),
			Pressable(Props{"id": "side-sign-in", "onClick": func() { state.SignIn = "choose" }, "control": S{"role": "button", "label": "Sign in"},
				"style": S{"height": 30, "radius": 8, "background": c.accent, "align": "center", "justify": "center", "cursor": "pointer", "hover": S{"opacity": 0.9}}},
				Text(Props{"size": 13, "weight": 600, "color": c.accentInk}, "Sign in")))
	}
	return Column(Props{"justify": "start", "style": S{"width": 216, "shrink": 0, "padding": 8, "gap": 2, "background": c.panel, "borderColor": c.border, "borderWidth": S{"right": 1}, "minHeight": 0}},
		NavItem("nav-home", icons.home, "Home", page.Kind == "home", func() { state.Open(&Page{Kind: "home"}) }),
		NavItem("nav-search", icons.search, "Search", page.Kind == "search", func() { state.Open(&Page{Kind: "search", Query: state.Query}) }),
		NavItem("nav-library", icons.library, "Your Library", page.Kind == "library", func() { state.Open(&Page{Kind: "library"}) }),
		Text(Props{"size": 11, "weight": 700, "color": c.muted, "style": S{"padding": S{"left": 10, "top": 18, "bottom": 6}, "letterSpacing": 0.6}}, "PLAYLISTS"),
		list)
}

func TopBar() *VNode {
	queueLabel := "Show queue"
	if state.ShowQueue {
		queueLabel = "Hide queue"
	}
	var account Child
	if state.SignedIn {
		account = DropdownMenu(Props{"id": "account", "label": "Account", "open": state.AccountOpen, "onOpenChange": func(open bool) { state.AccountOpen = open },
			"items": []DropdownMenuItem{{Value: "sign-out", Label: "Sign out"}}, "onSelect": func(v string) {
				if v == "sign-out" {
					state.SignOut()
				}
			},
			"trigger": View(Props{"style": S{"width": 30, "height": 30, "radius": 15, "background": c.selected, "align": "center", "justify": "center", "hover": S{"background": "#3a3a3a"}}},
				Glyph(glyph{d: icons.user, size: 15, color: c.text})),
			"contentStyle": S{"left": nil, "right": 0, "minWidth": 160, "background": c.raised, "borderColor": c.border}})
	} else {
		account = Pressable(Props{"id": "account", "onClick": func() { state.SignIn = "choose" }, "control": S{"role": "button", "label": "Sign in"},
			"style": S{"height": 30, "padding": S{"left": 10, "right": 12}, "gap": 6, "direction": "row", "align": "center", "radius": 15, "cursor": "pointer", "background": c.raised, "hover": S{"background": c.selected}}},
			Glyph(glyph{d: icons.user, size: 14, color: c.muted}),
			Text(Props{"size": 12, "color": c.text}, "Sign in"))
	}
	return TitleBar(Props{"id": "titlebar", "height": 44, "style": S{"background": c.panel, "foreground": c.text, "borderColor": c.border, "padding": S{"left": 8}}},
		Row(Props{"align": "center", "style": S{"flex": 1, "minWidth": 0, "height": "100%", "padding": S{"right": 8}, "gap": 8}},
			Row(Props{"gap": 8, "align": "center", "style": S{"width": 200, "shrink": 0, "padding": S{"left": 6}}},
				View(Props{"style": S{"width": 24, "height": 24, "radius": 12, "background": c.accent, "align": "center", "justify": "center"}}, Glyph(glyph{d: icons.play, size: 12, fill: true, color: c.accentInk})),
				Text(Props{"size": 15, "weight": 700}, "Music")),
			IconButton(iconButton{id: "back", d: icons.back, label: "Back", tip: "bottom", onClick: func() { state.GoBack() }, disabled: len(state.Back) == 0}),
			View(Props{"style": S{"width": 380, "height": 34, "shrink": 1, "minWidth": 160, "position": "relative"}},
				Input(Props{"id": "search", "type": "search", "placeholder": "Search songs, albums, artists", "value": state.Query,
					"onChange": func(v string) { state.Query = v },
					"onSubmit": func(v string) {
						if q := strings.TrimSpace(v); q != "" {
							state.Open(&Page{Kind: "search", Query: q})
						}
					},
					"style": S{"width": "100%", "height": 34, "minWidth": 0, "radius": 17, "background": c.raised, "borderColor": c.raised, "foreground": c.text, "caretColor": c.text,
						"fontSize": 13, "padding": S{"left": 36, "right": 14},
						"hover": S{"background": "#2a2a2a", "borderColor": "#2a2a2a"},
						"focus": S{"background": "#1a1a1a", "borderColor": "#ffffff40", "outlineWidth": 0}}}),
				View(Props{"style": S{"position": "absolute", "left": 12, "top": 10, "pointerEvents": "auto"}}, Glyph(glyph{d: icons.search, size: 14, color: c.muted}))),
			View(Props{"flex": 1}),
			IconButton(iconButton{id: "toggle-queue", d: icons.queue, label: queueLabel, tip: "bottom", active: state.ShowQueue, onClick: func() { state.ShowQueue = !state.ShowQueue }}),
			account))
}

func songsOf(items []*Item) []*Item {
	out := []*Item{}
	for _, it := range items {
		if it.Kind == "song" {
			out = append(out, it)
		}
	}
	return out
}

func shufflePlay(songs []*Item, from string) {
	if len(songs) == 0 {
		return
	}
	first := rand.Intn(len(songs))
	state.Shuffle = false
	queue := []*Item{songs[first]}
	for i, s := range songs {
		if i != first {
			queue = append(queue, s)
		}
	}
	state.Play(queue, 0, from)
	state.ToggleShuffle()
}

func openItem(item *Item, shelf *Shelf) {
	if item.Kind == "song" {
		songs := songsOf(shelf.Items)
		index := -1
		for i, s := range songs {
			if s == item {
				index = i
			}
		}
		state.Play(songs, index, shelf.Title)
	} else {
		state.Open(&Page{Kind: "collection", Entry: item})
	}
}

var cardMemo = NewMemo(func(p Props) Child {
	item, shelf, slot := p["item"].(*Item), p["shelf"].(*Shelf), p["slot"].(string)
	subtitle := item.Subtitle
	if item.Kind == "song" {
		subtitle = item.Artist
	}
	return Pressable(Props{"id": "card-" + slot, "onClick": func() { openItem(item, shelf) }, "control": S{"role": "button", "label": item.Title},
		"style": S{"width": 168, "shrink": 0, "direction": "column", "gap": 8, "padding": 8, "radius": 10, "cursor": "pointer", "hover": S{"background": c.hover}}},
		Art(item.Thumbnail, 152, 8, item.Kind == "artist"),
		Column(Props{"gap": 2},
			Text(Props{"size": 13, "weight": 600, "style": ellipsis}, item.Title),
			Text(Props{"size": 12, "color": c.muted, "style": ellipsis}, subtitle)))
}, nil)

func ShelfCard(key, slot string, item *Item, shelf *Shelf) *VNode {
	return E(cardMemo, Props{"key": key, "item": item, "shelf": shelf, "slot": slot})
}

const rowHeight = 40

var pad = S{"left": 24, "right": 24, "top": 20, "bottom": 28}

var songRowMemo = NewMemo(func(p Props) Child {
	song, index, list, source := p["song"].(*Item), p["index"].(int), p["list"].([]*Item), p["source"].(string)
	isCurrent, playing := p["isCurrent"].(bool), p["playing"].(bool)
	bg, hover, tc := "transparent", c.hover, c.text
	if isCurrent {
		bg, hover, tc = c.selected, c.selected, c.accent
	}
	var mark Child
	if isCurrent {
		d := icons.note
		if playing {
			d = icons.bars
		}
		mark = Glyph(glyph{d: d, size: 14, color: c.accent})
	} else {
		mark = Text(Props{"size": 12, "color": c.muted}, index+1)
	}
	return Pressable(Props{"id": fmt.Sprintf("row-%d-%s", index, song.ID), "onClick": func() { state.Play(list, index, source) }, "control": S{"role": "button", "label": "Play " + song.Title},
		"style": S{"width": "100%", "height": rowHeight, "direction": "row", "align": "center", "gap": 16, "padding": S{"left": 12, "right": 16}, "radius": 6, "cursor": "pointer",
			"background": bg, "hover": S{"background": hover}}},
		View(Props{"style": S{"width": 24, "shrink": 0, "align": "center"}}, mark),
		Row(Props{"gap": 10, "align": "center", "style": S{"flex": 1, "minWidth": 0}},
			Art(song.Thumbnail, 28, 4, false),
			Text(Props{"size": 13, "color": tc, "style": with(ellipsis, S{"flex": 1, "minWidth": 0})}, song.Title)),
		Text(Props{"size": 13, "color": c.muted, "style": with(ellipsis, S{"width": "26%"})}, song.Artist),
		Text(Props{"size": 13, "color": c.muted, "style": with(ellipsis, S{"width": "22%"})}, song.Album),
		Text(Props{"size": 12, "color": c.muted, "style": S{"width": 52, "textAlign": "end", "shrink": 0}}, clock(song.Duration)))
}, nil)

func TrackTable(songs []*Item, source, list string) *VNode {
	current := ""
	if s := state.current(); s != nil {
		current = s.ID
	}
	return Column(Props{"flex": 1, "style": S{"minHeight": 0}},
		Row(Props{"align": "center", "gap": 16, "style": S{"height": 32, "shrink": 0, "padding": S{"left": 12, "right": 16}, "background": c.row, "radius": 6}},
			Text(Props{"size": 11, "color": c.muted, "style": S{"width": 24, "textAlign": "center", "shrink": 0}}, "#"),
			Text(Props{"size": 11, "color": c.muted, "style": S{"flex": 1}}, "TITLE"),
			Text(Props{"size": 11, "color": c.muted, "style": S{"width": "26%"}}, "ARTIST"),
			Text(Props{"size": 11, "color": c.muted, "style": S{"width": "22%"}}, "ALBUM"),
			Text(Props{"size": 11, "color": c.muted, "style": S{"width": 52, "textAlign": "end", "shrink": 0}}, "LENGTH")),
		VirtualList(Props{"id": list, "count": len(songs), "itemHeight": rowHeight, "overscan": 8, "offset": state.ListOffset,
			"keyForItem": func(i int) any { return fmt.Sprintf("%d-%s", i, songs[i].ID) },
			"onScroll":   func(offset float64) { state.ListOffset = offset },
			"renderItem": func(i int) Child {
				return E(songRowMemo, Props{"song": songs[i], "index": i, "list": songs, "source": source, "isCurrent": songs[i].ID == current, "playing": state.Playing})
			}}))
}

func Message(text string) *VNode {
	return Text(Props{"size": 14, "color": c.muted, "style": S{"padding": S{"top": 24, "left": 4}}}, text)
}

func PrimaryButton(id, label, d string, onClick func()) *VNode {
	return Pressable(Props{"id": id, "onClick": onClick, "control": S{"role": "button", "label": label},
		"style": S{"height": 32, "padding": S{"left": 12, "right": 14}, "gap": 6, "direction": "row", "align": "center", "radius": 8, "background": c.accent, "cursor": "pointer", "hover": S{"opacity": 0.88}}},
		Glyph(glyph{d: d, size: 14, fill: true, color: c.accentInk}),
		Text(Props{"size": 13, "weight": 600, "color": c.accentInk}, label))
}

func CollectionPage(entry *Item) *VNode {
	var opened *Opened
	if state.Opened != nil && state.Opened.Header.ID == entry.ID {
		opened = state.Opened
	}
	header := entry
	var songs []*Item
	if opened != nil {
		header, songs = opened.Header, opened.Songs
	}
	total := 0.0
	for _, s := range songs {
		if s.Duration != nil {
			total += *s.Duration
		}
	}
	playingHere := state.Source == header.Title && state.Playing
	thumb := header.Thumbnail
	if thumb == nil && len(songs) > 0 {
		thumb = songs[0].Thumbnail
	}
	parts := []string{}
	if header.Subtitle != "" {
		parts = append(parts, header.Subtitle)
	}
	if opened != nil {
		parts = append(parts, fmt.Sprintf("%d songs", len(songs)))
	}
	if total != 0 {
		parts = append(parts, clock(&total))
	}
	label, d := "Play", icons.play
	if playingHere {
		label, d = "Pause", icons.pause
	}
	var body Child
	switch {
	case opened == nil:
		body = Message("Loading…")
	case len(songs) == 0:
		body = Message("Nothing playable here.")
	default:
		body = TrackTable(songs, header.Title, "songs-"+entry.ID)
	}
	return Column(Props{"flex": 1, "gap": 20, "style": S{"minHeight": 0, "padding": with(pad, S{"bottom": 0})}},
		Row(Props{"gap": 20, "align": "end", "style": S{"shrink": 0}},
			Art(thumb, 148, 10, entry.Kind == "artist"),
			Column(Props{"gap": 6, "style": S{"minWidth": 0, "flex": 1}},
				Text(Props{"size": 11, "weight": 700, "color": c.muted, "style": S{"letterSpacing": 0.8}}, strings.ToUpper(entry.Kind)),
				Text(Props{"size": 30, "weight": 800, "style": ellipsis}, header.Title),
				Text(Props{"size": 12, "color": c.muted, "style": ellipsis}, strings.Join(parts, " • ")),
				Row(Props{"gap": 8, "style": S{"margin": S{"top": 8}}},
					PrimaryButton("play-all", label, d, func() {
						if playingHere {
							state.media(MediaController.Pause)
						} else if len(songs) > 0 {
							state.Play(songs, 0, header.Title)
						}
					}),
					IconButton(iconButton{id: "shuffle-all", d: icons.shuffle, label: "Shuffle play", onClick: func() {
						if opened != nil {
							shufflePlay(songs, header.Title)
						}
					}})))),
		body)
}

func Scrolling(id string, child Child, onSize func(Size)) *VNode {
	p := Props{"id": id, "flex": 1, "style": S{"minHeight": 0, "minWidth": 0}}
	if onSize != nil {
		p["onSize"] = onSize
	}
	return Scroll(p, Column(Props{"style": S{"padding": pad}}, child))
}

func NowPlaying(lyricLine int) *VNode {
	song := state.current()
	if song == nil {
		return Scrolling("main-playing", Message("Nothing playing. Pick a song to start."), nil)
	}
	stage := state.Stage
	side := LyricsShown()
	width, art := 520.0, 320.0
	if stage != nil {
		width = stage.Width
		if side {
			width = stage.Width * 0.46
		}
		art = math.Max(96, math.Min(420, math.Min(width-48, stage.Height-150)))
	}
	text := math.Min(520, math.Max(160, width-48))
	parts := []string{}
	for _, s := range []string{song.Artist, song.Album} {
		if s != "" {
			parts = append(parts, s)
		}
	}
	var from Child
	if state.Source != "" {
		from = Text(Props{"size": 12, "color": c.muted, "style": with(ellipsis, S{"maxWidth": text})}, "Playing from "+state.Source)
	}
	var lyrics Child
	if side {
		lyrics = LyricsPanel(song, lyricLine)
	}
	return Row(Props{"id": "main-playing", "flex": 1, "align": "stretch", "gap": 32, "style": S{"minHeight": 0, "minWidth": 0, "padding": pad, "overflow": "hidden"},
		"onSize": func(size Size) {
			if state.Stage == nil || size.Width != state.Stage.Width || size.Height != state.Stage.Height {
				state.Stage = &size
			}
		}},
		Column(Props{"flex": 1, "align": "center", "justify": "center", "gap": 18, "style": S{"minWidth": 0, "minHeight": 0}},
			Art(song.Thumbnail, math.Round(art), 10, false),
			Column(Props{"gap": 6, "align": "center", "style": S{"maxWidth": text, "minWidth": 0}},
				Text(Props{"size": 26, "weight": 800, "style": with(ellipsis, S{"maxWidth": text})}, song.Title),
				Text(Props{"size": 15, "color": c.muted, "style": with(ellipsis, S{"maxWidth": text})}, strings.Join(parts, " • ")),
				from)),
		lyrics)
}

const LyricsList = "lyrics-synced"
const lyricsMinWidth = 760

func LyricsShown() bool {
	return state.Page.Kind == "playing" && state.Stage != nil && state.Stage.Width >= lyricsMinWidth
}

var lineBreak = regexp.MustCompile(`\r?\n`)

func LyricsPanel(song *Item, line int) *VNode {
	var entry *LyricsEntry
	if state.Lyrics != nil && state.Lyrics.ID == song.ID {
		entry = state.Lyrics
	}
	note := func(label string) *VNode {
		return Column(Props{"flex": 1, "justify": "center", "style": S{"minWidth": 0}}, Text(Props{"size": 15, "color": c.muted}, label))
	}
	if entry == nil || entry.Status == "loading" {
		return note("Loading lyrics…")
	}
	if entry.Status == "none" {
		return note("No lyrics for this song.")
	}
	if entry.Status == "error" || entry.Data == nil {
		msg := "unknown error"
		if entry.Error != nil {
			msg = *entry.Error
		}
		return note("Lyrics unavailable: " + msg)
	}
	data := entry.Data
	credit := Text(Props{"size": 11, "color": c.muted, "style": S{"shrink": 0}}, "Lyrics from "+data.Source)
	if data.Lines == nil {
		plain := ""
		if data.Plain != nil {
			plain = *data.Plain
		}
		lines := []Child{}
		for i, text := range lineBreak.Split(plain, -1) {
			if strings.TrimSpace(text) != "" {
				lines = append(lines, Text(Props{"key": fmt.Sprintf("p%d", i), "size": 17, "color": c.text, "style": S{"lineHeight": 1.6}}, text))
			} else {
				lines = append(lines, View(Props{"key": fmt.Sprintf("p%d", i), "style": S{"height": 14}}))
			}
		}
		return Column(Props{"flex": 1, "gap": 10, "style": S{"minWidth": 0, "minHeight": 0}},
			Scroll(Props{"id": "lyrics-plain", "flex": 1, "style": S{"minHeight": 0}},
				Column(Props{"gap": 4, "style": S{"padding": S{"right": 12}}}, lines)),
			credit)
	}
	lines := data.Lines
	return Column(Props{"flex": 1, "gap": 10, "style": S{"minWidth": 0, "minHeight": 0}},
		VirtualList(Props{"id": LyricsList, "count": len(lines), "estimatedItemHeight": 40, "overscan": 12, "offset": state.LyricsOffset,
			"keyForItem": func(i int) any { return i },
			"onScroll":   func(offset, _ float64, info ScrollInfo) { state.LyricsScrolled(offset, info) },
			"renderItem": func(at int) Child {
				lyric := lines[at]
				current := at == line
				if lyric.Text == "" && !current {
					return View(Props{"style": S{"height": 16}})
				}
				label := lyric.Text
				if label == "" {
					label = "instrumental break"
				}
				opacity := 1.0
				if at < line {
					opacity = 0.45
				}
				size, weight, color := 19, 600, c.muted
				if current {
					size, weight, color = 24, 800, c.text
				}
				shown := lyric.Text
				if shown == "" {
					shown = "♪"
				}
				return Pressable(Props{"id": fmt.Sprintf("lyric-%d", at), "control": S{"role": "button", "label": "Go to “" + label + "”"},
					"onClick": func() {
						state.media(func(m MediaController) { m.Seek(lyric.Time) })
						state.Time = lyric.Time
						state.FollowLyrics()
						state.Refresh()
					},
					"style": S{"padding": S{"top": 6, "bottom": 6, "right": 12}, "cursor": "pointer", "opacity": opacity}},
					Text(Props{"size": size, "weight": weight, "color": color}, shown))
			}}),
		credit)
}

func Content(lyricLine int) *VNode {
	page := state.Page
	if page.Kind == "playing" {
		return NowPlaying(lyricLine)
	}
	if state.PageError != nil {
		return Scrolling("main-error", Message(*state.PageError), nil)
	}
	switch page.Kind {
	case "home":
		if state.Shelves == nil {
			return Scrolling("main-home", Message("Loading…"), nil)
		}
		return Scrolling("main-home", HomeShelves(), nil)
	case "search":
		if page.Query == "" {
			return Scrolling("main-search", Message("Type in the search box and press Enter."), nil)
		}
		var body Child
		switch {
		case state.Results == nil:
			body = Message("Searching…")
		case len(state.Results) == 0:
			body = Message("No songs found.")
		default:
			body = TrackTable(state.Results, "Search: "+page.Query, "songs-search-"+page.Query)
		}
		return Column(Props{"flex": 1, "gap": 16, "style": S{"minHeight": 0, "padding": with(pad, S{"bottom": 0})}},
			Text(Props{"size": 24, "weight": 800, "style": S{"shrink": 0}}, "Songs for “"+page.Query+"”"),
			body)
	case "library":
		if !state.SignedIn {
			return Scrolling("main-library", Message("Sign in to see your library."), nil)
		}
		if state.Library == nil {
			return Scrolling("main-library", Message("Loading…"), nil)
		}
		shelf := libraryShelf()
		cards := []Child{}
		for j, entry := range state.Library {
			cards = append(cards, ShelfCard(fmt.Sprintf("%d-%s", j, entry.ID), fmt.Sprintf("lib-%d", j), entry, shelf))
		}
		return Scrolling("main-library", Column(Props{"gap": 12},
			Text(Props{"size": 24, "weight": 800}, "Your Library"),
			Row(Props{"gap": 4, "style": S{"wrap": true}}, cards)), nil)
	}
	return CollectionPage(page.Entry)
}

var libShelf struct {
	items []*Item
	shelf *Shelf
}

// libraryShelf is a fresh object per render in the TypeScript view; one per library here.
func libraryShelf() *Shelf {
	if libShelf.shelf == nil || len(libShelf.items) != len(state.Library) || (len(state.Library) > 0 && &libShelf.items[0] != &state.Library[0]) {
		libShelf.items, libShelf.shelf = state.Library, &Shelf{Title: "Your Library", Items: state.Library}
	}
	return libShelf.shelf
}

var sidebarRegion = NewMemo(func(Props) Child { return Sidebar() }, nil)
var contentRegion = NewMemo(func(p Props) Child { return Content(p["lyricLine"].(int)) }, nil)
var queueRegion = NewMemo(func(Props) Child { return QueuePanel() }, nil)

func QueueRow(key string, song *Item, index int, dim bool) *VNode {
	current := index == state.Index
	opacity := 1.0
	if dim {
		opacity = 0.6
	}
	tc := c.text
	if current {
		tc = c.accent
	}
	p := Props{"id": fmt.Sprintf("queue-%d", index), "onClick": func() { state.Jump(index) }, "control": S{"role": "button", "label": "Play " + song.Title},
		"style": S{"padding": 6, "gap": 10, "direction": "row", "align": "center", "radius": 8, "cursor": "pointer", "opacity": opacity, "hover": S{"background": c.hover}}}
	if key != "" {
		p["key"] = key
	}
	return Pressable(p,
		Art(song.Thumbnail, 36, 4, false),
		Column(Props{"gap": 1, "style": S{"flex": 1, "minWidth": 0}},
			Text(Props{"size": 13, "color": tc, "style": ellipsis}, song.Title),
			Text(Props{"size": 11, "color": c.muted, "style": ellipsis}, song.Artist)))
}

func QueuePanel() *VNode {
	lo, hi := max(0, state.Index-3), max(0, state.Index)
	history := state.Queue[min(lo, len(state.Queue)):min(hi, len(state.Queue))]
	upNext := state.Queue[min(state.Index+1, len(state.Queue)):min(state.Index+51, len(state.Queue))]
	current := state.current()
	label := func(text string) *VNode {
		return Text(Props{"size": 11, "weight": 700, "color": c.muted, "style": S{"padding": S{"left": 6, "top": 14, "bottom": 4}, "letterSpacing": 0.6}}, text)
	}
	var body Child
	if current != nil {
		var hist, next Child
		if len(history) > 0 {
			rows := []Child{}
			for i, s := range history {
				rows = append(rows, QueueRow(fmt.Sprintf("h%d", i), s, state.Index-len(history)+i, true))
			}
			hist = Fragment(label("HISTORY"), rows)
		}
		if len(upNext) > 0 {
			rows := []Child{}
			for i, s := range upNext {
				rows = append(rows, QueueRow(fmt.Sprintf("n%d-%s", i, s.ID), s, state.Index+1+i, false))
			}
			next = Fragment(label("UP NEXT"), rows)
		}
		nowPlaying := "NOW PLAYING"
		if state.Source != "" {
			nowPlaying = "NOW PLAYING · " + strings.ToUpper(state.Source)
		}
		body = Fragment(hist, label(nowPlaying), QueueRow("", current, state.Index, false), next)
	} else {
		body = Text(Props{"size": 12, "color": c.muted, "style": S{"padding": S{"top": 14, "left": 6}}}, "Play something to fill the queue.")
	}
	count := ""
	if len(state.Queue) > 0 {
		count = fmt.Sprintf("%d / %d", state.Index+1, len(state.Queue))
	}
	return Column(Props{"style": S{"width": 264, "shrink": 0, "background": c.panel, "borderColor": c.border, "borderWidth": S{"left": 1}, "minHeight": 0}},
		Row(Props{"align": "center", "style": S{"height": 36, "padding": S{"left": 14, "right": 8}, "borderColor": c.border, "borderWidth": S{"bottom": 1}}},
			Text(Props{"size": 11, "weight": 700, "color": c.muted, "style": S{"letterSpacing": 0.6, "flex": 1}}, "QUEUE"),
			Text(Props{"size": 11, "color": c.muted}, count)),
		Scroll(Props{"flex": 1, "style": S{"minHeight": 0}},
			Column(Props{"style": S{"padding": S{"left": 8, "right": 8, "bottom": 12}}}, body)))
}

func togglePlaying() {
	if state.Page.Kind == "playing" {
		state.GoBack()
	} else {
		state.Open(&Page{Kind: "playing"})
	}
}

func PlayerBar() *VNode {
	song := state.current()
	duration := state.Duration
	if duration == 0 && song != nil && song.Duration != nil {
		duration = *song.Duration
	}
	volume := state.Volume
	if state.Muted {
		volume = 0
	}
	ready := state.Path != "" && state.Loading == nil
	var status string
	if state.PlayError != nil {
		status = *state.PlayError
	} else if state.Loading != nil || (state.Path != "" && !state.Playing && state.Time == 0) {
		status = "Loading…"
	}
	barLabel, barBg := "Open now playing", c.panel
	if state.Page.Kind == "playing" {
		barLabel, barBg = "Close now playing", c.raised
	}
	var left Child
	if song != nil {
		statusColor := c.muted
		if state.PlayError != nil {
			statusColor = "#ff8a8a"
		}
		shown := status
		if shown == "" {
			shown = song.Artist
		}
		left = Fragment(
			Art(song.Thumbnail, 44, 6, false),
			Column(Props{"gap": 2, "style": S{"flex": 1, "minWidth": 0}},
				Text(Props{"id": "now-title", "size": 13, "weight": 600, "style": ellipsis}, song.Title),
				Text(Props{"id": "now-status", "size": 12, "color": statusColor, "style": ellipsis}, shown)))
	} else {
		left = Text(Props{"size": 12, "color": c.muted}, "Nothing playing")
	}
	playOpacity := 0.5
	if ready {
		playOpacity = 1
	}
	playLabel, playIcon := "Play", icons.play
	if state.Playing {
		playLabel, playIcon = "Pause", icons.pause
	}
	var timeShown, durationShown *float64
	if song != nil {
		timeShown, durationShown = ptr(state.Time), ptr(duration)
	}
	muteIcon, muteLabel := icons.volume, "Mute"
	if volume == 0 {
		muteIcon = icons.mute
	}
	if state.Muted {
		muteLabel = "Unmute"
	}
	return Pressable(Props{"id": "player-bar", "onClick": togglePlaying, "control": S{"role": "button", "label": barLabel},
		"style": S{"direction": "row", "align": "center", "height": 68, "shrink": 0, "padding": S{"left": 12, "right": 16}, "gap": 16, "background": barBg, "borderColor": c.border, "borderWidth": S{"top": 1}, "cursor": "pointer"}},
		Row(Props{"gap": 12, "align": "center", "style": S{"width": 300, "shrink": 0, "minWidth": 0}}, left),
		Column(Props{"flex": 1, "gap": 4, "align": "center", "style": S{"minWidth": 0}},
			Row(Props{"gap": 6, "align": "center"},
				IconButton(iconButton{id: "shuffle", d: icons.shuffle, label: "Shuffle", size: 15, active: state.Shuffle, onClick: func() { state.ToggleShuffle() }}),
				IconButton(iconButton{id: "previous", d: icons.prev, label: "Previous", size: 16, fill: true, onClick: func() { state.Previous() }, disabled: song == nil}),
				Pressable(Props{"id": "play", "onClick": func() {
					if !ready {
						return
					}
					if state.Playing {
						state.media(MediaController.Pause)
					} else {
						state.media(MediaController.Play)
					}
				}, "control": S{"role": "button", "label": playLabel},
					"style": S{"width": 34, "height": 34, "radius": 999, "background": c.text, "align": "center", "justify": "center", "cursor": "pointer", "opacity": playOpacity, "hover": S{"transform": "scale(1.06)"}}},
					Glyph(glyph{d: playIcon, size: 16, fill: true, color: c.window})),
				IconButton(iconButton{id: "next", d: icons.next, label: "Next", size: 16, fill: true, onClick: func() { state.Next() }, disabled: song == nil}),
				IconButton(iconButton{id: "repeat", d: icons.repeat, label: "Repeat: " + state.Repeat, size: 15, active: state.Repeat != "off", onClick: func() {
					switch state.Repeat {
					case "off":
						state.Repeat = "all"
					case "all":
						state.Repeat = "one"
					default:
						state.Repeat = "off"
					}
				}})),
			Row(Props{"gap": 10, "align": "center", "style": S{"width": "100%", "maxWidth": 560}},
				Text(Props{"id": "time", "size": 11, "color": c.muted, "style": S{"width": 36, "textAlign": "end", "shrink": 0}}, clock(timeShown)),
				Slider(Props{"id": "progress", "label": "Position", "value": math.Min(state.Time, duration), "min": 0, "max": math.Max(duration, 0.001), "step": 0.1,
					"disabled": !ready, "onValueChange": func(v float64) {
						state.Time = v
						state.media(func(m MediaController) { m.Seek(v) })
					},
					"style": S{"flex": 1, "minWidth": 0, "width": "auto", "foreground": c.accent}}),
				Text(Props{"size": 11, "color": c.muted, "style": S{"width": 36, "shrink": 0}}, clock(durationShown)))),
		Row(Props{"gap": 6, "align": "center", "justify": "end", "style": S{"width": 300, "shrink": 0}},
			IconButton(iconButton{id: "mute", d: muteIcon, label: muteLabel, size: 16, onClick: func() { state.Muted = !state.Muted }}),
			Slider(Props{"id": "volume", "label": "Volume", "value": math.Round(volume * 100), "min": 0, "max": 100, "step": 1,
				"onValueChange": func(v float64) { state.Volume = v / 100; state.Muted = v == 0 },
				"style":         S{"width": 110, "foreground": c.text}})))
}

func SignInDialog() Child {
	if state.SignIn == "closed" {
		return nil
	}
	button := func(id, label string, onClick func(), primary bool) *VNode {
		bg, tc := c.raised, c.text
		if primary {
			bg, tc = c.accent, c.accentInk
		}
		return Pressable(Props{"id": id, "onClick": onClick, "control": S{"role": "button", "label": label},
			"style": S{"height": 34, "padding": S{"left": 16, "right": 16}, "radius": 8, "align": "center", "justify": "center", "cursor": "pointer",
				"background": bg, "hover": S{"opacity": 0.88}}},
			Text(Props{"size": 13, "weight": 600, "color": tc}, label))
	}
	closeDialog := func() { state.SignIn = "closed" }
	var errText Child
	if state.SignInError != nil {
		errText = Text(Props{"size": 12, "color": "#ff8a8a"}, *state.SignInError)
	}
	var body Child
	switch state.SignIn {
	case "browser":
		body = Fragment(
			Text(Props{"size": 13, "color": c.muted}, "Finish signing in in the browser window that opened. It closes on its own once YouTube Music has your account."),
			Row(Props{"gap": 8, "justify": "end"}, button("sign-in-cancel", "Cancel", closeDialog, false)))
	case "paste":
		body = Fragment(
			Text(Props{"size": 13, "color": c.muted}, "On music.youtube.com (signed in), open DevTools → Network, pick any request to music.youtube.com and copy its Cookie request header here."),
			Input(Props{"id": "cookie-input", "type": "password", "placeholder": "SAPISID=…; __Secure-3PAPISID=…; …", "value": state.PastedCookies,
				"onChange": func(v string) { state.PastedCookies = v }, "onSubmit": func(string) { state.SavePastedCookies() },
				"style": S{"background": c.raised, "borderColor": c.border, "foreground": c.text}}),
			errText,
			Row(Props{"gap": 8, "justify": "end"}, button("paste-cancel", "Cancel", closeDialog, false), button("paste-save", "Sign in", func() { state.SavePastedCookies() }, true)))
	default:
		body = Fragment(
			Text(Props{"size": 13, "color": c.muted}, "Sign in with your Google account in a browser window. Your Premium account gives 256 kbps audio and your library."),
			errText,
			Row(Props{"gap": 8, "justify": "end"},
				button("choose-cancel", "Cancel", closeDialog, false),
				button("choose-paste", "Paste cookies", func() { state.SignIn = "paste"; state.SignInError = nil }, false),
				button("choose-browser", "Sign in with Google", func() { state.SignInWithBrowser() }, true)))
	}
	return Modal(Props{"id": "sign-in", "open": true, "width": 440, "showClose": false, "closeOnOverlay": false,
		"onOpenChange": func(open bool) {
			if !open {
				state.SignIn = "closed"
			}
		},
		"style": S{"gap": 14, "radius": 14, "background": c.panel, "borderColor": c.border}},
		Text(Props{"size": 18, "weight": 700}, "Sign in to YouTube Music"),
		body)
}

// LineAt is the lyric line being sung at time: the last one that started, or -1 before the first.
func LineAt(lines []LyricLine, time float64) int {
	low, high, found := 0, len(lines)-1, -1
	for low <= high {
		middle := (low + high) >> 1
		if lines[middle].Time <= time+0.15 {
			found, low = middle, middle+1
		} else {
			high = middle - 1
		}
	}
	return found
}

func YouTubeMusicView() *VNode {
	song := state.current()
	var synced []LyricLine
	if state.Page.Kind == "playing" && state.Lyrics != nil && song != nil && state.Lyrics.ID == song.ID && state.Lyrics.Data != nil {
		synced = state.Lyrics.Data.Lines
	}
	lyricLine := -1
	if synced != nil {
		lyricLine = LineAt(synced, state.Time)
	}
	title := "Music"
	if state.Playing && song != nil {
		title = song.Title + " • " + song.Artist
	}
	current := ""
	if song != nil {
		current = song.ID
	}
	audio := Props{"id": AudioID, "autoPlay": true, "volume": state.Volume, "muted": state.Muted, "loop": state.Repeat == "one",
		"onPlay":  func(MediaEventInfo) { state.Playing = true; state.Played() },
		"onPause": func(MediaEventInfo) { state.Playing = false },
		"onTimeUpdate": func(info MediaEventInfo) {
			state.Time = info.CurrentTime
			state.FollowLyrics()
		},
		"onSeeked": func(info MediaEventInfo) {
			state.Time = info.CurrentTime
			state.FollowLyrics()
		},
		"onLoadedMetadata": func(info MediaEventInfo) {
			if info.Duration != nil {
				state.Duration = *info.Duration
			}
			if state.ResumeAt > 0 {
				at := state.ResumeAt
				state.media(func(m MediaController) { m.Seek(at) })
				state.Time, state.ResumeAt = at, 0
			}
		},
		"onEnded": func(MediaEventInfo) { state.Playing = false; state.Next() },
		"onError": func(message string) { state.MediaFailed(message) }}
	if state.Path != "" {
		audio["src"] = state.Path
	}
	var queue Child
	if state.ShowQueue {
		queue = E(queueRegion, Props{"queue": state.Queue, "index": state.Index, "source": state.Source})
	}
	return Window(Props{"onCloseRequest": func(e *CloseRequest) { e.PreventDefault(); state.Hide() }, "title": title, "width": 1320, "height": 820, "minWidth": 960, "minHeight": 580,
		"position": "center", "theme": ytmTheme, "style": S{"background": c.window, "foreground": c.text, "fontFamily": "Inter", "borderColor": c.border}},
		Audio(audio),
		Column(Props{"flex": 1, "style": S{"minHeight": 0}},
			TopBar(),
			Row(Props{"flex": 1, "align": "stretch", "style": S{"minHeight": 0}},
				E(sidebarRegion, Props{"page": state.Page, "library": state.Library, "signedIn": state.SignedIn, "source": state.Source, "playing": state.Playing, "current": current}),
				Column(Props{"flex": 1, "style": S{"minHeight": 0, "minWidth": 0}},
					E(contentRegion, Props{"page": state.Page, "shelves": state.Shelves, "results": state.Results, "opened": state.Opened, "library": state.Library, "signedIn": state.SignedIn,
						"pageError": state.PageError, "listOffset": state.ListOffset, "current": current, "playing": state.Playing, "source": state.Source, "stage": state.Stage,
						"lyrics": state.Lyrics, "lyricLine": lyricLine})),
				queue),
			PlayerBar()),
		SignInDialog())
}

func HomeShelves() *VNode {
	shelves := []Child{}
	for i, shelf := range state.Shelves {
		shelf := shelf
		songs := songsOf(shelf.Items)
		var shuffle Child
		if len(songs) > 1 {
			shuffle = IconButton(iconButton{id: fmt.Sprintf("shuffle-shelf-%d", i), d: icons.shuffle, label: "Shuffle play " + shelf.Title, size: 16, onClick: func() { shufflePlay(songs, shelf.Title) }})
		}
		cards := []Child{}
		for j, item := range shelf.Items {
			cards = append(cards, ShelfCard(fmt.Sprintf("%d-%s", j, item.ID), fmt.Sprintf("%d-%d", i, j), item, shelf))
		}
		shelves = append(shelves, Column(Props{"key": fmt.Sprintf("%d-%s", i, shelf.Title), "gap": 6},
			Row(Props{"gap": 8, "align": "center", "style": S{"padding": S{"left": 8}}},
				Text(Props{"size": 20, "weight": 700}, shelf.Title),
				shuffle),
			Scroll(Props{"orientation": "horizontal", "style": S{"shrink": 0}},
				Row(Props{"gap": 4, "style": S{"padding": S{"bottom": 6}}}, cards))))
	}
	return Column(Props{"gap": 28}, shelves)
}
