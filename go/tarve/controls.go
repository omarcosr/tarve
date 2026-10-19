package tarve

import "math"

// Form and display controls of @tarve/core (controls.ts, rich-content.ts, link.ts, input.ts).

func without(p Props, keys ...string) Props {
	for _, k := range keys {
		delete(p, k)
	}
	return p
}

func foregroundOr(style S, fallback string) any {
	if f, ok := style["foreground"].(string); ok {
		return f
	}
	return fallback
}

// Checkbox props: checked, label, disabled, onCheckedChange(bool), style.
func Checkbox(p Props) *VNode {
	checked, label, disabled := p["checked"] == true, str(p, "label"), p["disabled"]
	onChange, _ := p["onCheckedChange"].(func(bool))
	style := styleOf(p)
	border, bg, ink := T.Border, T.Input, "#00000000"
	if checked {
		border, bg, ink = T.Primary, T.Primary, T.PrimaryForeground
	}
	color := foregroundOr(style, T.Foreground)
	if truthy(disabled) {
		color = T.DisabledForeground
	}
	q := without(p, "checked", "label", "onCheckedChange", "style")
	q["disabled"], q["control"] = disabled, S{"role": "checkbox", "label": label, "checked": checked}
	q["onClick"] = func() {
		if onChange != nil {
			onChange(!checked)
		}
	}
	q["style"] = merge(S{"direction": "row", "align": "center", "gap": 9, "minHeight": 28}, style)
	q["children"] = []Child{
		View(Props{"style": S{"width": 18, "height": 18, "shrink": 0, "radius": 4, "borderWidth": 1, "borderColor": border, "background": bg, "justify": "center", "align": "center"},
			"children": Icon(Props{"name": "check", "size": 14, "color": ink})}),
		Text(Props{"color": color, "children": label}),
	}
	return Pressable(q)
}

// Switch props: checked, label, disabled, onCheckedChange(bool), style.
func Switch(p Props) *VNode {
	checked, label, disabled := p["checked"] == true, str(p, "label"), p["disabled"]
	onChange, _ := p["onCheckedChange"].(func(bool))
	style := styleOf(p)
	track := T.Border
	if truthy(disabled) {
		track = T.Disabled
	} else if checked {
		track = T.Primary
	}
	left := 2
	if checked {
		left = 18
	}
	color := foregroundOr(style, T.Foreground)
	if truthy(disabled) {
		color = T.DisabledForeground
	}
	q := without(p, "checked", "label", "onCheckedChange", "style")
	q["disabled"], q["control"] = disabled, S{"role": "switch", "label": label, "checked": checked}
	q["onClick"] = func() {
		if onChange != nil {
			onChange(!checked)
		}
	}
	q["style"] = merge(S{"direction": "row", "align": "center", "gap": 9, "minHeight": 28}, style)
	q["children"] = []Child{
		View(Props{"style": S{"position": "relative", "width": 36, "height": 20, "shrink": 0, "radius": 10, "background": track},
			"children": View(Props{"style": S{"position": "absolute", "top": 2, "left": left, "width": 16, "height": 16, "radius": 8, "background": T.SliderThumb}})}),
		Text(Props{"color": color, "children": label}),
	}
	return Pressable(q)
}

// RadioOption is one choice of a RadioGroup.
type RadioOption struct {
	Value, Label string
	Disabled     bool
}

// RadioGroup props: value, options ([]RadioOption), orientation, disabled, onValueChange(string), style.
func RadioGroup(p Props) *VNode {
	value := str(p, "value")
	options, _ := p["options"].([]RadioOption)
	orientation := orString(p["orientation"], "vertical")
	disabled := truthy(p["disabled"])
	onChange, _ := p["onValueChange"].(func(string))
	kids := make([]Child, len(options))
	for i, o := range options {
		o := o
		selected := o.Value == value
		inactive := disabled || o.Disabled
		bw, bc := 1, T.Border
		if selected {
			bw, bc = 5, T.Primary
		}
		color := T.Foreground
		if inactive {
			color = T.DisabledForeground
		}
		kids[i] = Pressable(Props{"key": o.Value, "disabled": trueOrNil(inactive), "control": S{"role": "radio", "label": o.Label, "checked": selected},
			"onClick": func() {
				if onChange != nil {
					onChange(o.Value)
				}
			},
			"style": S{"direction": "row", "align": "center", "gap": 9, "minHeight": 28},
			"children": []Child{
				View(Props{"style": S{"width": 18, "height": 18, "shrink": 0, "radius": 9, "borderWidth": bw, "borderColor": bc, "background": T.Input}}),
				Text(Props{"color": color, "children": o.Label}),
			}})
	}
	q := without(p, "value", "options", "orientation", "disabled", "onValueChange")
	q["control"], q["gap"], q["children"] = S{"role": "radiogroup", "orientation": orientation}, 8, kids
	if orientation == "horizontal" {
		return Row(q)
	}
	return Column(q)
}

// Card props: title, description, footer, style, children.
func Card(p Props, kids ...Child) *VNode {
	p = props(p, kids)
	var head, footer Child
	if t, d := str(p, "title"), str(p, "description"); t != "" || d != "" {
		var tn, dn Child
		if t != "" {
			tn = Text(Props{"size": 17, "weight": 600, "children": t})
		}
		if d != "" {
			dn = Text(Props{"size": 13, "color": T.MutedForeground, "children": d})
		}
		head = Column(Props{"gap": 4, "children": []Child{tn, dn}})
	}
	if truthy(p["footer"]) {
		footer = Row(Props{"gap": 8, "justify": "end", "children": p["footer"]})
	}
	children := p["children"]
	q := without(p, "title", "description", "footer")
	q["gap"] = 18
	q["style"] = merge(S{"background": T.Card, "borderWidth": 1, "borderColor": T.Border, "radius": RadiusLg, "padding": 22}, styleOf(p))
	q["children"] = []Child{head, children, footer}
	return Column(q)
}

var badgeVariants = map[string]S{
	"default":     {"background": T.Primary, "foreground": T.PrimaryForeground},
	"secondary":   {"background": T.Secondary, "foreground": T.SecondaryForeground},
	"outline":     {"background": T.Card, "foreground": T.Foreground, "borderWidth": 1, "borderColor": T.Border},
	"destructive": {"background": T.Destructive, "foreground": T.DestructiveForeground},
}

// Badge props: variant (default, secondary, outline, destructive), style, children.
func Badge(p Props, kids ...Child) *VNode {
	p = props(p, kids)
	variant := badgeVariants[orString(p["variant"], "default")]
	style := styleOf(p)
	color := style["foreground"]
	if color == nil {
		color = variant["foreground"]
	}
	children := p["children"]
	q := without(p, "variant")
	q["style"] = merge(S{"padding": S{"left": 8, "right": 8, "top": 3, "bottom": 3}, "radius": RadiusSm, "shrink": 0}, variant, style)
	q["children"] = Text(Props{"size": 12, "weight": 500, "color": color, "children": children})
	return View(q)
}

// Separator props: orientation, style.
func Separator(p Props) *VNode {
	horizontal := orString(p["orientation"], "horizontal") == "horizontal"
	var w, h any = "100%", 1
	if !horizontal {
		w, h = 1, "100%"
	}
	q := without(p, "orientation")
	q["style"] = merge(S{"width": w, "height": h, "shrink": 0, "background": T.Border}, styleOf(p))
	return View(q)
}

// Progress props: value, max (100), label, style (foreground paints the bar).
func Progress(p Props) *VNode {
	value, maxV := numOr(p, "value", 0), numOr(p, "max", 100)
	ratio := 0.0
	if !math.IsNaN(value) && !math.IsInf(value, 0) && !math.IsInf(maxV, 0) && maxV > 0 {
		ratio = math.Max(0, math.Min(value/maxV, 1))
	}
	track := merge(styleOf(p))
	fg := track["foreground"]
	delete(track, "foreground")
	if fg == nil {
		fg = T.Primary
	}
	radius := track["radius"]
	if radius == nil {
		radius = 4
	}
	label := p["label"]
	q := without(p, "value", "max", "label")
	q["control"] = S{"role": "progress", "label": label, "value": ratio * maxV, "min": 0, "max": maxV}
	q["style"] = merge(S{"width": "100%", "height": 8, "radius": 4, "background": T.Secondary}, track)
	q["children"] = View(Props{"style": S{"width": formatNumber(ratio*100) + "%", "height": "100%", "radius": radius, "background": fg}})
	return View(q)
}

// TabItem is one tab of Tabs.
type TabItem struct {
	Value, Label string
	Content      Child
	Disabled     bool
}

// Tabs props: value, items ([]TabItem), onValueChange(string), style.
func Tabs(p Props) *VNode {
	value := str(p, "value")
	items, _ := p["items"].([]TabItem)
	onChange, _ := p["onValueChange"].(func(string))
	var content Child
	tabs := make([]Child, len(items))
	for i, it := range items {
		it := it
		if it.Value == value && content == nil {
			content = it.Content
		}
		bg, hover := "#00000000", T.SecondaryHover
		if it.Value == value {
			bg, hover = T.Card, T.Card
		}
		color := T.Foreground
		if it.Disabled {
			color = T.DisabledForeground
		}
		tabs[i] = Pressable(Props{"key": it.Value, "disabled": trueOrNil(it.Disabled), "control": S{"role": "tab", "label": it.Label, "selected": it.Value == value},
			"onClick": func() {
				if onChange != nil {
					onChange(it.Value)
				}
			},
			"style":    S{"height": 32, "padding": S{"left": 12, "right": 12}, "align": "center", "justify": "center", "background": bg, "hover": S{"background": hover}},
			"children": Text(Props{"size": 13, "weight": 500, "color": color, "children": it.Label})})
	}
	q := without(p, "value", "items", "onValueChange")
	q["gap"] = 14
	q["children"] = []Child{Row(Props{"gap": 4, "control": S{"role": "tablist"}, "style": S{"padding": 4, "background": T.Muted, "radius": RadiusMd}, "children": tabs}), content}
	return Column(q)
}

// AccordionItem is one section of an Accordion.
type AccordionItem struct {
	Value, Title string
	Content      Child
	Disabled     bool
}

// Accordion props: value ("" when all closed), items ([]AccordionItem), onValueChange(string), style.
func Accordion(p Props) *VNode {
	value := str(p, "value")
	items, _ := p["items"].([]AccordionItem)
	onChange, _ := p["onValueChange"].(func(string))
	rows := make([]Child, len(items))
	for i, it := range items {
		it := it
		open := value != "" && value == it.Value
		icon := "chevron-down"
		if open {
			icon = "chevron-up"
		}
		var body Child
		if open {
			body = Column(Props{"style": S{"padding": S{"bottom": 16}}, "children": it.Content})
		}
		rows[i] = Column(Props{"key": it.Value, "style": S{"borderWidth": S{"bottom": 1}, "borderColor": T.Border}, "children": []Child{
			Pressable(Props{"disabled": trueOrNil(it.Disabled), "control": S{"role": "button", "label": it.Title, "expanded": open},
				"onClick": func() {
					if onChange != nil {
						if open {
							onChange("")
						} else {
							onChange(it.Value)
						}
					}
				},
				"style":    S{"direction": "row", "minHeight": 44, "align": "center", "justify": "between", "hover": S{"foreground": T.MutedForeground}},
				"children": []Child{Text(Props{"weight": 500, "children": it.Title}), Icon(Props{"name": icon, "size": 16})}}),
			body,
		}})
	}
	q := without(p, "value", "items", "onValueChange")
	q["children"] = rows
	return Column(q)
}

// Markdown props: source, onLinkClick(href) (default: open it), syntaxTheme, style.
func Markdown(p Props) *VNode {
	onLink, _ := p["onLinkClick"].(func(string))
	q := copyProps(p)
	q["onMarkdownLink"] = func(href string) {
		if onLink != nil {
			onLink(href)
		} else {
			OpenExternal(href)
		}
	}
	q["style"] = merge(S{"mutedForeground": T.MutedForeground, "taskMarkerColor": T.Primary, "taskMarkerCheckColor": T.PrimaryForeground,
		"markdownCodeBackground": T.Muted, "markdownCodeColor": T.Foreground, "markdownQuoteBackground": T.Muted, "markdownQuoteAccent": T.Primary,
		"markdownQuoteColor": T.MutedForeground, "markdownLinkColor": T.Primary, "markdownInlineCodeColor": T.Foreground, "markdownMutedColor": T.MutedForeground,
		"markdownTableHeaderBackground": T.Muted, "markdownTableRule": T.Border, "userSelect": "text"}, styleOf(p))
	return jsx("markdown", q)
}

// Code props: code, language, path, showLineNumbers, syntaxTheme, style.
func Code(p Props) *VNode {
	q := copyProps(p)
	q["style"] = merge(S{"fontFamily": "monospace", "fontSize": 13, "lineHeight": 20.0 / 13, "foreground": T.Foreground, "gutterColor": T.MutedForeground, "userSelect": "text"}, styleOf(p))
	return jsx("code", q)
}

// Diff props: source, or oldText and newText; wordDiff (true), collapsedPaths, maxLines, onToggleFile, onShowMore, onLineClick, style.
func Diff(p Props) *VNode {
	_, hasOld := p["oldText"].(string)
	_, hasNew := p["newText"].(string)
	source, hasSource := p["source"].(string)
	if hasSource && source != "" && (hasOld || hasNew) {
		panic("tarve: Diff accepts source or oldText/newText, not both")
	}
	if !hasSource && !hasOld && !hasNew {
		panic("tarve: Diff requires source or both oldText and newText")
	}
	if hasOld != hasNew {
		panic("tarve: Diff requires both oldText and newText to compute a diff")
	}
	q := copyProps(p)
	q["source"], q["oldText"], q["newText"] = source, str(p, "oldText"), str(p, "newText")
	if _, ok := q["wordDiff"]; !ok || q["wordDiff"] == nil {
		q["wordDiff"] = true
	}
	if q["collapsedPaths"] == nil {
		q["collapsedPaths"] = []string{}
	}
	q["style"] = merge(S{"fontFamily": "monospace", "fontSize": 14, "lineHeight": 1.5, "foreground": T.Foreground, "diffGutterColor": T.MutedForeground,
		"diffHeaderBackground": T.Muted, "diffHeaderForeground": T.MutedForeground, "diffNoticeForeground": T.MutedForeground, "diffHunkBackground": T.Muted,
		"diffHunkForeground": T.MutedForeground, "diffAddedBackground": T.DiffAddBackground, "diffAddedEmphasisBackground": T.DiffAddEmphasisBackground,
		"diffAddedForeground": T.DiffAddForeground, "diffRemovedBackground": T.DiffRemoveBackground, "diffRemovedEmphasisBackground": T.DiffRemoveEmphasisBackground,
		"diffRemovedForeground": T.DiffRemoveForeground, "diffAddedAccent": T.DiffAddAccent, "diffRemovedAccent": T.DiffRemoveAccent, "userSelect": "text"}, styleOf(p))
	return jsx("diff", q)
}

// TextArea props: value, placeholder, disabled, submitOnEnter, onChange(string), onSubmit(string), style.
func TextArea(p Props) *VNode {
	q := copyProps(p)
	if v, ok := p["value"].(string); ok {
		q["value"] = normalizeNewlines(v)
	}
	q["style"] = merge(S{"width": "100%", "height": 120, "minWidth": 180, "minHeight": 72, "padding": 12, "radius": RadiusSm, "borderWidth": 1,
		"borderColor": T.Border, "background": T.Input, "foreground": T.Foreground, "placeholderColor": T.Placeholder, "selectionColor": T.Selection,
		"caretColor": T.Foreground, "lineHeight": LineHeight, "fontSize": FontSize, "userSelect": "text"}, styleOf(p))
	return nativeJsx("textarea", q)
}

func normalizeNewlines(s string) string {
	out := make([]byte, 0, len(s))
	for i := 0; i < len(s); i++ {
		if s[i] == '\r' {
			out = append(out, '\n')
			if i+1 < len(s) && s[i+1] == '\n' {
				i++
			}
			continue
		}
		out = append(out, s[i])
	}
	return string(out)
}

// Link props: href, label, disabled, onClick, style, children.
func Link(p Props, kids ...Child) *VNode {
	p = props(p, kids)
	href := str(p, "href")
	if len(href) == 0 {
		panic("tarve: Link requires a non-empty href")
	}
	linkStyle := merge(S{"textDecoration": "underline", "foreground": T.Primary}, canonicalizeIntrinsicStyle(styleOf(p)))
	textStyle := S{"foreground": linkStyle["foreground"]}
	for _, k := range []string{"fontSize", "fontWeight", "fontFamily", "lineHeight", "textAlign"} {
		if linkStyle[k] != nil {
			textStyle[k] = linkStyle[k]
		}
	}
	children := p["children"]
	if textOnly(children) {
		children = Text(Props{"children": children, "style": textStyle})
	}
	label := str(p, "label")
	if label == "" {
		label = textContent(p["children"])
	}
	disabled := truthy(p["disabled"])
	onClick, _ := p["onClick"].(func())
	q := without(p, "href", "label", "style")
	q["children"], q["style"] = children, linkStyle
	control := S{"role": "link"}
	if l := trimSpace(label); l != "" {
		control["label"] = l
	}
	q["control"] = control
	q["onClick"] = func() {
		if disabled {
			return
		}
		if onClick != nil {
			onClick()
		}
		OpenExternal(href)
	}
	return Pressable(q)
}

func trimSpace(s string) string {
	start, end := 0, len(s)
	for start < end && (s[start] == ' ' || s[start] == '\t' || s[start] == '\n' || s[start] == '\r') {
		start++
	}
	for end > start && (s[end-1] == ' ' || s[end-1] == '\t' || s[end-1] == '\n' || s[end-1] == '\r') {
		end--
	}
	return s[start:end]
}

// trueOrNil is a TypeScript optional flag: set when true, absent otherwise.
func trueOrNil(b bool) any {
	if b {
		return true
	}
	return nil
}
