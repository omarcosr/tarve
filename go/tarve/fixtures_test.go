package tarve

import (
	"encoding/json"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"reflect"
	"sort"
	"strings"
	"testing"
)

var fixtureDark = CreateTheme(DarkTheme, ThemeOverrides{Colors: map[string]string{"primary": "#ff0033"}})

var fixtures = map[string]func() Child{
	"variants": func() Child {
		rows := []Child{}
		for i := 0; i < 4; i++ {
			rows = append(rows, E("div", Props{"key": i, "style": S{"padding": 8, "background": "#111111", "first": S{"padding": S{"top": 20}}, "last": S{"background": "#222222"}, "odd": S{"radius": 4}, "even": S{"radius": S{"topLeft": 9}}}},
				Text(Props{"style": S{"fontSize": 12, "md": S{"fontSize": 16}, "lg": S{"fontSize": 20}, "dark": S{"foreground": "#eeeeee", "hover": S{"foreground": "#ffffff"}}}}, "Row ", i)))
		}
		return Window(Props{"title": "variants", "width": 900, "height": 600, "theme": fixtureDark}, Column(Props{"gap": 4}, rows))
	},
	"inline": func() Child {
		return Window(Props{"title": "inline", "width": 800, "height": 600},
			Text(Props{"size": 15}, "Plain ", E("strong", nil, "bold ", E("em", nil, "both")), " and ", E("a", Props{"href": "https://example.com"}, "a link"), ", ",
				E("code", nil, "code()"), ", x", E("sup", nil, "2"), ", ", E("mark", nil, "marked"), ".", E("br", nil), "Next   line ",
				E("span", Props{"style": S{"color": "#ff0000"}, "onClick": func() {}}, "clickable"), " ", E("small", nil, "small"), " ", E("del", nil, "gone"), " ",
				E("u", nil, "under"), " ", E("abbr", Props{"title": "t"}, "abbr")),
			Text(Props{"style": S{"whiteSpace": "pre-line"}}, "keep\n  lines   here\nsecond"),
			Text(Props{"style": S{"textTransform": "uppercase"}}, "shout this"),
			Text(Props{"style": S{"textTransform": "capitalize"}}, "every word here ", E("strong", nil, "bold one")),
			Text(Props{"style": S{"whiteSpace": "pre"}}, "  pre  kept "))
	},
	"html": func() Child {
		return Window(Props{"title": "html", "width": 800, "height": 600},
			E("h1", nil, "Title"), E("h3", Props{"style": S{"color": "#333333"}}, "Sub"), E("p", nil, "Paragraph text"),
			E("span", nil, "a span"), E("strong", nil, "loose strong"),
			E("img", Props{"src": "https://example.com/a.png", "style": S{"width": 40, "height": 40, "objectFit": "contain"}}))
	},
	"glass": func() Child {
		return Window(Props{"title": "glass", "width": 800, "height": 600, "backdrop": "blur"},
			TitleBar(Props{"title": "Glass", "glass": true, "appearance": "dark", "style": S{"radius": 12}}),
			Glass(Props{"variant": "tinted", "tint": "#3366ff40", "radius": 18, "style": S{"padding": 12}}, Text(nil, "inside")),
			Glass(Props{"variant": "clear", "appearance": "dark", "merge": "bar", "shadow": false}, View(Props{"style": S{"width": 10, "height": 10}})))
	},
	"biglist": func() Child {
		rows := make([]Child, 700)
		for i := range rows {
			if i%7 == 3 {
				rows[i] = fmt.Sprintf("loose %d", i)
				continue
			}
			var second Child = "plain"
			if i%11 == 0 {
				second = E("em", nil, "em ", i)
			}
			color := "#222222"
			if i%3 != 0 {
				color = "#111111"
			}
			rows[i] = E("div", Props{"key": i, "style": S{"height": 30, "first": S{"background": "#ff0000"}, "last": S{"background": "#00ff00"}, "even": S{"padding": S{"left": i % 50}}}},
				Text(Props{"style": S{"fontSize": 10 + i%5, "color": color}}, "Row ", i, " ", E("strong", Props{"onClick": func() {}}, "go")),
				Text(nil, second))
		}
		return Window(Props{"title": "big", "width": 800, "height": 600}, Column(nil, rows))
	},
	"controls": func() Child {
		yes, no := true, false
		_ = no
		return Window(Props{"title": "controls", "width": 900, "height": 700},
			Checkbox(Props{"checked": yes, "label": "Check", "onCheckedChange": func(bool) {}}),
			Checkbox(Props{"checked": false, "label": "Off", "disabled": true}),
			Switch(Props{"checked": true, "label": "On"}),
			Switch(Props{"checked": false, "label": "Off", "style": S{"foreground": "#123456"}}),
			RadioGroup(Props{"value": "b", "orientation": "horizontal", "options": []RadioOption{{Value: "a", Label: "A"}, {Value: "b", Label: "B"}, {Value: "c", Label: "C", Disabled: true}}}),
			Card(Props{"title": "Card", "description": "desc", "footer": Text(nil, "foot")}, Text(nil, "body")),
			Badge(Props{"variant": "outline"}, "new"),
			Separator(Props{"orientation": "vertical"}),
			Progress(Props{"value": 30, "max": 120, "label": "Load", "style": S{"foreground": "#00ff00", "radius": 2}}),
			Tabs(Props{"value": "two", "items": []TabItem{{Value: "one", Label: "One", Content: Text(nil, "1")}, {Value: "two", Label: "Two", Content: Text(nil, "2")}}}),
			Accordion(Props{"value": "x", "items": []AccordionItem{{Value: "x", Title: "X", Content: Text(nil, "open")}, {Value: "y", Title: "Y", Content: Text(nil, "closed"), Disabled: true}}}),
			Markdown(Props{"source": "# Hi\n\n- a"}),
			Code(Props{"code": "let a = 1", "language": "ts", "showLineNumbers": true}),
			Diff(Props{"oldText": "a\nb", "newText": "a\nc"}),
			TextArea(Props{"value": "line\r\nnext", "placeholder": "type", "submitOnEnter": true}),
			Link(Props{"href": "https://example.com", "style": S{"fontSize": 18}}, "Docs"))
	},
	"audio": func() Child {
		return Window(Props{"title": "audio", "width": 800, "height": 600},
			Audio(Props{"id": "player", "src": "https://example.com/a.mp3", "controls": true, "muted": true, "ariaLabel": "Song", "style": S{"width": 400}}),
			Audio(Props{"id": "silent", "src": "https://example.com/b.mp3"}))
	},
}

func diffJSON(path string, a, b any, out *[]string) {
	if len(*out) > 20 {
		return
	}
	switch x := a.(type) {
	case map[string]any:
		y, ok := b.(map[string]any)
		if !ok {
			*out = append(*out, fmt.Sprintf("%s: ts %v go %v", path, a, b))
			return
		}
		keys := map[string]bool{}
		for k := range x {
			keys[k] = true
		}
		for k := range y {
			keys[k] = true
		}
		list := []string{}
		for k := range keys {
			list = append(list, k)
		}
		sort.Strings(list)
		for _, k := range list {
			diffJSON(path+"."+k, x[k], y[k], out)
		}
	case []any:
		y, ok := b.([]any)
		if !ok || len(x) != len(y) {
			*out = append(*out, fmt.Sprintf("%s: ts %v go %v", path, a, b))
			return
		}
		for i := range x {
			diffJSON(fmt.Sprintf("%s[%d]", path, i), x[i], y[i], out)
		}
	default:
		if !reflect.DeepEqual(a, b) {
			*out = append(*out, fmt.Sprintf("%s: ts %v go %v", path, a, b))
		}
	}
}

// TestFixtureParity compiles each fixture in Go and in TypeScript (go/parity/fixtures.tsx).
func TestFixtureParity(t *testing.T) {
	type scenario struct {
		Name  string         `json:"name"`
		State map[string]any `json:"state"`
	}
	var scenarios []scenario
	for _, name := range []string{"variants", "inline", "html", "glass", "audio", "biglist", "controls"} {
		scenarios = append(scenarios, scenario{Name: name, State: map[string]any{}})
	}
	for _, w := range []float64{600, 800, 1100, 1600} {
		scenarios = append(scenarios, scenario{Name: fmt.Sprintf("variants:%v", w), State: map[string]any{"viewport": map[string]any{"width": w, "height": 500}}})
	}
	file := filepath.Join(t.TempDir(), "s.json")
	data, _ := json.Marshal(scenarios)
	os.WriteFile(file, data, 0o644)
	root, _ := filepath.Abs("../..")
	cmd := exec.Command("bun", filepath.Join("go", "parity", "dump.tsx"), "fixtures", file)
	cmd.Dir = root
	cmd.Stderr = os.Stderr
	raw, err := cmd.Output()
	if err != nil {
		t.Skipf("bun unavailable: %v", err)
	}
	var want []struct{ Document any }
	if err := json.Unmarshal(raw, &want); err != nil {
		t.Fatal(err)
	}
	for i, sc := range scenarios {
		t.Run(sc.Name, func(t *testing.T) {
			r := NewTestRenderer(fixtures[strings.Split(sc.Name, ":")[0]])
			if v, ok := sc.State["viewport"].(map[string]any); ok {
				r.Viewport = &Size{fnum(v["width"]), fnum(v["height"])}
			}
			var got any
			json.Unmarshal(r.Render(), &got)
			var out []string
			diffJSON("", want[i].Document, got, &out)
			if len(out) > 0 {
				t.Errorf("differences:\n%s", strings.Join(out, "\n"))
			}
		})
	}
}
