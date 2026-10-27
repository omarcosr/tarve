package tarve

import (
	"regexp"
	"strconv"
	"strings"
)

// resolveThemeStyle returns a theme-resolved copy (top level and state styles copied).
var cssFilterFn = regexp.MustCompile(`([a-z-]+)\(([^)]*)\)`)

// cssFilter parses blur(12px) saturate(160%) into numbers; other functions panic.
func cssFilter(value string, allowed ...string) map[string]float64 {
	out := map[string]float64{}
	input := strings.TrimSpace(value)
	if input == "none" {
		return out
	}
	for _, m := range cssFilterFn.FindAllStringSubmatch(input, -1) {
		ok := false
		for _, name := range allowed {
			ok = ok || name == m[1]
		}
		if !ok {
			panic("tarve: filter supports " + strings.Join(allowed, "() and ") + "() only, got " + m[1] + "()")
		}
		arg := strings.TrimSpace(m[2])
		if m[1] == "blur" {
			out["blur"] = transformLength(arg)
			continue
		}
		scale := 1.0
		if strings.HasSuffix(arg, "%") {
			arg, scale = strings.TrimSuffix(arg, "%"), 0.01
		}
		v, err := strconv.ParseFloat(arg, 64)
		if err != nil {
			panic("tarve: invalid filter: " + value)
		}
		out[m[1]] = v * scale
	}
	return out
}

// parseShadow reads CSS box-shadow/text-shadow layers: "x y [blur] [spread] colour [inset]".
func parseShadow(value string, box bool, t *Theme) []S {
	if strings.TrimSpace(value) == "none" {
		return nil
	}
	var out []S
	for _, layer := range splitTopLevel(value, isComma) {
		var lengths []float64
		colour, inset := "#00000040", false
		for _, token := range splitTopLevel(layer, isSpace) {
			if token == "inset" && box {
				inset = true
			} else if v, err := strconv.ParseFloat(strings.TrimSuffix(token, "px"), 64); err == nil {
				lengths = append(lengths, v)
			} else {
				colour = token
			}
		}
		if len(lengths) < 2 || len(lengths) > 4 || (!box && len(lengths) > 3) {
			panic("tarve: invalid shadow: " + layer)
		}
		shadow := S{"x": lengths[0], "y": lengths[1], "color": resolveThemeColor(cssColor(colour), t)}
		if len(lengths) > 2 {
			shadow["blur"] = lengths[2]
		}
		if len(lengths) > 3 {
			shadow["spread"] = lengths[3]
		}
		if inset {
			shadow["inset"] = true
		}
		out = append(out, shadow)
	}
	return out
}

// dropShadowFn is a drop-shadow() call, its arguments possibly holding rgba(…).
var dropShadowFn = regexp.MustCompile(`drop-shadow\(((?:[^()]|\([^()]*\))*)\)`)

// parseDropShadow reads "x y [blur] [colour]" into the protocol's dropShadow.
func parseDropShadow(args string, t *Theme) S {
	var lengths []float64
	colour := "#000000"
	for _, token := range regexp.MustCompile(`\S+\([^)]*\)|\S+`).FindAllString(args, -1) {
		if v, err := strconv.ParseFloat(strings.TrimSuffix(token, "px"), 64); err == nil {
			lengths = append(lengths, v)
		} else {
			colour = token
		}
	}
	if len(lengths) < 2 {
		panic("tarve: drop-shadow() needs an x and a y offset: " + args)
	}
	blur := 0.0
	if len(lengths) > 2 {
		blur = lengths[2]
	}
	return S{"x": lengths[0], "y": lengths[1], "blur": blur, "color": resolveThemeColor(cssColor(colour), t)}
}

// resolveCssLayers is @tarve/core resolveCssLayers: backdropBlur/backdropFilter become a
// plain glass blur, a filter string an object, and backgroundLayers colours resolve.
func resolveCssLayers(style S, t *Theme) S {
	if style["backdropBlur"] == nil && style["backdropFilter"] == nil && style["filter"] == nil && style["backgroundLayers"] == nil {
		return style
	}
	out := merge(style)
	if out["backdropBlur"] != nil || out["backdropFilter"] != nil {
		backdrop := map[string]float64{}
		if f, ok := out["backdropFilter"].(string); ok {
			backdrop = cssFilter(f, "blur", "saturate")
		}
		if b, ok := num(out["backdropBlur"]); ok {
			backdrop["blur"] = b
		}
		glass := S{"blur": backdrop["blur"]}
		if sat, ok := backdrop["saturate"]; ok {
			glass["saturate"] = sat
		}
		if own, ok := asMap(out["glass"]); ok {
			glass = merge(glass, own)
		}
		out["glass"] = glass
		delete(out, "backdropBlur")
		delete(out, "backdropFilter")
	}
	if f, ok := out["filter"].(string); ok {
		filter := S{}
		if m := dropShadowFn.FindStringSubmatchIndex(f); m != nil {
			filter["dropShadow"] = parseDropShadow(f[m[2]:m[3]], t)
			f = f[:m[0]] + f[m[1]:]
		}
		if blur := cssFilter(f, "blur")["blur"]; blur > 0 {
			filter["blur"] = blur
		}
		if len(filter) > 0 {
			out["filter"] = filter
		} else {
			delete(out, "filter")
		}
	}
	if layers, ok := out["backgroundLayers"].([]any); ok {
		resolved := make([]any, len(layers))
		for i, layer := range layers {
			if s, ok := layer.(string); ok {
				resolved[i] = resolveStyleString("background", s, t)
			} else {
				resolved[i] = layer
			}
		}
		out["backgroundLayers"] = resolved
	}
	return out
}
