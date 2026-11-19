package tarve

// Modal props: open, onOpenChange(bool), title, description, footer, width (480), closeOnOverlay, closeOnEscape, showClose, scrollBody (true), style, id.
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
		header = Column(Props{"gap": 6, "style": S{"shrink": 0, "padding": S{"right": right}}, "children": []Child{t, d}})
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
		footer = Row(Props{"gap": 8, "justify": "end", "style": S{"shrink": 0}, "children": p["footer"]})
	}
	// scrollBody (default true): the panel never grows past the window; title and footer stay put
	// and the body scrolls. Content that fits lays out as a plain column.
	body := p["children"]
	if scrollBody, ok := p["scrollBody"].(bool); (!ok || scrollBody) && body != nil && body != false {
		bp := Props{"style": S{"direction": "column", "gap": 20}, "children": body}
		if modalID != "" {
			bp["id"] = modalID + "-body"
		}
		body = Scroll(bp)
	}
	panel := Props{"modal": true, "style": merge(S{"position": "relative", "width": numOr(p, "width", 480), "maxWidth": "90%", "maxHeight": "100%", "background": T.Card,
		"borderWidth": 1, "borderColor": T.Border, "radius": RadiusLg, "padding": 24, "gap": 20, "pointerEvents": "block"}, styleOf(p)),
		"children": []Child{header, closeButton, body, footer}}
	if modalID != "" {
		panel["id"] = modalID + "-content"
	}
	if title != "" || description != "" {
		panel["control"] = S{"role": "group", "label": title, "description": description}
	}
	outer := Props{}
	for k, v := range p {
		switch k {
		case "open", "onOpenChange", "title", "description", "footer", "width", "closeOnOverlay", "closeOnEscape", "showClose", "scrollBody", "children", "style":
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
