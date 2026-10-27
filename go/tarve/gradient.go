package tarve

import (
	"math"
	"regexp"
	"strconv"
	"strings"
)

// CSS gradients, as @tarve/core parseGradient/normalizeGradient: linear-, radial- and
// conic-gradient() (and repeating- forms) into the protocol's gradient objects.

// splitTopLevel splits on sep outside parentheses.
func splitTopLevel(value string, sep func(rune) bool) []string {
	var parts []string
	depth := 0
	var current strings.Builder
	flush := func() {
		if t := strings.TrimSpace(current.String()); t != "" {
			parts = append(parts, t)
		}
		current.Reset()
	}
	for _, c := range value {
		switch c {
		case '(':
			depth++
		case ')':
			depth--
		}
		if depth == 0 && sep(c) {
			flush()
			continue
		}
		current.WriteRune(c)
	}
	flush()
	return parts
}

func isComma(c rune) bool { return c == ',' }
func isSpace(c rune) bool { return c == ' ' || c == '\t' || c == '\n' }

var gradientCall = regexp.MustCompile(`(?is)^\s*(repeating-)?(linear|radial|conic)-gradient\((.*)\)\s*$`)
var angleToken = regexp.MustCompile(`^(-?(?:\d+\.?\d*|\.\d+))(deg|rad|turn|grad)$`)
var lengthPercent = regexp.MustCompile(`^-?(?:\d+\.?\d*|\.\d+)(px|%)$`)
var radialExtent = regexp.MustCompile(`^(closest|farthest)-(side|corner)$`)

func gradientAngle(token string) (float64, bool) {
	m := angleToken.FindStringSubmatch(token)
	if m == nil {
		return 0, false
	}
	v, _ := strconv.ParseFloat(m[1], 64)
	switch m[2] {
	case "rad":
		v = v * 180 / math.Pi
	case "turn":
		v *= 360
	case "grad":
		v *= 0.9
	}
	return v, true
}

// gradientPosition is a stop or centre position: N% a fraction, Npx a px string, 0.
func gradientPosition(token string) any {
	if token == "0" {
		return 0.0
	}
	m := lengthPercent.FindStringSubmatch(token)
	if m == nil {
		panic("tarve: gradient positions must be px or %: " + token)
	}
	if m[1] == "%" {
		v, _ := strconv.ParseFloat(strings.TrimSuffix(token, "%"), 64)
		return v / 100
	}
	return token
}

func gradientTurn(token string) float64 {
	if token == "0" {
		return 0
	}
	if strings.HasSuffix(token, "%") {
		v, err := strconv.ParseFloat(strings.TrimSuffix(token, "%"), 64)
		if err == nil {
			return v / 100
		}
	}
	if deg, ok := gradientAngle(token); ok {
		return deg / 360
	}
	panic("tarve: conic gradient positions must be angles or %: " + token)
}

func gradientStops(args []string, conic bool) []any {
	var stops []any
	for _, arg := range args {
		parts := splitTopLevel(arg, isSpace)
		if len(parts) == 0 || len(parts) > 3 {
			panic("tarve: invalid colour stop: " + arg)
		}
		if len(parts) == 1 {
			stops = append(stops, S{"color": parts[0]})
			continue
		}
		for _, at := range parts[1:] {
			var offset any
			if conic {
				offset = gradientTurn(at)
			} else {
				offset = gradientPosition(at)
			}
			stops = append(stops, S{"color": parts[0], "offset": offset})
		}
	}
	return stops
}

// gradientCentre reads a radial/conic `at` position: keywords, % or px (1 or 2 values).
func gradientCentre(tokens []string) S {
	edge := map[string]float64{"left": 0, "top": 0, "center": 0.5, "right": 1, "bottom": 1}
	out := S{}
	var loose []any
	for _, t := range tokens {
		switch t {
		case "left", "right":
			out["x"] = edge[t]
		case "top", "bottom":
			out["y"] = edge[t]
		case "center":
			loose = append(loose, 0.5)
		default:
			loose = append(loose, gradientPosition(t))
		}
	}
	for _, axis := range []string{"x", "y"} {
		if out[axis] == nil {
			if len(loose) > 0 {
				out[axis], loose = loose[0], loose[1:]
			} else {
				out[axis] = 0.5
			}
		}
	}
	return out
}

// parseGradient turns a CSS gradient function into the protocol's gradient object.
func parseGradient(value string) S {
	m := gradientCall.FindStringSubmatch(value)
	if m == nil {
		panic("tarve: unsupported gradient: " + value)
	}
	out := S{}
	if m[1] != "" {
		out["repeating"] = true
	}
	args := splitTopLevel(m[3], isComma)
	var first []string
	if len(args) > 0 {
		first = strings.Fields(strings.ToLower(args[0]))
	}
	switch strings.ToLower(m[2]) {
	case "conic":
		out["type"] = "conic"
		if len(first) > 0 && (first[0] == "from" || first[0] == "at") {
			at := -1
			for i, w := range first {
				if w == "at" {
					at = i
				}
			}
			if first[0] == "from" && len(first) > 1 {
				if deg, ok := gradientAngle(first[1]); ok && deg != 0 {
					out["from"] = deg
				}
			}
			if at >= 0 {
				out["at"] = gradientCentre(first[at+1:])
			}
			args = args[1:]
		}
		out["stops"] = gradientStops(args, true)
	case "linear":
		out["type"] = "linear"
		if len(first) == 1 {
			if deg, ok := gradientAngle(first[0]); ok {
				out["angle"] = deg
				args = args[1:]
			}
		}
		if len(first) > 1 && first[0] == "to" {
			sides := append([]string(nil), first[1:]...)
			if len(sides) == 2 && (sides[0] == "left" || sides[0] == "right") {
				sides[0], sides[1] = sides[1], sides[0]
			}
			out["to"] = strings.Join(sides, " ")
			args = args[1:]
		}
		out["stops"] = gradientStops(args, false)
	default:
		out["type"] = "radial"
		header := false
		for _, w := range first {
			if w == "circle" || w == "ellipse" || w == "at" || radialExtent.MatchString(w) || lengthPercent.MatchString(w) {
				header = true
			}
		}
		if header {
			at := len(first)
			for i, w := range first {
				if w == "at" {
					at = i
				}
			}
			var lengths []any
			for _, w := range first[:at] {
				switch {
				case w == "circle" || w == "ellipse":
					out["shape"] = w
				case radialExtent.MatchString(w):
					out["size"] = w
				default:
					lengths = append(lengths, w)
				}
			}
			switch len(lengths) {
			case 1:
				out["size"] = lengths[0]
				if out["shape"] == nil {
					out["shape"] = "circle"
				}
			case 2:
				out["size"] = lengths
				if out["shape"] == nil {
					out["shape"] = "ellipse"
				}
			}
			if at < len(first) {
				out["at"] = gradientCentre(first[at+1:])
			}
			args = args[1:]
		}
		out["stops"] = gradientStops(args, false)
	}
	return out
}

// normalizeGradient resolves stop colours (CSS colours, theme tokens) for the native side.
func normalizeGradient(g S, t *Theme) S {
	out := merge(g)
	stops, _ := g["stops"].([]any)
	if len(stops) == 0 {
		panic("tarve: a gradient needs at least one colour stop")
	}
	resolved := make([]any, 0, len(stops)+1)
	for _, stop := range stops {
		m, _ := asMap(stop)
		if s, ok := stop.(string); ok {
			m = S{"color": s}
		}
		next := merge(m)
		if c, ok := m["color"].(string); ok && t != nil {
			next["color"] = resolveThemeColor(cssColor(c), t)
		}
		resolved = append(resolved, next)
	}
	if len(resolved) == 1 {
		only, _ := asMap(resolved[0])
		resolved = append(resolved, S{"color": only["color"]})
	}
	out["stops"] = resolved
	return out
}

// paintValue is a colour, or a CSS gradient string or gradient object resolved for the native side.
func paintValue(v any, t *Theme) any {
	switch value := v.(type) {
	case string:
		if gradient.MatchString(value) {
			return normalizeGradient(parseGradient(value), t)
		}
		if t != nil {
			return resolveThemeColor(cssColor(value), t)
		}
		return value
	case S:
		if value["stops"] != nil {
			return normalizeGradient(value, t)
		}
	}
	return v
}

// resolveGradients parses CSS gradients in the paint keys, a comma list of gradients in
// `background` (multiple backgrounds: the last is the bottom one, the others go to
// backgroundLayers, first on top) and `maskImage`; stop colours resolve against t.
func resolveGradients(style S, t *Theme) {
	if bg, ok := style["background"].(string); ok && strings.Contains(bg, "gradient(") {
		if parts := splitTopLevel(bg, isComma); len(parts) > 1 && gradient.MatchString(parts[0]) {
			layers, _ := style["backgroundLayers"].([]any)
			for _, part := range parts[:len(parts)-1] {
				layers = append(layers, part)
			}
			style["backgroundLayers"] = layers
			style["background"] = parts[len(parts)-1]
		}
	}
	for _, key := range []string{"background", "foreground", "borderColor", "maskImage"} {
		if v, ok := style[key]; ok && v != nil {
			if s, isString := v.(string); isString && !gradient.MatchString(s) {
				continue
			}
			style[key] = paintValue(v, t)
		}
	}
	if layers, ok := style["backgroundLayers"].([]any); ok {
		resolved := make([]any, len(layers))
		for i, layer := range layers {
			resolved[i] = paintValue(layer, t)
		}
		style["backgroundLayers"] = resolved
	}
}
