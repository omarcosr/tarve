package tarve

import "testing"

// CSS text-align: match-parent computes to the parent's value with start/end resolved against
// the parent's (left-to-right) direction; left and right pass through as physical edges.
func TestTextAlignMatchParentResolvesAgainstTheParent(t *testing.T) {
	tree := compileTree(func() Child {
		return Window(Props{"title": "a"},
			View(Props{"style": S{"textAlign": "right"}}, Text(Props{"id": "right"}, "a"), Text(Props{"id": "match-right", "style": S{"textAlign": "match-parent"}}, "b")),
			View(Props{"style": S{"textAlign": "start"}}, Text(Props{"id": "match-start", "style": S{"textAlign": "match-parent"}}, "c")),
			View(Props{"style": S{"textAlign": "end"}}, View(Props{"id": "box", "style": S{"textAlign": "match-parent"}}, Text(Props{"id": "through-box"}, "d"))),
			View(Props{"style": S{"textAlign": "center"}}, Text(Props{"id": "match-center", "style": S{"textAlign": "match-parent"}}, "e")),
			Text(Props{"id": "match-root", "style": S{"textAlign": "match-parent"}}, "f"),
		)
	}, false, "auto", nil, true, &Size{400, 300}, nil)
	want := map[string]string{"right": "right", "match-right": "right", "match-start": "left", "box": "right", "through-box": "right", "match-center": "center", "match-root": "left"}
	for id, align := range want {
		if got := tree.Nodes[id].Style["textAlign"]; got != align {
			t.Errorf("%s: textAlign %v, want %s", id, got, align)
		}
	}
}
