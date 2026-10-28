package tarve

import (
	"fmt"
	"math"
	"runtime"
	"strings"
)

// translucent is color at alpha (0–255), a hover wash of the bar's ink. Theme tokens (T.Foreground,
// the default ink) take the token alpha form and CSS colours are normalized first: returning the
// colour unchanged would paint the hover in the glyph's own colour and hide it.
func translucent(color string, alpha int) string {
	value := strings.TrimSpace(color)
	if strings.HasPrefix(value, "var(--") && strings.HasSuffix(value, ")") {
		return fmt.Sprintf("%s/%d", value, int(math.Round(float64(alpha)/255*100)))
	}
	h := strings.TrimPrefix(cssColor(value), "#")
	full := h
	if len(h) == 3 || len(h) == 4 {
		full = string([]byte{h[0], h[0], h[1], h[1], h[2], h[2]})
	} else if len(h) >= 6 {
		full = h[:6]
	}
	if len(full) == 6 && strings.Trim(strings.ToLower(full), "0123456789abcdef") == "" {
		return fmt.Sprintf("#%s%02x", full, alpha)
	}
	return fmt.Sprintf("#808080%02x", alpha)
}

// TitleBar props: title, height (40), showMinimize, showMaximize, showClose, buttonStyle, glass (bool or variant), appearance, style, children.
func TitleBar(p Props, kids ...Child) *VNode {
	p = props(p, kids)
	style := styleOf(p)
	buttonStyle, _ := p["buttonStyle"].(S)
	appearance := orString(p["appearance"], "light")
	glass := ""
	switch g := p["glass"].(type) {
	case bool:
		if g {
			glass = "regular"
		}
	case string:
		glass = g
	}
	radius := 0.0
	if r, ok := num(style["radius"]); ok {
		radius = r
	} else if m, ok := asMap(style["radius"]); ok {
		radius = math.Max(numberOr(m["topLeft"], 0), numberOr(m["topRight"], 0))
	}
	var surface S
	if glass != "" {
		shadow := radius > 0
		surface = glassSurface(glass, appearance, GlassOptions{Radius: &radius, Shadow: &shadow})
		if radius > 0 {
			surface["overflow"] = "hidden"
		} else {
			surface["borderWidth"] = S{"bottom": 1}
		}
		surface["foreground"] = "#1c1c1e"
		if appearance == "dark" {
			surface["foreground"] = "#ffffff"
		}
		buttonStyle = merge(S{"width": 36, "height": 36, "radius": 18}, buttonStyle)
	}
	ink := T.Foreground
	if f, ok := style["foreground"].(string); ok {
		ink = f
	} else if f, ok := surface["foreground"].(string); ok {
		ink = f
	}
	glyph := func(nodes ...SvgElement) *VNode {
		return Icon(Props{"iconNode": nodes, "size": 12, "strokeWidth": 2, "color": ink})
	}
	button := func(action string, child Child) Child {
		label := map[string]string{"minimize": "Minimize window", "toggleMaximize": "Maximize or restore window", "close": "Close window"}[action]
		hover, active := translucent(ink, 0x1f), translucent(ink, 0x33)
		if action == "close" {
			hover, active = T.WindowCloseHover, T.WindowCloseActive
		}
		return Pressable(Props{"windowAction": action, "control": S{"role": "button", "label": label}, "focusable": false,
			"style": merge(S{"width": 46, "height": "100%", "radius": 0, "align": "center", "justify": "center", "background": "#00000000",
				"group": action == "close", "hover": S{"background": hover}, "active": S{"background": active}}, buttonStyle), "children": child})
	}
	// Android has no window to minimize, maximize or close: TitleBar is the app's top bar there.
	mobile := runtime.GOOS == "android"
	flag := func(k string) bool {
		if v, ok := p[k].(bool); ok {
			return v
		}
		return !mobile
	}
	var minimize, maximize, closeB Child
	if flag("showMinimize") {
		minimize = button("minimize", glyph(Path("M3 12h18")))
	}
	if flag("showMaximize") {
		maximize = button("toggleMaximize", glyph(SvgEl("rect", "x", 3, "y", 3, "width", 18, "height", 18, "rx", 2)))
	}
	if flag("showClose") {
		// Close turns white over its red hover (as Windows draws it): the glyph follows the group.
		closeB = button("close", Icon(Props{"iconNode": []SvgElement{Path("M4 4l16 16M20 4 4 20")}, "size": 12, "strokeWidth": 2, "color": ink,
			"style": S{"groupHover": S{"foreground": "#ffffff"}}}))
	}
	controls := Row(Props{"style": S{"height": "100%", "shrink": 0}, "children": []Child{minimize, maximize, closeB}})
	content := p["children"]
	if content == nil && str(p, "title") != "" {
		tp := Props{"size": 13, "weight": 500, "children": p["title"]}
		if mobile {
			tp["size"], tp["weight"] = 18, 600
		}
		if glass != "" {
			tp["weight"], tp["color"] = 600, ink
		}
		content = Text(tp)
	}
	rest := Props{}
	for k, v := range p {
		switch k {
		case "title", "height", "showMinimize", "showMaximize", "showClose", "buttonStyle", "glass", "appearance", "children", "style":
		default:
			rest[k] = v
		}
	}
	rest["dragRegion"] = true
	height, padding := 40.0, 12
	if mobile {
		height, padding = 56, 16
	}
	base := S{"direction": "row", "height": numOr(p, "height", height), "shrink": 0, "padding": S{"left": padding}, "background": T.Card,
		"borderWidth": S{"bottom": 1}, "borderColor": T.Border, "justify": "between", "align": "center", "pointerEvents": "block"}
	if glass != "" {
		base["gap"], base["padding"] = 4, S{"left": 14, "right": 4}
	}
	rest["style"] = merge(base, surface, style)
	rest["children"] = []Child{content, controls}
	return container("titlebar", rest, nil)
}
