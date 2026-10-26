package ytm

// The title bar: the brand, back, search, the queue toggle and the account (sign in or out).

import (
	"strings"

	. "github.com/omarcosr/tarve/go/tarve"
)

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
			Text(Props{"size": 12, "color": c.text, "style": S{"whiteSpace": "nowrap"}}, "Sign in"))
	}
	brandWidth, brand, queueToggle := any(200), Child(Text(Props{"size": 15, "weight": 700}, "Music")), Child(IconButton(iconButton{id: "toggle-queue", d: icons.queue, label: queueLabel, tip: "bottom", active: state.ShowQueue, onClick: func() { state.ShowQueue = !state.ShowQueue }}))
	if compact() {
		brandWidth, brand, queueToggle = nil, nil, nil
	}
	return TitleBar(Props{"id": "titlebar", "height": 44, "style": S{"background": c.panel, "foreground": c.text, "borderColor": c.border, "padding": S{"left": 8}}},
		Row(Props{"align": "center", "style": S{"flex": 1, "minWidth": 0, "height": "100%", "padding": S{"right": 8}, "gap": 8}},
			Row(Props{"gap": 8, "align": "center", "style": S{"width": brandWidth, "shrink": 0, "padding": S{"left": 6}}},
				View(Props{"style": S{"width": 24, "height": 24, "radius": 12, "background": c.accent, "align": "center", "justify": "center"}}, Glyph(glyph{d: icons.play, size: 12, fill: true, color: c.accentInk})),
				brand),
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
			queueToggle,
			account))
}
