package tarve

import (
	"math"
	"regexp"
	"strconv"
	"strings"
)

// Style variants folded by the compiler, as @tarve/core foldVariants: first/last/odd/even by
// position among element siblings, sm…2xl by window width, portrait/landscape by its shape,
// pointerCoarse/pointerFine and motionReduce/motionSafe by the system (viewport.go), dark by
// the window theme.

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
	height       float64
	usedViewport *bool
	usedPosition *bool
}

// viewportUnit is a CSS viewport length: 50vh, 100vw, 10vmin, 10vmax (and dvh/svh/lvh forms).
var viewportUnit = regexp.MustCompile(`^(-?\d*\.?\d+)(?:d|s|l)?(vh|vw|vmin|vmax)$`)

// viewportLength resolves a viewport unit to px for the window; other values pass.
func viewportLength(v any, ctx variantContext) (any, bool) {
	text, ok := v.(string)
	if !ok {
		return v, false
	}
	m := viewportUnit.FindStringSubmatch(strings.TrimSpace(text))
	if m == nil {
		return v, false
	}
	n, err := strconv.ParseFloat(m[1], 64)
	if err != nil {
		return v, false
	}
	if ctx.usedViewport != nil {
		*ctx.usedViewport = true
	}
	base := math.Max(ctx.width, ctx.height)
	switch m[2] {
	case "vh":
		base = ctx.height
	case "vw":
		base = ctx.width
	case "vmin":
		base = math.Min(ctx.width, ctx.height)
	}
	return n * base / 100, true
}

// resolveViewportUnits turns viewport units into px (reading them re-renders on resize).
func resolveViewportUnits(style S, ctx variantContext) S {
	var out S
	for k, v := range style {
		if next, ok := viewportLength(v, ctx); ok {
			if out == nil {
				out = merge(style)
			}
			out[k] = next
			continue
		}
		if k != "padding" && k != "margin" && k != "inset" && k != "borderWidth" {
			continue
		}
		sides, ok := asMap(v)
		if !ok {
			continue
		}
		var resolved S
		for side, raw := range sides {
			if next, ok := viewportLength(raw, ctx); ok {
				if resolved == nil {
					resolved = merge(sides)
				}
				resolved[side] = next
			}
		}
		if resolved != nil {
			if out == nil {
				out = merge(style)
			}
			out[k] = resolved
		}
	}
	if out == nil {
		return style
	}
	return out
}

func foldVariants(style S, t *Theme, ctx variantContext) S {
	return resolveViewportUnits(foldStyleVariants(style, t, ctx), ctx)
}

func foldStyleVariants(style S, t *Theme, ctx variantContext) S {
	if !hasVariants(style) {
		return style
	}
	out := S{}
	for k, v := range style {
		switch k {
		case "first", "last", "odd", "even", "sm", "md", "lg", "xl", "2xl", "portrait", "landscape", "pointerCoarse", "pointerFine", "motionReduce", "motionSafe", "dark":
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
	used := func() {
		if ctx.usedViewport != nil {
			*ctx.usedViewport = true
		}
	}
	if style["portrait"] != nil || style["landscape"] != nil {
		used()
		if ctx.height > ctx.width {
			apply(style["portrait"])
		} else {
			apply(style["landscape"])
		}
	}
	if style["pointerCoarse"] != nil || style["pointerFine"] != nil || style["motionReduce"] != nil || style["motionSafe"] != nil {
		// Memoized subtrees key on the environment through the viewport (viewportKey).
		used()
		system := readEnvironment()
		if system.pointer == "coarse" {
			apply(style["pointerCoarse"])
		} else {
			apply(style["pointerFine"])
		}
		if system.reducedMotion {
			apply(style["motionReduce"])
		} else {
			apply(style["motionSafe"])
		}
	}
	if dark, ok := asMap(style["dark"]); ok {
		if l := luminance(t.Colors["background"]); l >= 0 && l < 0.5 {
			out = foldStyleVariants(mergeStyle(out, dark), t, ctx)
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
