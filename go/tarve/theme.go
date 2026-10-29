package tarve

import (
	"fmt"
	"math"
	"regexp"
	"strconv"
	"strings"
	"sync"
)

// ThemeColors mirrors @tarve/core ThemeColors.
type ThemeColors struct {
	Background, Card, Foreground, Muted, MutedForeground, Border, Input                                     string
	Primary, PrimaryForeground, PrimaryHover, PrimaryActive                                                 string
	Secondary, SecondaryForeground, SecondaryHover, SecondaryActive                                         string
	Destructive, DestructiveForeground, DestructiveHover, DestructiveActive, DestructiveText                string
	Ring, RingSoft, Success, SuccessMuted                                                                   string
	DiffAddBackground, DiffAddEmphasisBackground, DiffAddForeground, DiffAddAccent                          string
	DiffRemoveBackground, DiffRemoveEmphasisBackground, DiffRemoveForeground, DiffRemoveAccent              string
	Disabled, DisabledForeground, Placeholder, Selection, Scrollbar, Overlay, ImagePlaceholder, SliderThumb string
	WindowCloseHover, WindowCloseActive                                                                     string
}

// Theme mirrors @tarve/core ThemeDefinition.
type Theme struct {
	Colors       map[string]string
	Syntax       map[string]string
	FocusOutline map[string]any
}

var colorNames = []string{"background", "card", "foreground", "muted", "mutedForeground", "border", "input", "primary", "primaryForeground", "primaryHover", "primaryActive",
	"secondary", "secondaryForeground", "secondaryHover", "secondaryActive", "destructive", "destructiveForeground", "destructiveHover", "destructiveActive", "destructiveText",
	"ring", "ringSoft", "success", "successMuted", "diffAddBackground", "diffAddEmphasisBackground", "diffAddForeground", "diffAddAccent",
	"diffRemoveBackground", "diffRemoveEmphasisBackground", "diffRemoveForeground", "diffRemoveAccent", "disabled", "disabledForeground", "placeholder", "selection",
	"scrollbar", "overlay", "imagePlaceholder", "sliderThumb", "windowCloseHover", "windowCloseActive"}

func cssName(name string) string {
	var b strings.Builder
	for _, r := range name {
		if r >= 'A' && r <= 'Z' {
			b.WriteByte('-')
			r += 'a' - 'A'
		}
		b.WriteRune(r)
	}
	return b.String()
}

func ref(name string) string { return "var(--" + cssName(name) + ")" }

// T holds the semantic theme tokens, as @tarve/core theme.colors: resolved per window theme.
var T = ThemeColors{
	ref("background"), ref("card"), ref("foreground"), ref("muted"), ref("mutedForeground"), ref("border"), ref("input"),
	ref("primary"), ref("primaryForeground"), ref("primaryHover"), ref("primaryActive"),
	ref("secondary"), ref("secondaryForeground"), ref("secondaryHover"), ref("secondaryActive"),
	ref("destructive"), ref("destructiveForeground"), ref("destructiveHover"), ref("destructiveActive"), ref("destructiveText"),
	ref("ring"), ref("ringSoft"), ref("success"), ref("successMuted"),
	ref("diffAddBackground"), ref("diffAddEmphasisBackground"), ref("diffAddForeground"), ref("diffAddAccent"),
	ref("diffRemoveBackground"), ref("diffRemoveEmphasisBackground"), ref("diffRemoveForeground"), ref("diffRemoveAccent"),
	ref("disabled"), ref("disabledForeground"), ref("placeholder"), ref("selection"), ref("scrollbar"), ref("overlay"), ref("imagePlaceholder"), ref("sliderThumb"),
	ref("windowCloseHover"), ref("windowCloseActive"),
}

var keyByRef = func() map[string]string {
	m := map[string]string{}
	for _, n := range colorNames {
		m[ref(n)] = n
	}
	return m
}()

const (
	RadiusSm   = 6
	RadiusMd   = 8
	RadiusLg   = 12
	FontFamily = "system-ui"
	FontSize   = 14
	LineHeight = 1.5
)

func defaultFocusOutline() map[string]any {
	return map[string]any{"outlineWidth": 2, "outlineOffset": 2, "outlineStyle": "solid"}
}

func palette(pairs ...string) map[string]string {
	m := make(map[string]string, len(pairs)/2)
	for i := 0; i+1 < len(pairs); i += 2 {
		m[pairs[i]] = pairs[i+1]
	}
	return m
}

var LightTheme = &Theme{
	FocusOutline: defaultFocusOutline(),
	Syntax: palette("comment", "#6e7781", "keyword", "#cf222e", "string", "#0a3069", "stringSpecial", "#0550ae", "escape", "#953800",
		"number", "#0550ae", "boolean", "#0550ae", "typeName", "#8250df", "typeBuiltin", "#8250df", "constructor", "#8250df",
		"function", "#8250df", "functionBuiltin", "#6639ba", "macro", "#8250df", "property", "#953800", "constant", "#0550ae",
		"variable", "#24292f", "variableSpecial", "#953800", "parameter", "#24292f", "operator", "#cf222e", "punctuation", "#57606a",
		"tag", "#116329", "attribute", "#0550ae", "label", "#953800", "embedded", "#24292f", "invalid", "#cf222e"),
	Colors: palette("background", "#fafafa", "card", "#ffffff", "foreground", "#18181b", "muted", "#f4f4f5", "mutedForeground", "#71717a",
		"border", "#e4e4e7", "input", "#ffffff", "primary", "#18181b", "primaryForeground", "#fafafa", "primaryHover", "#303036", "primaryActive", "#3f3f46",
		"secondary", "#f4f4f5", "secondaryForeground", "#18181b", "secondaryHover", "#e4e4e7", "secondaryActive", "#d4d4d8",
		"destructive", "#dc2626", "destructiveForeground", "#ffffff", "destructiveHover", "#b91c1c", "destructiveActive", "#991b1b", "destructiveText", "#dc2626",
		"ring", "#a1a1aa", "ringSoft", "#aeaeb6", "success", "#15803d", "successMuted", "#f0fdf4",
		"diffAddBackground", "#dcfce7", "diffAddEmphasisBackground", "#bbf7d0", "diffAddForeground", "#14532d", "diffAddAccent", "#15803d",
		"diffRemoveBackground", "#fee2e2", "diffRemoveEmphasisBackground", "#fecaca", "diffRemoveForeground", "#7f1d1d", "diffRemoveAccent", "#dc2626",
		"disabled", "#e4e4e7", "disabledForeground", "#a1a1aa", "placeholder", "#a1a1aa", "selection", "#dbeafe", "scrollbar", "#d4d4d8",
		"overlay", "#00000066", "imagePlaceholder", "#f4f4f5", "sliderThumb", "#ffffff", "windowCloseHover", "#e81123", "windowCloseActive", "#c50f1f"),
}

var DarkTheme = &Theme{
	FocusOutline: defaultFocusOutline(),
	Syntax: palette("comment", "#8b949e", "keyword", "#ff7b72", "string", "#a5d6ff", "stringSpecial", "#79c0ff", "escape", "#ffa657",
		"number", "#79c0ff", "boolean", "#79c0ff", "typeName", "#d2a8ff", "typeBuiltin", "#d2a8ff", "constructor", "#d2a8ff",
		"function", "#d2a8ff", "functionBuiltin", "#bc8cff", "macro", "#d2a8ff", "property", "#ffa657", "constant", "#79c0ff",
		"variable", "#c9d1d9", "variableSpecial", "#ffa657", "parameter", "#c9d1d9", "operator", "#ff7b72", "punctuation", "#8b949e",
		"tag", "#7ee787", "attribute", "#79c0ff", "label", "#ffa657", "embedded", "#c9d1d9", "invalid", "#f85149"),
	Colors: palette("background", "#09090b", "card", "#09090b", "foreground", "#fafafa", "muted", "#27272a", "mutedForeground", "#a1a1aa",
		"border", "#27272a", "input", "#18181b", "primary", "#fafafa", "primaryForeground", "#18181b", "primaryHover", "#e4e4e7", "primaryActive", "#d4d4d8",
		"secondary", "#27272a", "secondaryForeground", "#fafafa", "secondaryHover", "#3f3f46", "secondaryActive", "#52525b",
		"destructive", "#7f1d1d", "destructiveForeground", "#fafafa", "destructiveHover", "#991b1b", "destructiveActive", "#b91c1c", "destructiveText", "#f87171",
		"ring", "#d4d4d8", "ringSoft", "#b1b1b5", "success", "#4ade80", "successMuted", "#052e16",
		"diffAddBackground", "#052e16", "diffAddEmphasisBackground", "#14532d", "diffAddForeground", "#a7f3d0", "diffAddAccent", "#4ade80",
		"diffRemoveBackground", "#450a0a", "diffRemoveEmphasisBackground", "#7f1d1d", "diffRemoveForeground", "#fecaca", "diffRemoveAccent", "#f87171",
		"disabled", "#27272a", "disabledForeground", "#71717a", "placeholder", "#71717a", "selection", "#1e3a5f", "scrollbar", "#52525b",
		"overlay", "#00000099", "imagePlaceholder", "#18181b", "sliderThumb", "#fafafa", "windowCloseHover", "#e81123", "windowCloseActive", "#c50f1f"),
}

// ThemeOverrides: colour, syntax and focus-outline values replacing the base theme's.
type ThemeOverrides struct {
	Colors       map[string]string
	Syntax       map[string]string
	FocusOutline map[string]any
}

// CreateTheme is @tarve/core Theme.create(base, overrides).
func CreateTheme(base *Theme, overrides ThemeOverrides) *Theme {
	if base == nil {
		base = LightTheme
	}
	t := &Theme{Colors: map[string]string{}, Syntax: map[string]string{}, FocusOutline: defaultFocusOutline()}
	for k, v := range base.Colors {
		t.Colors[k] = v
	}
	for k, v := range overrides.Colors {
		t.Colors[k] = v
	}
	for k, v := range base.Syntax {
		t.Syntax[k] = v
	}
	for k, v := range overrides.Syntax {
		t.Syntax[k] = v
	}
	for k, v := range base.FocusOutline {
		t.FocusOutline[k] = v
	}
	for k, v := range overrides.FocusOutline {
		t.FocusOutline[k] = v
	}
	return t
}

var named = func() map[string]string {
	words := strings.Fields("aliceblue f0f8ff antiquewhite faebd7 aqua 00ffff aquamarine 7fffd4 azure f0ffff beige f5f5dc bisque ffe4c4 black 000000 blanchedalmond ffebcd blue 0000ff blueviolet 8a2be2 brown a52a2a burlywood deb887 cadetblue 5f9ea0 chartreuse 7fff00 chocolate d2691e coral ff7f50 cornflowerblue 6495ed cornsilk fff8dc crimson dc143c cyan 00ffff darkblue 00008b darkcyan 008b8b darkgoldenrod b8860b darkgray a9a9a9 darkgreen 006400 darkgrey a9a9a9 darkkhaki bdb76b darkmagenta 8b008b darkolivegreen 556b2f darkorange ff8c00 darkorchid 9932cc darkred 8b0000 darksalmon e9967a darkseagreen 8fbc8f darkslateblue 483d8b darkslategray 2f4f4f darkslategrey 2f4f4f darkturquoise 00ced1 darkviolet 9400d3 deeppink ff1493 deepskyblue 00bfff dimgray 696969 dimgrey 696969 dodgerblue 1e90ff firebrick b22222 floralwhite fffaf0 forestgreen 228b22 fuchsia ff00ff gainsboro dcdcdc ghostwhite f8f8ff gold ffd700 goldenrod daa520 gray 808080 green 008000 greenyellow adff2f grey 808080 honeydew f0fff0 hotpink ff69b4 indianred cd5c5c indigo 4b0082 ivory fffff0 khaki f0e68c lavender e6e6fa lavenderblush fff0f5 lawngreen 7cfc00 lemonchiffon fffacd lightblue add8e6 lightcoral f08080 lightcyan e0ffff lightgoldenrodyellow fafad2 lightgray d3d3d3 lightgreen 90ee90 lightgrey d3d3d3 lightpink ffb6c1 lightsalmon ffa07a lightseagreen 20b2aa lightskyblue 87cefa lightslategray 778899 lightslategrey 778899 lightsteelblue b0c4de lightyellow ffffe0 lime 00ff00 limegreen 32cd32 linen faf0e6 magenta ff00ff maroon 800000 mediumaquamarine 66cdaa mediumblue 0000cd mediumorchid ba55d3 mediumpurple 9370db mediumseagreen 3cb371 mediumslateblue 7b68ee mediumspringgreen 00fa9a mediumturquoise 48d1cc mediumvioletred c71585 midnightblue 191970 mintcream f5fffa mistyrose ffe4e1 moccasin ffe4b5 navajowhite ffdead navy 000080 oldlace fdf5e6 olive 808000 olivedrab 6b8e23 orange ffa500 orangered ff4500 orchid da70d6 palegoldenrod eee8aa palegreen 98fb98 paleturquoise afeeee palevioletred db7093 papayawhip ffefd5 peachpuff ffdab9 peru cd853f pink ffc0cb plum dda0dd powderblue b0e0e6 purple 800080 rebeccapurple 663399 red ff0000 rosybrown bc8f8f royalblue 4169e1 saddlebrown 8b4513 salmon fa8072 sandybrown f4a460 seagreen 2e8b57 seashell fff5ee sienna a0522d silver c0c0c0 skyblue 87ceeb slateblue 6a5acd slategray 708090 slategrey 708090 snow fffafa springgreen 00ff7f steelblue 4682b4 tan d2b48c teal 008080 thistle d8bfd8 tomato ff6347 turquoise 40e0d0 violet ee82ee wheat f5deb3 white ffffff whitesmoke f5f5f5 yellow ffff00 yellowgreen 9acd32 transparent 00000000")
	m := make(map[string]string, len(words)/2)
	for i := 0; i+1 < len(words); i += 2 {
		m[words[i]] = "#" + words[i+1]
	}
	return m
}()

var (
	hexColor   = regexp.MustCompile(`^#([0-9a-f]{3,4}|[0-9a-f]{6}|[0-9a-f]{8})$`)
	colorFn    = regexp.MustCompile(`^(rgba?|hsla?)\((.*)\)$`)
	splitSpace = regexp.MustCompile(`[\s,]+`)
	tokenAlpha = regexp.MustCompile(`^(var\(--[\w-]+\))/(\d{1,3})$`)
	colorKey   = regexp.MustCompile(`^(background|foreground|color)$|(Color|Background|Foreground|Accent|Rule)$`)
	gradient   = regexp.MustCompile(`(?i)^\s*(repeating-)?(linear|radial|conic)-gradient\(`)
)

func hex2(v float64) string {
	return fmt.Sprintf("%02x", int(math.Round(math.Min(255, math.Max(0, v)))))
}

func channel(token string, scale float64) float64 {
	var v float64
	var err error
	if strings.HasSuffix(token, "%") {
		v, err = strconv.ParseFloat(token[:len(token)-1], 64)
		v = v / 100 * scale
	} else {
		v, err = strconv.ParseFloat(token, 64)
	}
	if err != nil || math.IsInf(v, 0) || math.IsNaN(v) {
		panic(fmt.Sprintf("tarve: invalid colour channel: %s", token))
	}
	return v
}

// cssColor is @tarve/core cssColor: CSS colour → #rrggbb(aa); theme tokens pass through.
func cssColor(value string) string {
	input := strings.ToLower(strings.TrimSpace(value))
	if strings.HasPrefix(input, "var(") {
		return strings.TrimSpace(value)
	}
	if c, ok := named[input]; ok {
		return c
	}
	if hexColor.MatchString(input) {
		d := input[1:]
		if len(d) <= 4 {
			var b strings.Builder
			b.WriteByte('#')
			for _, r := range d {
				b.WriteRune(r)
				b.WriteRune(r)
			}
			return b.String()
		}
		return input
	}
	m := colorFn.FindStringSubmatch(input)
	if m == nil {
		panic("tarve: unsupported colour: " + value)
	}
	body, slash := m[2], ""
	if i := strings.Index(body, "/"); i >= 0 {
		body, slash = strings.TrimSpace(body[:i]), strings.TrimSpace(body[i+1:])
	}
	var parts []string
	for _, p := range splitSpace.Split(strings.TrimSpace(body), -1) {
		if p != "" {
			parts = append(parts, p)
		}
	}
	a := 1.0
	if slash != "" {
		a = math.Min(1, math.Max(0, channel(slash, 1)))
	} else if len(parts) > 3 {
		a = math.Min(1, math.Max(0, channel(parts[3], 1)))
	}
	if len(parts) < 3 {
		panic("tarve: unsupported colour: " + value)
	}
	var r, g, b float64
	if strings.HasPrefix(m[1], "rgb") {
		r, g, b = channel(parts[0], 255), channel(parts[1], 255), channel(parts[2], 255)
	} else {
		h, _ := strconv.ParseFloat(strings.TrimRight(parts[0], "deg"), 64)
		s, l := channel(parts[1], 1), channel(parts[2], 1)
		k := func(n float64) float64 { return math.Mod(n+h/30, 12) }
		aa := s * math.Min(l, 1-l)
		f := func(n float64) float64 { return l - aa*math.Max(-1, math.Min(k(n)-3, math.Min(9-k(n), 1))) }
		r, g, b = f(0)*255, f(8)*255, f(4)*255
	}
	return "#" + hex2(r) + hex2(g) + hex2(b) + hex2(a*255)
}

func resolveThemeColor(value string, t *Theme) string {
	if key, ok := keyByRef[value]; ok {
		return t.Colors[key]
	}
	m := tokenAlpha.FindStringSubmatch(value)
	if m == nil {
		return value
	}
	base, ok := keyByRef[m[1]]
	if !ok {
		return value
	}
	color := cssColor(t.Colors[base])
	percent, _ := strconv.Atoi(m[2])
	percent = max(0, min(100, percent))
	ch := fmt.Sprintf("%02x", int(math.Round(float64(percent)/100*255)))
	switch len(color) {
	case 7:
		return color + ch
	case 9:
		return color[:7] + ch
	}
	return color
}

type resolveKey struct {
	theme      *Theme
	key, value string
}

var (
	resolvedMu      sync.Mutex
	resolvedStrings = map[resolveKey]string{}
)

func resolveStyleString(key, value string, t *Theme) string {
	k := resolveKey{t, key, value}
	resolvedMu.Lock()
	r, ok := resolvedStrings[k]
	resolvedMu.Unlock()
	if ok {
		return r
	}
	if (key == "background" || key == "foreground" || key == "borderColor") && gradient.MatchString(value) {
		r = value
	} else if key == "foreground" && strings.EqualFold(strings.TrimSpace(value), "currentColor") {
		// The runtime takes the nearest ancestor's foreground, as CSS currentColor.
		r = "currentColor"
	} else if colorKey.MatchString(key) {
		r = resolveThemeColor(cssColor(value), t)
	} else {
		r = resolveThemeColor(value, t)
	}
	resolvedMu.Lock()
	if len(resolvedStrings) > 4096 {
		clear(resolvedStrings)
	}
	resolvedStrings[k] = r
	resolvedMu.Unlock()
	return r
}

var stateKeys = []string{"hover", "focus", "focusVisible", "active", "disabled"}

func isStateKey(k string) bool {
	switch k {
	case "hover", "focus", "focusVisible", "active", "disabled":
		return true
	}
	return false
}

func resolveThemeStyle(style S, t *Theme) S {
	style = resolveCssLayers(style, t)
	out := make(S, len(style))
	for k, v := range style {
		if v == nil {
			continue
		}
		if s, ok := v.(string); ok {
			out[k] = resolveStyleString(k, s, t)
			continue
		}
		if isStateKey(k) {
			if m, ok := asMap(v); ok {
				next := make(S, len(m))
				for sk, sv := range m {
					if sv == nil {
						continue
					}
					if s, ok := sv.(string); ok {
						next[sk] = resolveStyleString(sk, s, t)
					} else {
						next[sk] = sv
					}
				}
				resolvePaint(next, t)
				out[k] = next
				continue
			}
		}
		if k == "animation" {
			if m, ok := asMap(v); ok {
				// style.animation keyframes resolve like a state style.
				next := merge(m)
				for _, frame := range []string{"from", "to"} {
					if f, ok := asMap(m[frame]); ok {
						resolved := make(S, len(f))
						for fk, fv := range f {
							if s, ok := fv.(string); ok {
								resolved[fk] = resolveStyleString(fk, s, t)
							} else {
								resolved[fk] = fv
							}
						}
						resolvePaint(resolved, t)
						next[frame] = resolved
					}
				}
				out[k] = next
				continue
			}
		}
		out[k] = v
	}
	resolvePaint(out, t)
	return out
}

func resolvePaint(style S, t *Theme) {
	if s, ok := style["transform"].(string); ok {
		style["transform"] = parseTransform(s)
	}
	resolveGradients(style, t)
	if v, ok := style["textShadow"].(string); ok {
		if layers := parseShadow(v, false, t); len(layers) > 0 {
			style["textShadow"] = layers[0]
		} else {
			delete(style, "textShadow")
		}
	}
	if v, ok := style["boxShadow"].(string); ok {
		layers := parseShadow(v, true, t)
		if len(layers) == 0 {
			delete(style, "boxShadow")
		} else {
			list := make([]any, len(layers))
			for i, layer := range layers {
				list[i] = layer
			}
			style["boxShadow"] = list
		}
	}
}

var transformFn = regexp.MustCompile(`([a-zA-Z]+)\(([^)]*)\)`)

func transformLength(token string) float64 {
	t := strings.TrimSuffix(token, "px")
	v, err := strconv.ParseFloat(t, 64)
	if err != nil || (t == token && v != 0) {
		panic("tarve: unsupported transform length: " + token)
	}
	return v
}

func transformPercent(token string) float64 {
	v, err := strconv.ParseFloat(strings.TrimSuffix(token, "%"), 64)
	if err != nil || math.IsInf(v, 0) || math.IsNaN(v) {
		panic("tarve: unsupported transform length: " + token)
	}
	return v
}

// parseTransform is @tarve/core parseTransform: translate and scale functions.
func parseTransform(value string) S {
	x, y, xp, yp, sx, sy := 0.0, 0.0, 0.0, 0.0, 1.0, 1.0
	input := strings.TrimSpace(value)
	if strings.EqualFold(input, "none") {
		return S{}
	}
	consumed := ""
	factor := func(token string) float64 {
		v, err := strconv.ParseFloat(token, 64)
		if err != nil || v == 0 {
			panic("tarve: invalid scale: " + token)
		}
		return v
	}
	for _, m := range transformFn.FindAllStringSubmatch(input, -1) {
		consumed += m[0]
		var args []string
		for _, a := range splitSpace.Split(m[2], -1) {
			if a != "" {
				args = append(args, a)
			}
		}
		arg := func(i int) string {
			if i < len(args) {
				return args[i]
			}
			return ""
		}
		// A translation: px, or % of the box's own size (as in CSS).
		moveX := func(i int) {
			if i < len(args) && strings.HasSuffix(args[i], "%") {
				xp += sx * transformPercent(args[i])
			} else if i < len(args) {
				x += sx * transformLength(args[i])
			}
		}
		moveY := func(i int) {
			if i < len(args) && strings.HasSuffix(args[i], "%") {
				yp += sy * transformPercent(args[i])
			} else if i < len(args) {
				y += sy * transformLength(args[i])
			}
		}
		switch m[1] {
		case "translate":
			moveX(0)
			moveY(1)
		case "translateX":
			moveX(0)
		case "translateY":
			moveY(0)
		case "scale":
			f := factor(arg(0))
			sx *= f
			if len(args) > 1 {
				sy *= factor(arg(1))
			} else {
				sy *= f
			}
		case "scaleX":
			sx *= factor(arg(0))
		case "scaleY":
			sy *= factor(arg(0))
		default:
			panic("tarve: unsupported transform function: " + m[1])
		}
	}
	if strings.Join(strings.Fields(consumed), "") != strings.Join(strings.Fields(input), "") {
		panic("tarve: invalid transform: " + value)
	}
	out := S{}
	if x != 0 {
		out["x"] = x
	}
	if y != 0 {
		out["y"] = y
	}
	if xp != 0 {
		out["xPercent"] = xp
	}
	if yp != 0 {
		out["yPercent"] = yp
	}
	if sx == sy {
		if sx != 1 {
			out["scale"] = sx
		}
	} else {
		out["scaleX"], out["scaleY"] = sx, sy
	}
	return out
}

// luminance is the relative luminance (0–1) of #rgb/#rrggbb, or -1 for other colours.
func luminance(color string) float64 {
	hex := strings.TrimPrefix(strings.TrimSpace(color), "#")
	full := hex
	if len(hex) == 3 || len(hex) == 4 {
		var b strings.Builder
		for _, r := range hex[:3] {
			b.WriteRune(r)
			b.WriteRune(r)
		}
		full = b.String()
	} else if len(hex) >= 6 {
		full = hex[:6]
	}
	if len(full) != 6 {
		return -1
	}
	v, err := strconv.ParseUint(full, 16, 32)
	if err != nil {
		return -1
	}
	r, g, b := float64(v>>16&0xff)/255, float64(v>>8&0xff)/255, float64(v&0xff)/255
	return 0.2126*r + 0.7152*g + 0.0722*b
}

func windowBorder(background string, t *Theme) string {
	own, themed := luminance(background), luminance(t.Colors["background"])
	if own < 0 || themed < 0 || (own < 0.5) == (themed < 0.5) {
		return t.Colors["border"]
	}
	if own < 0.5 {
		return "#ffffff1f"
	}
	return "#0000001f"
}
