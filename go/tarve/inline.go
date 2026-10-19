package tarve

import (
	"math"
	"strings"
	"unicode"
	"unicode/utf8"
)

// Phrasing content inside Text, as @tarve/core compileInline: span, strong, em, a, code, br… become
// styled runs over one string (UTF-8 byte offsets).

var inlineTags = map[string]S{
	"span": {}, "strong": {"fontWeight": "bolder"}, "b": {"fontWeight": "bolder"},
	"em": {"fontStyle": "italic"}, "i": {"fontStyle": "italic"}, "cite": {"fontStyle": "italic"}, "var": {"fontStyle": "italic"}, "dfn": {"fontStyle": "italic"},
	"u": {"textDecoration": "underline"}, "ins": {"textDecoration": "underline"},
	"s": {"textDecoration": "line-through"}, "del": {"textDecoration": "line-through"},
	"code": {"fontFamily": "monospace"}, "kbd": {"fontFamily": "monospace"}, "samp": {"fontFamily": "monospace"},
	"mark":  {"background": "#ffff00", "foreground": "#000000"},
	"small": {"fontSize": "smaller"},
	"sub":   {"verticalAlign": "sub", "fontSize": "smaller"},
	"sup":   {"verticalAlign": "super", "fontSize": "smaller"},
	"a":     {"textDecoration": "underline"},
	"abbr":  {},
}

var runKeys = []string{"fontWeight", "fontStyle", "fontSize", "fontFamily", "foreground", "background", "textDecoration", "letterSpacing", "wordSpacing", "fontVariantNumeric", "fontFeatureSettings", "textTransform", "baselineShift", "textDecorationStyle"}

// OpenExternal opens a link's href (<a href>) with the system handler; set by the app.
var OpenExternal = func(href string) {}

type piece struct {
	text  string
	style S
	id    string
	br    bool
}

func pickRun(style S) S {
	out := S{}
	for _, k := range runKeys {
		if style[k] != nil {
			out[k] = style[k]
		}
	}
	return out
}

func numberOr(v any, fallback float64) float64 {
	if f, ok := num(v); ok {
		return f
	}
	return fallback
}

func computeRunStyle(parent, own S) S {
	next := merge(parent, own)
	switch own["fontWeight"] {
	case "bolder":
		w := numberOr(parent["fontWeight"], 400)
		next["fontWeight"] = map[bool]float64{true: 400, false: map[bool]float64{true: 700, false: 900}[w < 550]}[w < 350]
	case "lighter":
		w := numberOr(parent["fontWeight"], 400)
		next["fontWeight"] = map[bool]float64{true: 100, false: map[bool]float64{true: 400, false: 700}[w < 750]}[w < 550]
	}
	if va := own["verticalAlign"]; va == "super" || va == "sub" {
		size := numberOr(parent["fontSize"], 14)
		shift := -(size/5 + 1)
		if va == "super" {
			shift = size/3 + 1
		}
		next["baselineShift"] = math.Round((numberOr(parent["baselineShift"], 0)+shift)*100) / 100
	}
	delete(next, "verticalAlign")
	switch own["fontSize"] {
	case "smaller":
		next["fontSize"] = numberOr(parent["fontSize"], 14) / 1.2
	case "larger":
		next["fontSize"] = numberOr(parent["fontSize"], 14) * 1.2
	}
	pd, _ := parent["textDecoration"].(string)
	if od, ok := own["textDecoration"].(string); ok && pd != "" && pd != "none" && od != "none" {
		seen := map[string]bool{}
		var lines []string
		for _, l := range strings.Fields(pd + " " + od) {
			if !seen[l] {
				seen[l] = true
				lines = append(lines, l)
			}
		}
		next["textDecoration"] = strings.Join(lines, " ")
	}
	return next
}

func transformText(text string, transform any, wordStart bool) string {
	switch transform {
	case "uppercase":
		return strings.ToUpper(text)
	case "lowercase":
		return strings.ToLower(text)
	case "capitalize":
		var b strings.Builder
		start := wordStart
		for _, r := range text {
			if start && unicode.IsLetter(r) {
				b.WriteRune(unicode.ToUpper(r))
			} else {
				b.WriteRune(r)
			}
			start = unicode.IsSpace(r)
		}
		return b.String()
	}
	return text
}

func (c *compiler) resolveRun(style S) S {
	return resolveThemeStyle(foldVariants(style, c.theme, variantContext{width: c.viewportWidth(), usedViewport: &c.usesViewport}), c.theme)
}

func (c *compiler) collectInline(child Child, style S, id string, textID string, runs *int, out *[]piece) {
	switch v := child.(type) {
	case nil, bool:
		return
	case []Child:
		for _, x := range v {
			c.collectInline(x, style, id, textID, runs, out)
		}
		return
	case *VNode:
		if v == nil {
			return
		}
		switch t := v.Type.(type) {
		case *Memo:
			c.collectInline(t.Render(v.Props), style, id, textID, runs, out)
			return
		case Component:
			c.collectInline(t(v.Props), style, id, textID, runs, out)
			return
		case func(Props) Child:
			c.collectInline(t(v.Props), style, id, textID, runs, out)
			return
		case func(Props) *VNode:
			c.collectInline(t(v.Props), style, id, textID, runs, out)
			return
		}
		p := v.Props
		kind, _ := v.Type.(string)
		switch kind {
		case fragmentType:
			c.collectInline(p["children"], style, id, textID, runs, out)
			return
		case "br":
			*out = append(*out, piece{br: true})
			return
		case "text":
			c.collectInline(p["children"], computeRunStyle(style, pickRun(c.resolveRun(styleOf(p)))), id, textID, runs, out)
			return
		}
		tag, ok := inlineTags[kind]
		if !ok || (kind == "code" && p["code"] != nil) {
			panic("tarve: <" + kind + "> cannot be inside text; only phrasing elements (span, strong, em, a, code, br…) can")
		}
		own := merge(tag)
		if kind == "abbr" && truthy(p["title"]) {
			own["textDecoration"], own["textDecorationStyle"] = "underline", "dotted"
		}
		if kind == "a" {
			own["foreground"] = resolveStyleString("foreground", T.Primary, c.theme)
		}
		for k, v := range pickRun(c.resolveRun(canonicalizeIntrinsicStyle(styleOf(p)))) {
			own[k] = v
		}
		if p["size"] != nil {
			own["fontSize"] = p["size"]
		}
		if p["weight"] != nil {
			own["fontWeight"] = p["weight"]
		}
		if p["color"] != nil {
			own["foreground"] = p["color"]
		}
		runID := id
		href, _ := p["href"].(string)
		if kind != "a" {
			href = ""
		}
		onClick, _ := p["onClick"].(func())
		if onClick != nil || href != "" {
			runID, _ = p["id"].(string)
			if runID == "" {
				runID = textID + "/run:" + itoa(*runs)
				*runs++
			}
			c.claim(runID)
			disabled := truthy(p["disabled"])
			c.handlers[runID] = Handlers{"onClick": func() {
				if disabled {
					return
				}
				if onClick != nil {
					onClick()
				}
				if href != "" {
					OpenExternal(href)
				}
			}}
			c.order = append(c.order, runID)
		}
		c.collectInline(p["children"], computeRunStyle(style, c.resolveRun(own)), runID, textID, runs, out)
		return
	}
	if s, ok := jsString(child); ok {
		*out = append(*out, piece{text: s, style: style, id: id})
		return
	}
	panic("tarve: unsupported text child")
}

func itoa(n int) string { return formatNumber(float64(n)) }

// inlineText is a Text node's string and its runs.
func (c *compiler) inlineText(id string, children Child, whiteSpace string, base S) (string, []any) {
	transform := base["textTransform"]
	if transform != "uppercase" && transform != "lowercase" && transform != "capitalize" {
		if plain, ok := plainText(children); ok {
			if whiteSpace == "normal" || whiteSpace == "nowrap" {
				text := plain
				if needsCollapse(plain) {
					text = whiteSpaces.ReplaceAllString(plain, " ")
				}
				start, end := 0, len(text)
				if strings.HasPrefix(text, " ") {
					start = 1
				}
				if strings.HasSuffix(text, " ") && len(text) > 1 {
					end--
				}
				if start > end {
					return "", nil
				}
				return text[start:end], nil
			}
			if whiteSpace != "pre-line" {
				return plain, nil
			}
		}
	}
	var pieces []piece
	runCount := 0
	c.collectInline(children, base, "", id, &runCount, &pieces)
	collapse := whiteSpace == "normal" || whiteSpace == "nowrap" || whiteSpace == "pre-line"
	keepNewlines := whiteSpace != "normal" && whiteSpace != "nowrap"
	var text strings.Builder
	type run struct {
		start, end int
		style      S
		id         string
	}
	var runs []*run
	pending, lineStart, wordStart := false, true, true
	trimLineEnd := func() {
		s := text.String()
		if !strings.HasSuffix(s, " ") || !pending {
			return
		}
		text.Reset()
		text.WriteString(s[:len(s)-1])
		n := text.Len()
		for _, r := range runs {
			if r.end > n {
				r.end = n
			}
		}
		for len(runs) > 0 && runs[len(runs)-1].end <= runs[len(runs)-1].start {
			runs = runs[:len(runs)-1]
		}
	}
	for _, p := range pieces {
		if p.br {
			trimLineEnd()
			text.WriteByte('\n')
			pending, lineStart, wordStart = false, true, true
			continue
		}
		start := text.Len()
		source := strings.ReplaceAll(strings.ReplaceAll(p.text, "\r\n", "\n"), "\r", "\n")
		if !collapse {
			text.WriteString(transformText(source, p.style["textTransform"], wordStart))
			if source != "" {
				last, _ := utf8.DecodeLastRuneInString(source)
				wordStart = unicode.IsSpace(last)
			}
		} else {
			for _, r := range source {
				switch {
				case r == '\n' && keepNewlines:
					trimLineEnd()
					text.WriteByte('\n')
					pending, lineStart, wordStart = false, true, true
				case r == ' ' || r == '\t' || r == '\n' || r == '\f':
					if !lineStart && !pending {
						text.WriteByte(' ')
						pending, wordStart = true, true
					}
				default:
					pending = false
					text.WriteString(transformText(string(r), p.style["textTransform"], wordStart))
					wordStart, lineStart = false, false
				}
			}
		}
		style := S{}
		for _, k := range runKeys {
			if k == "textTransform" {
				continue
			}
			if p.style[k] != nil && !sameValue(p.style[k], base[k]) {
				style[k] = p.style[k]
			}
		}
		end := text.Len()
		if end > start && (len(style) > 0 || p.id != "") {
			if n := len(runs); n > 0 && runs[n-1].end == start && runs[n-1].id == p.id && sameValue(map[string]any(runs[n-1].style), map[string]any(style)) {
				runs[n-1].end = end
			} else {
				runs = append(runs, &run{start, end, style, p.id})
			}
		}
	}
	trimLineEnd()
	out := make([]any, len(runs))
	for i, r := range runs {
		m := S{"start": r.start, "end": r.end, "style": r.style}
		if r.id != "" {
			m["id"] = r.id
		}
		out[i] = m
	}
	return text.String(), out
}

var headingPreset = map[string][3]float64{"h1": {32, 700, 0.67}, "h2": {24, 700, 0.83}, "h3": {20, 600, 1}, "h4": {18, 600, 1.33}, "h5": {16, 600, 1.67}, "h6": {14, 600, 2.33}}

// expandIntrinsic turns HTML elements outside text into components: headings, p, span, phrasing
// elements (an anonymous Text around them) and img.
func expandIntrinsic(v *VNode, path string) Child {
	kind, ok := v.Type.(string)
	if !ok {
		return nil
	}
	p := v.Props
	if h, ok := headingPreset[kind]; ok {
		q := copyProps(p)
		if q["size"] == nil {
			q["size"] = h[0]
		}
		if q["weight"] == nil {
			q["weight"] = h[1]
		}
		q["uaMargin"] = h[2]
		return Text(q)
	}
	switch kind {
	case "div":
		q := Props{}
		var shorthands S
		for k, v := range p {
			switch k {
			case "gap", "padding", "flex", "align", "justify":
				if v != nil {
					if shorthands == nil {
						shorthands = S{}
					}
					shorthands[k] = v
				}
			case "style", "onMouseEnter", "onMouseLeave":
			default:
				q[k] = v
			}
		}
		style := merge(shorthands, canonicalizeIntrinsicStyle(styleOf(p)))
		if style["display"] == "flex" && style["direction"] == nil {
			style["direction"] = "row"
		}
		q["style"] = style
		enter, _ := p["onMouseEnter"].(func())
		leave, _ := p["onMouseLeave"].(func())
		if enter != nil || leave != nil {
			hover, _ := p["onHover"].(func(bool))
			q["onHover"] = func(in bool) {
				if hover != nil {
					hover(in)
				}
				if in && enter != nil {
					enter()
				} else if !in && leave != nil {
					leave()
				}
			}
		}
		kind := "view"
		if p["onClick"] != nil {
			kind = "pressable"
			if _, ok := p["focusable"]; !ok {
				q["focusable"] = false
			}
		}
		return &VNode{Type: kind, Props: q, Key: v.Key, native: true}
	case "span", "p":
		q := copyProps(p)
		if kind == "p" {
			q["uaMargin"] = 1.0
		}
		return Text(q)
	case "img":
		q := copyProps(p)
		s := styleOf(p)
		if q["fit"] == nil && s["objectFit"] != nil {
			fit := s["objectFit"]
			if fit == "scale-down" {
				fit = "contain"
			}
			q["fit"] = fit
		}
		q["style"] = canonicalizeIntrinsicStyle(s)
		return Image(q)
	}
	if _, ok := inlineTags[kind]; (ok || kind == "br") && !(kind == "code" && p["code"] != nil) {
		q := Props{"children": &VNode{Type: kind, Props: p, Key: v.Key, native: true}}
		if id, ok := p["id"]; ok {
			q["id"] = id
		}
		return Text(q)
	}
	return nil
}
