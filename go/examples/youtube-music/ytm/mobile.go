package ytm

// The phone layout (a phone, or any window narrower than 640 px), as youtube-music-mobile.tsx:
// a bottom navigation bar instead of the sidebar, and a two-row player without the desktop's
// volume and queue.

import (
	"math"

	. "github.com/omarcosr/tarve/go/tarve"
)

// compact: a phone-sized window (narrow, or a phone on its side). Reading it renders the view
// again on resize.
func compact() bool {
	v := Viewport()
	return v.Width < 640 || (v.Pointer == "coarse" && v.Height < 640)
}

func mobileTab(id, d, label string, active bool, onClick func()) *VNode {
	color, weight := c.muted, 400
	if active {
		color, weight = c.text, 600
	}
	return Pressable(Props{"id": id, "onClick": onClick, "control": S{"role": "tab", "label": label, "selected": active},
		"style": S{"flex": 1, "height": "100%", "direction": "column", "align": "center", "justify": "center", "gap": 4}},
		Glyph(glyph{d: d, size: 20, color: color}),
		Text(Props{"size": 11, "weight": weight, "color": color}, label))
}

func MobileNav() *VNode {
	kind := state.Page.Kind
	return Row(Props{"style": S{"height": 60, "shrink": 0, "background": c.panel}},
		mobileTab("tab-home", icons.home, "Home", kind == "home", func() { state.Open(&Page{Kind: "home"}) }),
		mobileTab("tab-search", icons.search, "Search", kind == "search", func() { state.Open(&Page{Kind: "search", Query: state.Query}) }),
		mobileTab("tab-library", icons.library, "Library", kind == "library", func() { state.Open(&Page{Kind: "library"}) }))
}

func MobilePlayerBar() Child {
	song := state.current()
	if song == nil {
		return nil
	}
	duration := state.Duration
	if duration == 0 && song.Duration != nil {
		duration = *song.Duration
	}
	ready := state.Path != "" && state.Loading == nil
	shown, statusColor := song.Artist, c.muted
	if state.PlayError != nil {
		shown, statusColor = *state.PlayError, "#ff8a8a"
	} else if state.Loading != nil || (state.Path != "" && !state.Playing && state.Time == 0) {
		shown = "Loading…"
	}
	barLabel, barBg := "Open now playing", c.panel
	if state.Page.Kind == "playing" {
		barLabel, barBg = "Close now playing", c.raised
	}
	playIcon, playLabel := icons.play, "Play"
	if state.Playing {
		playIcon, playLabel = icons.pause, "Pause"
	}
	return Pressable(Props{"id": "player-bar", "onClick": togglePlaying, "control": S{"role": "button", "label": barLabel},
		"style": S{"direction": "column", "shrink": 0, "padding": S{"left": 12, "right": 8, "top": 8}, "gap": 2, "background": barBg, "borderColor": c.border, "borderWidth": S{"top": 1, "bottom": 1}}},
		Row(Props{"gap": 12, "align": "center"},
			Art(song.Thumbnail, 44, 6, false),
			Column(Props{"gap": 2, "style": S{"flex": 1, "minWidth": 0}},
				Text(Props{"id": "now-title", "size": 14, "weight": 600, "style": ellipsis}, song.Title),
				Text(Props{"id": "now-status", "size": 12, "color": statusColor, "style": ellipsis}, shown)),
			IconButton(iconButton{id: "previous", d: icons.prev, label: "Previous", size: 20, fill: true, box: 40, onClick: func() { state.Previous() }}),
			IconButton(iconButton{id: "play", d: playIcon, label: playLabel, size: 22, fill: true, box: 44, disabled: !ready, onClick: func() {
				if state.Playing {
					state.media(MediaController.Pause)
				} else {
					state.media(MediaController.Play)
				}
			}}),
			IconButton(iconButton{id: "next", d: icons.next, label: "Next", size: 20, fill: true, box: 40, onClick: func() { state.Next() }})),
		Row(Props{"gap": 8, "align": "center"},
			Text(Props{"id": "time", "size": 11, "color": c.muted, "style": S{"width": 44, "shrink": 0, "whiteSpace": "nowrap"}}, clock(ptr(state.Time))),
			Slider(Props{"id": "progress", "label": "Position", "value": math.Min(state.Time, duration), "min": 0, "max": math.Max(duration, 0.001), "step": 0.1,
				"disabled": !ready, "onValueChange": func(v float64) {
					state.Time = v
					state.media(func(m MediaController) { m.Seek(v) })
				},
				"style": S{"flex": 1, "minWidth": 0, "width": "auto", "foreground": c.accent}}),
			Text(Props{"size": 11, "color": c.muted, "style": S{"width": 44, "shrink": 0, "textAlign": "end", "whiteSpace": "nowrap"}}, clock(ptr(duration)))))
}
