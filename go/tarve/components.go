package tarve

import (
	"fmt"
	"math"
	"strings"
)

// container is @tarve/core container(): shorthand props (gap, padding, flex, align, justify) folded
// into the style. p is the component's own props (it takes them over).
func container(kind string, p Props, defaults S) *VNode {
	var merged S
	for _, k := range [...]string{"gap", "padding", "flex", "align", "justify"} {
		if v, ok := p[k]; ok {
			delete(p, k)
			if v == nil {
				continue
			}
			if merged == nil {
				merged = merge(defaults)
			}
			merged[k] = v
		}
	}
	style := styleOf(p)
	switch {
	case merged == nil && style == nil:
		merged = defaults
	case merged == nil:
		merged = merge(defaults, style)
	case style != nil:
		for k, v := range style {
			if v == nil {
				delete(merged, k)
			} else {
				merged[k] = v
			}
		}
	}
	if merged == nil {
		merged = emptyStyle
	}
	p["style"] = merged
	return jsx(kind, p)
}

var emptyStyle = S{}

// props gives a component its props: the caller's map (components own the props they are given,
// as JSX creates a fresh object per element) with the children added.
func props(p Props, kids []Child) Props {
	if p == nil {
		p = make(Props, 2)
	}
	if len(kids) > 0 {
		withChildren(p, kids)
	}
	return p
}

func View(p Props, kids ...Child) *VNode { return container("view", props(p, kids), nil) }
func Row(p Props, kids ...Child) *VNode {
	return container("row", props(p, kids), S{"direction": "row", "align": "center"})
}
func Column(p Props, kids ...Child) *VNode {
	return container("column", props(p, kids), S{"direction": "column"})
}

func Pressable(p Props, kids ...Child) *VNode {
	return container("pressable", props(p, kids), S{"radius": RadiusSm, "userSelect": "none"})
}

func Scroll(p Props, kids ...Child) *VNode {
	p = props(p, kids)
	speed := numOr(p, "speed", 1)
	orientation := orString(p["orientation"], "vertical")
	if math.IsInf(speed, 0) || math.IsNaN(speed) || speed <= 0 {
		panic("tarve: Scroll speed must be finite and greater than zero")
	}
	delete(p, "speed")
	delete(p, "orientation")
	p["scrollSpeed"], p["scrollOrientation"] = speed, orientation
	return container("scroll", p, S{"minHeight": 0, "shrink": 1, "scrollbarColor": T.Scrollbar})
}

// CloseRequest is the event a Window's onCloseRequest receives.
type CloseRequest struct{ defaultPrevented bool }

func (e *CloseRequest) PreventDefault()        { e.defaultPrevented = true }
func (e *CloseRequest) DefaultPrevented() bool { return e.defaultPrevented }

func Window(p Props, kids ...Child) *VNode {
	p = props(p, kids)
	bg := T.Background
	if b := str(p, "backdrop"); b != "" && b != "none" {
		bg = T.Background + "/0"
	}
	p["style"] = merge(S{"background": bg}, styleOf(p))
	return container("window", p, nil)
}

func canonicalizeState(v any) S {
	m, ok := asMap(v)
	if !ok {
		return nil
	}
	out := merge(m)
	if out["background"] == nil && out["backgroundColor"] != nil {
		out["background"] = out["backgroundColor"]
	}
	if out["foreground"] == nil && out["color"] != nil {
		out["foreground"] = out["color"]
	}
	delete(out, "backgroundColor")
	delete(out, "color")
	return out
}

var edgeNames = map[string]string{"flex-start": "start", "flex-end": "end", "space-between": "between", "space-around": "around", "space-evenly": "evenly"}

func edge(v any) any {
	if s, ok := v.(string); ok {
		if e, ok := edgeNames[s]; ok {
			return e
		}
	}
	return v
}

// canonicalizeIntrinsicStyle maps CSS-style aliases (color, backgroundColor, borderRadius…) to Tarve's keys.
func canonicalizeIntrinsicStyle(style S) S {
	out := merge(style)
	alias := func(to, from string) {
		if out[to] == nil && out[from] != nil {
			out[to] = out[from]
		}
	}
	alias("direction", "flexDirection")
	alias("background", "backgroundColor")
	alias("foreground", "color")
	alias("radius", "borderRadius")
	if out["align"] == nil && out["alignItems"] != nil {
		out["align"] = edge(out["alignItems"])
	}
	if out["justify"] == nil && out["justifyContent"] != nil {
		out["justify"] = edge(out["justifyContent"])
	}
	for _, k := range []string{"borderRadius", "alignItems", "justifyContent", "objectFit", "flexDirection", "backgroundColor", "color"} {
		delete(out, k)
	}
	for _, k := range stateKeys {
		if c := canonicalizeState(style[k]); c != nil {
			out[k] = c
		}
	}
	if d, ok := asMap(style["dark"]); ok {
		out["dark"] = canonicalizeIntrinsicStyle(d)
	}
	return out
}

func hasAliases(style S) bool {
	for k, v := range style {
		switch k {
		case "flexDirection", "backgroundColor", "color", "borderRadius", "alignItems", "justifyContent", "objectFit", "dark":
			return true
		case "hover", "focus", "focusVisible", "active", "disabled":
			if m, ok := asMap(v); ok && (m["backgroundColor"] != nil || m["color"] != nil) {
				return true
			}
		}
	}
	return false
}

// Text props: size, weight, color, style, id, children.
func Text(p Props, kids ...Child) *VNode {
	p = props(p, kids)
	var style S
	if v := p["size"]; v != nil || p["weight"] != nil || p["color"] != nil {
		style = S{}
	}
	if v := p["size"]; v != nil {
		style["fontSize"] = v
	}
	if v := p["weight"]; v != nil {
		style["fontWeight"] = v
	}
	if v := p["color"]; v != nil {
		style["foreground"] = v
	}
	given := styleOf(p)
	delete(p, "size")
	delete(p, "weight")
	delete(p, "color")
	if hasAliases(given) {
		given = canonicalizeIntrinsicStyle(given)
	}
	switch {
	case len(style) == 0 && given == nil:
		p["style"] = emptyStyle
	case given == nil:
		p["style"] = style
	default:
		p["style"] = merge(style, given)
	}
	return jsx("text", p)
}

var buttonVariants = map[string]S{
	"default":     {"background": T.Primary, "foreground": T.PrimaryForeground, "hover": S{"background": T.PrimaryHover}, "active": S{"background": T.PrimaryActive}},
	"secondary":   {"background": T.Secondary, "foreground": T.SecondaryForeground, "hover": S{"background": T.SecondaryHover}, "active": S{"background": T.SecondaryActive}},
	"outline":     {"background": T.Input, "foreground": T.Foreground, "borderColor": T.Border, "borderWidth": 1, "hover": S{"background": T.Muted}, "active": S{"background": T.SecondaryActive}},
	"ghost":       {"background": "#00000000", "foreground": T.Foreground, "hover": S{"background": T.Muted}, "active": S{"background": T.SecondaryActive}},
	"destructive": {"background": T.Destructive, "foreground": T.DestructiveForeground, "hover": S{"background": T.DestructiveHover}, "active": S{"background": T.DestructiveActive}},
}

func textOnly(c Child) bool {
	switch v := c.(type) {
	case nil, bool, string:
		return true
	case []Child:
		for _, x := range v {
			if !textOnly(x) {
				return false
			}
		}
		return true
	}
	_, ok := num(c)
	return ok
}

type buttonKey struct{ variant, size string }

var buttonBases = map[buttonKey]S{}

func buttonBase(variant, size string) S {
	k := buttonKey{variant, size}
	if s, ok := buttonBases[k]; ok {
		return s
	}
	height := map[string]float64{"sm": 32, "default": 36, "lg": 40}[size]
	s := merge(S{"height": height, "padding": S{"left": 14, "right": 14}, "radius": RadiusSm, "fontSize": 14, "lineHeight": LineHeight,
		"fontWeight": 500, "userSelect": "none", "align": "center", "justify": "center",
		"disabled": S{"background": T.Disabled, "foreground": T.DisabledForeground}, "shrink": 0}, buttonVariants[variant])
	buttonBases[k] = s
	return s
}

// Button props: variant (default, secondary, outline, ghost, destructive), size (sm, default, lg), disabled, control, onClick.
func Button(p Props, kids ...Child) *VNode {
	p = props(p, kids)
	variant := orString(p["variant"], "default")
	size := orString(p["size"], "default")
	style := buttonBase(variant, size)
	if s := styleOf(p); s != nil {
		style = merge(style, s)
	}
	rest := p
	delete(rest, "variant")
	delete(rest, "size")
	delete(rest, "style")
	if textOnly(p["children"]) {
		rest["style"] = style
		v := jsx("button", rest)
		v.native = true
		return v
	}
	label := strings.Join(strings.Fields(accessibleText(p["children"])), " ")
	control, _ := asMap(p["control"])
	if control != nil {
		control = merge(control)
		if !truthy(control["label"]) && label != "" {
			control["label"] = label
		}
	} else {
		control = S{"role": "button"}
		if label != "" {
			control["label"] = label
		}
	}
	paint := style["foreground"]
	if truthy(p["disabled"]) {
		if d, ok := asMap(style["disabled"]); ok && d["foreground"] != nil {
			paint = d["foreground"]
		}
	}
	foreground, _ := paint.(string)
	if foreground == "" {
		foreground = T.Foreground
	}
	rest["children"] = composedContent(p["children"], foreground)
	rest["control"] = control
	rest["style"] = merge(S{"direction": "row", "gap": 8}, style)
	v := jsx("pressable", rest)
	v.native = true
	return v
}

func accessibleText(c Child) string {
	var parts []string
	var walk func(Child)
	walk = func(c Child) {
		switch v := c.(type) {
		case []Child:
			for _, x := range v {
				walk(x)
			}
		case *VNode:
			if v != nil {
				walk(v.Props["children"])
			}
		default:
			if s, ok := jsString(c); ok {
				parts = append(parts, s)
			}
		}
	}
	walk(c)
	return strings.Join(parts, " ")
}

func composedContent(c Child, foreground string) Child {
	switch v := c.(type) {
	case nil, bool:
		return c
	case []Child:
		out := make([]Child, len(v))
		for i, x := range v {
			out[i] = composedContent(x, foreground)
		}
		return out
	case *VNode:
		if v == nil {
			return c
		}
		if v.Type == "text" {
			s := styleOf(v.Props)
			p := copyProps(v.Props)
			p["style"] = merge(S{"fontSize": 14, "lineHeight": LineHeight, "fontWeight": 500, "foreground": foreground}, s)
			return &VNode{Type: v.Type, Props: p, Key: v.Key, native: v.native}
		}
		if v.Props["children"] == nil {
			return c
		}
		p := copyProps(v.Props)
		p["children"] = composedContent(v.Props["children"], foreground)
		return &VNode{Type: v.Type, Props: p, Key: v.Key, native: v.native}
	}
	return Text(Props{"size": 14, "weight": 500, "color": foreground, "children": c})
}

// SvgElement is one geometry element of an Svg: a tag and its attributes, in order.
type SvgElement struct {
	Tag      string
	Attrs    []any
	Children []SvgElement
}

// Path is <path d=…/>; extra are attribute name/value pairs.
func Path(d string, extra ...any) SvgElement {
	return SvgElement{Tag: "path", Attrs: append([]any{"d", d}, extra...)}
}

// SvgEl is any geometry element: SvgEl("circle", "cx", 12, "cy", 12, "r", 8).
func SvgEl(tag string, attrs ...any) SvgElement { return SvgElement{Tag: tag, Attrs: attrs} }

func xmlEscape(v any) string {
	s, ok := jsString(v)
	if !ok {
		s = fmt.Sprint(v)
	}
	return strings.NewReplacer("&", "&amp;", "\"", "&quot;", "<", "&lt;", ">", "&gt;").Replace(s)
}

func svgAttributeName(name string) string { return cssName(name) }

func (e SvgElement) serialize(b *strings.Builder) {
	b.WriteString("<" + e.Tag)
	for i := 0; i+1 < len(e.Attrs); i += 2 {
		name := e.Attrs[i].(string)
		if name == "key" || e.Attrs[i+1] == nil {
			continue
		}
		b.WriteString(" " + svgAttributeName(name) + "=\"" + xmlEscape(e.Attrs[i+1]) + "\"")
	}
	if len(e.Children) > 0 {
		b.WriteString(">")
		for _, c := range e.Children {
			c.serialize(b)
		}
		b.WriteString("</" + e.Tag + ">")
		return
	}
	b.WriteString("/>")
}

// Svg props: size, width, height, viewBox ([4]float64 or "0 0 24 24"), color, fill, stroke, strokeWidth,
// strokeLinecap, strokeLinejoin, style. Children are SvgElements.
func Svg(p Props, elements ...SvgElement) *VNode {
	viewBox := [4]float64{0, 0, 24, 24}
	switch v := p["viewBox"].(type) {
	case [4]float64:
		viewBox = v
	case string:
		fields := strings.FieldsFunc(v, func(r rune) bool { return r == ' ' || r == ',' })
		if len(fields) != 4 {
			panic("tarve: invalid Svg viewBox: " + v)
		}
		for i, f := range fields {
			fmt.Sscan(f, &viewBox[i])
		}
	}
	if !(viewBox[2] > 0) || !(viewBox[3] > 0) {
		panic("tarve: Svg viewBox width/height must be positive")
	}
	color := p["color"]
	if color == nil {
		color = T.Foreground
	}
	fill, stroke := orString(p["fill"], "none"), orString(p["stroke"], "currentColor")
	strokeWidth := numOr(p, "strokeWidth", 2)
	var b strings.Builder
	vb := make([]string, 4)
	for i, f := range viewBox {
		vb[i] = formatNumber(f)
	}
	b.WriteString(`<svg xmlns="http://www.w3.org/2000/svg" width="` + vb[2] + `" height="` + vb[3] + `"`)
	b.WriteString(` viewBox="` + strings.Join(vb, " ") + `" color="#000000" data-tarve-current-color="1"`)
	b.WriteString(` fill="` + xmlEscape(fill) + `" stroke="` + xmlEscape(stroke) + `" stroke-width="` + formatNumber(strokeWidth) + `"`)
	b.WriteString(` stroke-linecap="` + orString(p["strokeLinecap"], "round") + `" stroke-linejoin="` + orString(p["strokeLinejoin"], "round") + `">`)
	for _, e := range elements {
		e.serialize(&b)
	}
	b.WriteString("</svg>")
	w, h := p["size"], p["size"]
	if w == nil {
		w = p["width"]
	}
	if h == nil {
		h = p["height"]
	}
	if w == nil {
		w = 24
	}
	if h == nil {
		h = 24
	}
	rest := Props{}
	for k, v := range p {
		switch k {
		case "size", "width", "height", "viewBox", "color", "fill", "stroke", "strokeWidth", "strokeLinecap", "strokeLinejoin", "style", "children":
		default:
			rest[k] = v
		}
	}
	rest["style"] = merge(S{"width": w, "height": h, "shrink": 0, "foreground": color}, styleOf(p))
	rest["svg"] = b.String()
	return nativeJsx("svg", rest)
}

// IconNodes are @tarve/core's built-in icons.
var IconNodes = map[string][]SvgElement{
	"check":         {Path("M20 6 9 17l-5-5")},
	"x":             {Path("M18 6 6 18M6 6l12 12")},
	"plus":          {Path("M5 12h14M12 5v14")},
	"minus":         {Path("M5 12h14")},
	"chevron-down":  {Path("m6 9 6 6 6-6")},
	"chevron-up":    {Path("m18 15-6-6-6 6")},
	"chevron-right": {Path("m9 18 6-6-6-6")},
	"chevron-left":  {Path("m15 18-6-6 6-6")},
	"search":        {SvgEl("circle", "cx", 11, "cy", 11, "r", 8), Path("m21 21-4.3-4.3")},
	"info":          {SvgEl("circle", "cx", 12, "cy", 12, "r", 10), Path("M12 16v-4M12 8h.01")},
	"house":         {Path("M3 10.8 12 3l9 7.8V21h-6v-7H9v7H3z")},
	"user":          {SvgEl("circle", "cx", 12, "cy", 8, "r", 4), Path("M4 21a8 8 0 0 1 16 0")},
	"heart":         {Path("M20.8 4.6a5.5 5.5 0 0 0-7.8 0L12 5.7l-1-1.1a5.5 5.5 0 0 0-7.8 7.8L12 21l8.8-8.6a5.5 5.5 0 0 0 0-7.8z")},
	"play":          {SvgEl("polygon", "points", "6 3 20 12 6 21 6 3")},
	"pause":         {SvgEl("rect", "x", 14, "y", 4, "width", 4, "height", 16, "rx", 1), SvgEl("rect", "x", 6, "y", 4, "width", 4, "height", 16, "rx", 1)},
}

// Icon props: name or iconNode ([]SvgElement), size (16), color, strokeWidth (1.75), style.
func Icon(p Props) *VNode {
	nodes, _ := p["iconNode"].([]SvgElement)
	if nodes == nil {
		nodes = IconNodes[str(p, "name")]
	}
	if nodes == nil {
		panic("tarve: Icon requires either name or iconNode")
	}
	q := Props{}
	for k, v := range p {
		if k != "name" && k != "iconNode" {
			q[k] = v
		}
	}
	q["size"] = numOr(p, "size", 16)
	if q["color"] == nil {
		q["color"] = T.Foreground
	}
	q["strokeWidth"] = numOr(p, "strokeWidth", 1.75)
	q["viewBox"], q["fill"], q["stroke"] = [4]float64{0, 0, 24, 24}, "none", "currentColor"
	return Svg(q, nodes...)
}

// Image props: src (path or URL), width, height, fit, style.
func Image(p Props) *VNode {
	rest := Props{}
	for k, v := range p {
		if k != "width" && k != "height" && k != "style" {
			rest[k] = v
		}
	}
	rest["style"] = merge(S{"width": p["width"], "height": p["height"], "radius": RadiusMd, "placeholderBackground": T.ImagePlaceholder}, styleOf(p))
	return jsx("image", rest)
}

var inputTypes = set("text", "password", "email", "number", "search", "tel", "url")

// Input props: type, value, placeholder, disabled, onChange(string), onSubmit(string), style.
func Input(p Props) *VNode {
	t := orString(p["type"], "text")
	if !inputTypes[t] {
		panic("tarve: unsupported Input type: " + t)
	}
	rest := Props{}
	for k, v := range p {
		if k != "type" && k != "style" {
			rest[k] = v
		}
	}
	rest["inputType"] = t
	rest["style"] = merge(S{"height": 38, "minWidth": 120, "padding": S{"left": 12, "right": 12}, "radius": RadiusSm, "borderWidth": 1,
		"borderColor": T.Border, "background": T.Input, "foreground": T.Foreground, "placeholderColor": T.Placeholder,
		"selectionColor": T.Selection, "caretColor": T.Foreground, "lineHeight": LineHeight, "fontSize": FontSize, "userSelect": "text"}, styleOf(p))
	return nativeJsx("input", rest)
}

// Modal props: open, onOpenChange(bool), title, description, footer, width (480), closeOnOverlay, closeOnEscape, showClose, style, id.
func Modal(p Props, kids ...Child) *VNode {
	p = props(p, kids)
	if !truthy(p["open"]) {
		return Fragment()
	}
	onOpenChange, _ := p["onOpenChange"].(func(bool))
	closeFn := func() {
		if onOpenChange != nil {
			onOpenChange(false)
		}
	}
	flag := func(k string) bool {
		if v, ok := p[k].(bool); ok {
			return v
		}
		return true
	}
	showClose := flag("showClose")
	title, description := str(p, "title"), str(p, "description")
	modalID := str(p, "id")
	var header Child
	if title != "" || description != "" {
		var t, d Child
		if title != "" {
			t = Text(Props{"size": 18, "weight": 600, "children": title})
		}
		if description != "" {
			d = Text(Props{"size": 14, "color": T.MutedForeground, "children": description})
		}
		right := 0
		if showClose {
			right = 28
		}
		header = Column(Props{"gap": 6, "style": S{"padding": S{"right": right}}, "children": []Child{t, d}})
	}
	var closeButton Child
	if showClose {
		bp := Props{"onClick": closeFn, "control": S{"role": "button", "label": "Close dialog"},
			"style": S{"position": "absolute", "top": 14, "right": 14, "width": 30, "height": 30, "radius": RadiusSm, "align": "center", "justify": "center",
				"background": "#00000000", "hover": S{"background": T.Muted}, "active": S{"background": T.Border}},
			"children": Icon(Props{"name": "x", "size": 16, "color": T.MutedForeground})}
		if modalID != "" {
			bp["id"] = modalID + "-close"
		}
		closeButton = Pressable(bp)
	}
	var footer Child
	if truthy(p["footer"]) {
		footer = Row(Props{"gap": 8, "justify": "end", "children": p["footer"]})
	}
	panel := Props{"modal": true, "style": merge(S{"position": "relative", "width": numOr(p, "width", 480), "maxWidth": "90%", "background": T.Card,
		"borderWidth": 1, "borderColor": T.Border, "radius": RadiusLg, "padding": 24, "gap": 20, "pointerEvents": "block"}, styleOf(p)),
		"children": []Child{header, closeButton, p["children"], footer}}
	if modalID != "" {
		panel["id"] = modalID + "-content"
	}
	if title != "" || description != "" {
		panel["control"] = S{"role": "group", "label": title, "description": description}
	}
	outer := Props{}
	for k, v := range p {
		switch k {
		case "open", "onOpenChange", "title", "description", "footer", "width", "closeOnOverlay", "closeOnEscape", "showClose", "children", "style":
		default:
			outer[k] = v
		}
	}
	outer["portal"], outer["focusable"] = true, false
	if flag("closeOnOverlay") {
		outer["onClick"] = closeFn
	}
	if flag("closeOnEscape") {
		outer["onEscape"] = closeFn
	}
	outer["style"] = S{"position": "absolute", "top": 0, "right": 0, "bottom": 0, "left": 0, "padding": 24, "align": "center", "justify": "center",
		"background": T.Overlay, "pointerEvents": "block"}
	outer["children"] = Column(panel)
	return Pressable(outer)
}

// Slider props: value, min (0), max (100), step (1), label, orientation, disabled, onValueChange(float64), style.
func Slider(p Props) *VNode {
	value := numOr(p, "value", math.NaN())
	lo, hi, step := numOr(p, "min", 0), numOr(p, "max", 100), numOr(p, "step", 1)
	for _, f := range []float64{value, lo, hi, step} {
		if math.IsNaN(f) || math.IsInf(f, 0) {
			panic("tarve: Slider requires finite values")
		}
	}
	if hi <= lo || step <= 0 {
		panic("tarve: Slider requires max > min and step > 0")
	}
	orientation := orString(p["orientation"], "horizontal")
	rest := Props{}
	for k, v := range p {
		switch k {
		case "value", "min", "max", "step", "label", "orientation", "style":
		default:
			rest[k] = v
		}
	}
	rest["control"] = S{"role": "slider", "label": p["label"], "orientation": orientation, "value": math.Max(lo, math.Min(value, hi)), "min": lo, "max": hi, "step": step}
	w, h := 160, 24
	if orientation != "horizontal" {
		w, h = 24, 160
	}
	fg := T.Primary
	if truthy(p["disabled"]) {
		fg = T.DisabledForeground
	}
	rest["style"] = merge(S{"width": w, "height": h, "shrink": 0, "foreground": fg, "borderColor": T.Border, "thumbColor": T.SliderThumb}, styleOf(p))
	return jsx("slider", rest)
}
