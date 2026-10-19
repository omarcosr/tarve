package tarve

// Style variants folded by the compiler, as @tarve/core foldVariants: first/last/odd/even by
// position among element siblings, sm…2xl by window width, dark by the window theme.

type position struct{ index, count int }

var breakpoints = []struct {
	name  string
	width float64
}{{"sm", 640}, {"md", 768}, {"lg", 1024}, {"xl", 1280}, {"2xl", 1536}}

func hasVariants(style S) bool {
	for _, k := range variantKeys {
		if style[k] != nil {
			return true
		}
	}
	return false
}

// mergeStyle is @tarve/core Style.merge: later styles win; state styles merge key by key.
func mergeStyle(base, over S) S {
	out := merge(base)
	for k, v := range over {
		if v == nil {
			delete(out, k)
			continue
		}
		if isStateKey(k) {
			if m, ok := asMap(v); ok {
				prev, _ := asMap(base[k])
				out[k] = merge(prev, m)
				continue
			}
		}
		out[k] = v
	}
	return out
}

// combineSides keeps the other sides of a base padding/margin/border/radius that a variant sets one side of.
func combineSides(base, variant S) S {
	out := S{}
	for _, k := range []string{"padding", "margin", "borderWidth"} {
		a, b := base[k], variant[k]
		bm, ok := asMap(b)
		if a == nil || !ok {
			continue
		}
		var expanded S
		if am, ok := asMap(a); ok {
			expanded = merge(am)
		} else {
			expanded = S{"top": a, "right": a, "bottom": a, "left": a}
		}
		out[k] = merge(expanded, bm)
	}
	if a, b := base["radius"], variant["radius"]; a != nil {
		if bm, ok := asMap(b); ok {
			var expanded S
			if am, ok := asMap(a); ok {
				expanded = merge(am)
			} else {
				expanded = S{"topLeft": a, "topRight": a, "bottomRight": a, "bottomLeft": a}
			}
			out["radius"] = merge(expanded, bm)
		}
	}
	return out
}

type variantContext struct {
	pos          *position
	width        float64
	usedViewport *bool
	usedPosition *bool
}

func foldVariants(style S, t *Theme, ctx variantContext) S {
	if !hasVariants(style) {
		return style
	}
	out := S{}
	for k, v := range style {
		switch k {
		case "first", "last", "odd", "even", "sm", "md", "lg", "xl", "2xl", "dark":
		default:
			out[k] = v
		}
	}
	apply := func(v any) {
		m, ok := asMap(v)
		if !ok {
			return
		}
		sides := combineSides(out, m)
		out = mergeStyle(out, m)
		for k, v := range sides {
			out[k] = v
		}
	}
	if ctx.pos != nil && (style["first"] != nil || style["last"] != nil || style["odd"] != nil || style["even"] != nil) && ctx.usedPosition != nil {
		*ctx.usedPosition = true
	}
	if ctx.pos != nil {
		nth := ctx.pos.index + 1
		if nth == 1 {
			apply(style["first"])
		}
		if nth == ctx.pos.count {
			apply(style["last"])
		}
		if nth%2 == 1 {
			apply(style["odd"])
		} else {
			apply(style["even"])
		}
	}
	responsive := false
	for _, b := range breakpoints {
		if truthy(style[b.name]) {
			responsive = true
		}
	}
	if responsive && ctx.usedViewport != nil {
		*ctx.usedViewport = true
	}
	for _, b := range breakpoints {
		if ctx.width >= b.width {
			apply(style[b.name])
		}
	}
	if dark, ok := asMap(style["dark"]); ok {
		if l := luminance(t.Colors["background"]); l >= 0 && l < 0.5 {
			out = foldVariants(mergeStyle(out, dark), t, ctx)
		}
	}
	return out
}

func breakpointOf(width float64) int {
	n := 0
	for _, b := range breakpoints {
		if width >= b.width {
			n++
		}
	}
	return n
}
