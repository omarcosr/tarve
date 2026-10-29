package tarve

const popupZ = 1000

func popupPosition(side string) S {
	const gap = 6
	switch side {
	case "top":
		return S{"bottom": "100%", "left": 0, "margin": S{"bottom": gap}}
	case "right":
		return S{"top": 0, "left": "100%", "margin": S{"left": gap}}
	case "left":
		return S{"top": 0, "right": "100%", "margin": S{"right": gap}}
	}
	return S{"top": "100%", "left": 0, "margin": S{"top": gap}}
}

func popupSurface(side string, style S) S {
	return merge(S{"position": "absolute", "zIndex": popupZ + 1, "minWidth": 180, "padding": 4, "background": T.Card, "borderWidth": 1,
		"borderColor": T.Border, "radius": RadiusMd, "pointerEvents": "block",
		"positionTryFallbacks": "flip-block, flip-inline, flip-block flip-inline"}, popupPosition(side), style)
}

func triggerLabel(label string, child Child) any {
	if label != "" {
		return label
	}
	if s, ok := jsString(child); ok {
		return s
	}
	return nil
}

type triggerOptions struct {
	id                    string
	disabled              any
	focusable             any
	rovingGroup           bool
	style                 S
	fallback, interactive S
	onClick, onEscape     func()
	onHover               func(bool)
	onKeyDown             func(string)
}

func chain0(a, b func()) any {
	switch {
	case a == nil && b == nil:
		return nil
	case a == nil:
		return b
	case b == nil:
		return a
	}
	return func() { a(); b() }
}

func interactiveTrigger(c Child) (*VNode, bool) {
	v, ok := c.(*VNode)
	if !ok || v == nil {
		return nil, false
	}
	switch v.Type {
	case "button", "pressable", "input", "textarea", "slider":
		return v, true
	}
	return nil, false
}

func popupTrigger(trigger Child, o triggerOptions) Child {
	v, ok := interactiveTrigger(trigger)
	if !ok {
		p := Props{"id": o.id, "disabled": o.disabled, "control": o.fallback, "style": merge(S{"background": "#00000000"}, o.style), "children": trigger}
		if o.focusable != nil {
			p["focusable"] = o.focusable
		}
		if o.rovingGroup {
			p["rovingGroup"] = true
		}
		if o.onClick != nil {
			p["onClick"] = o.onClick
		}
		if o.onHover != nil {
			p["onHover"] = o.onHover
		}
		if o.onEscape != nil {
			p["onEscape"] = o.onEscape
		}
		if o.onKeyDown != nil {
			p["onKeyDown"] = o.onKeyDown
		}
		return Pressable(p)
	}
	prev := v.Props
	p := copyProps(prev)
	if str(prev, "id") == "" {
		p["id"] = o.id
	}
	p["disabled"] = truthy(prev["disabled"]) || truthy(o.disabled)
	if o.rovingGroup {
		p["rovingGroup"] = true
	}
	control, _ := asMap(prev["control"])
	if o.interactive != nil {
		label := control["label"]
		control = merge(control, o.interactive)
		if label != nil {
			control["label"] = label
		} else {
			control["label"] = o.interactive["label"]
		}
	}
	if control != nil {
		p["control"] = control
	}
	if o.style != nil {
		p["style"] = merge(styleOf(prev), o.style)
	}
	pc, _ := prev["onClick"].(func())
	pe, _ := prev["onEscape"].(func())
	p["onClick"], p["onEscape"] = chain0(pc, o.onClick), chain0(pe, o.onEscape)
	if ph, _ := prev["onHover"].(func(bool)); ph != nil && o.onHover != nil {
		p["onHover"] = func(h bool) { ph(h); o.onHover(h) }
	} else if o.onHover != nil {
		p["onHover"] = o.onHover
	}
	if pk, _ := prev["onKeyDown"].(func(string)); pk != nil && o.onKeyDown != nil {
		p["onKeyDown"] = func(k string) { pk(k); o.onKeyDown(k) }
	} else if o.onKeyDown != nil {
		p["onKeyDown"] = o.onKeyDown
	}
	return &VNode{Type: v.Type, Props: p, Key: v.Key, native: v.native}
}

func tooltipLane(side string) S {
	const gap, maxWidth = 6, 320
	base := S{"position": "absolute", "zIndex": popupZ + 1, "pointerEvents": "auto"}
	switch side {
	case "top":
		return merge(base, S{"bottom": "100%", "left": 0, "right": -maxWidth, "align": "start", "margin": S{"bottom": gap}})
	case "right":
		return merge(base, S{"top": 0, "left": "100%", "right": -maxWidth - gap, "align": "start", "margin": S{"left": gap}})
	case "left":
		return merge(base, S{"top": 0, "right": "100%", "left": -maxWidth - gap, "align": "end", "margin": S{"right": gap}})
	}
	return merge(base, S{"top": "100%", "left": 0, "right": -maxWidth, "align": "start", "margin": S{"top": gap}})
}

type hoveredTooltip struct{ id string }

// Tooltip props: id, open (*bool or bool; unset follows hover), trigger, content, side ("top"), label, onOpenChange(bool), contentStyle, style.
func Tooltip(p Props) *VNode {
	id := str(p, "id")
	hover := scopedState("tarve.hoveredTooltip", func() *hoveredTooltip { return &hoveredTooltip{} })
	controlled, isControlled := p["open"].(bool)
	open := controlled
	if !isControlled {
		open = hover.id == id
	}
	content := p["content"]
	if s, ok := jsString(content); ok {
		content = Text(Props{"size": 12, "color": T.Background, "children": s})
	}
	onOpenChange, _ := p["onOpenChange"].(func(bool))
	side := orString(p["side"], "top")
	z := 0
	if open {
		z = popupZ
	}
	var lane Child
	if open {
		lane = View(Props{"id": id + "-lane", "portal": true, "style": tooltipLane(side), "children": View(Props{"id": id + "-content",
			"style": merge(popupSurface(side, merge(S{"minWidth": 0, "maxWidth": 320, "padding": S{"left": 8, "right": 8, "top": 5, "bottom": 5},
				"background": T.Foreground, "foreground": T.Background}, styleOf(Props{"style": p["contentStyle"]}))),
				S{"position": "relative", "top": nil, "right": nil, "bottom": nil, "left": nil, "margin": nil}),
			"children": content})})
	}
	return View(Props{"id": id, "style": merge(S{"position": "relative", "zIndex": z}, styleOf(p)), "children": []Child{
		popupTrigger(p["trigger"], triggerOptions{id: id + "-trigger", focusable: false,
			fallback: S{"role": "button", "label": triggerLabel(str(p, "label"), p["trigger"])},
			onHover: func(hovered bool) {
				if !isControlled {
					if hovered {
						hover.id = id
					} else if hover.id == id {
						hover.id = ""
					}
				}
				if onOpenChange != nil {
					onOpenChange(hovered)
				}
			}}),
		lane,
	}})
}

// DropdownMenuItem is one entry of a DropdownMenu.
type DropdownMenuItem struct {
	Value, Label, Icon, Shortcut string
	Disabled                     bool
	Checked                      *bool
}

// DropdownMenu props: id, open, trigger, items ([]DropdownMenuItem), label, side ("bottom"), disabled,
// onOpenChange(bool), onSelect(string), triggerStyle, contentStyle, style.
func DropdownMenu(p Props) *VNode {
	id := str(p, "id")
	open := truthy(p["open"])
	disabled := truthy(p["disabled"])
	items, _ := p["items"].([]DropdownMenuItem)
	seen := map[string]bool{}
	for _, it := range items {
		if seen[it.Value] {
			panic("tarve: DropdownMenu values must be unique")
		}
		seen[it.Value] = true
	}
	onOpenChange, _ := p["onOpenChange"].(func(bool))
	onSelect, _ := p["onSelect"].(func(string))
	setOpen := func(next bool) {
		if !disabled && onOpenChange != nil {
			onOpenChange(next)
		}
	}
	closeFn := func() { setOpen(false) }
	label := triggerLabel(str(p, "label"), p["trigger"])
	z := 0
	if open {
		z = popupZ
	}
	var content Child
	if open && !disabled {
		rows := make([]Child, len(items))
		for i, it := range items {
			it := it
			var icon Child
			if it.Checked != nil && *it.Checked {
				icon = Icon(Props{"name": "check", "size": 14})
			} else if it.Icon != "" {
				icon = Icon(Props{"name": it.Icon, "size": 14})
			}
			color := T.Foreground
			if it.Disabled {
				color = T.DisabledForeground
			}
			var shortcut Child
			if it.Shortcut != "" {
				shortcut = Text(Props{"size": 12, "color": T.MutedForeground, "children": it.Shortcut})
			}
			control := S{"role": "menuitem", "label": it.Label}
			if it.Checked != nil {
				control["checked"] = *it.Checked
			}
			ip := Props{"id": id + "-item-" + it.Value, "key": it.Value, "control": control,
				"style": S{"minHeight": 32, "padding": S{"left": 8, "right": 8}, "direction": "row", "align": "center", "justify": "between", "gap": 12,
					"radius": RadiusSm, "hover": S{"background": T.Muted}, "focus": S{"background": T.Muted}, "disabled": S{"foreground": T.DisabledForeground}},
				"children": []Child{Row(Props{"gap": 8, "children": []Child{icon, Text(Props{"color": color, "children": it.Label})}}), shortcut}}
			if it.Disabled {
				ip["disabled"] = true
			} else {
				ip["onClick"] = func() {
					if onSelect != nil {
						onSelect(it.Value)
					}
					closeFn()
				}
			}
			rows[i] = Pressable(ip)
		}
		cs, _ := p["contentStyle"].(S)
		content = Column(Props{"id": id + "-content", "portal": true, "dismissOnOutside": true, "onOutsideClick": closeFn,
			"style":    popupSurface(orString(p["side"], "bottom"), cs),
			"children": Scroll(Props{"id": id + "-scroll", "gap": 2, "style": S{"height": math_min(240, max(0, float64(len(items))*34))}, "children": rows})})
	}
	ts, _ := p["triggerStyle"].(S)
	fallback := S{"role": "button", "label": label, "expanded": open}
	return View(Props{"id": id, "control": S{"role": "navigation", "orientation": "vertical"},
		"style": merge(S{"position": "relative", "zIndex": z}, styleOf(p)), "children": []Child{
			popupTrigger(p["trigger"], triggerOptions{id: id + "-trigger", disabled: disabled, rovingGroup: true, style: ts,
				fallback: fallback, interactive: merge(fallback),
				onClick: func() { setOpen(!open) }, onEscape: closeFn,
				onKeyDown: func(key string) {
					switch key {
					case "Escape":
						closeFn()
					case "ArrowDown", "ArrowUp", "Home", "End":
						setOpen(true)
					}
				}}),
			content,
		}})
}

func math_min(a, b float64) float64 {
	if a < b {
		return a
	}
	return b
}
