package tarve

import (
	"fmt"
	"math"
	"strconv"
	"strings"
)

var glassMaterial = map[string]S{
	"regular": {"blur": 8, "saturate": 1.6, "refraction": 22, "highlight": 1, "magnify": 0.06},
	"clear":   {"blur": 2, "saturate": 1.25, "refraction": 28, "highlight": 1, "magnify": 0.1},
	"tinted":  {"blur": 6, "saturate": 1.5, "refraction": 18, "highlight": 0.9, "magnify": 0.06},
}

var glassVeil = map[string]map[string]string{
	"light": {"regular": "#ffffff59", "clear": "#ffffff14", "tinted": "#ffffff33"},
	"dark":  {"regular": "#1c1c1e8c", "clear": "#00000014", "tinted": "#1c1c1e4d"},
}

func hexChannels(color string) ([4]float64, bool) {
	h := strings.TrimPrefix(strings.TrimSpace(color), "#")
	switch len(h) {
	case 3:
		h = string([]byte{h[0], h[0], h[1], h[1], h[2], h[2]}) + "ff"
	case 6:
		h += "ff"
	}
	var out [4]float64
	if len(h) != 8 {
		return out, false
	}
	for i := range out {
		v, err := strconv.ParseUint(h[i*2:i*2+2], 16, 8)
		if err != nil {
			return out, false
		}
		out[i] = float64(v) / 255
	}
	return out, true
}

// over composites top over bottom (both #rgb/#rrggbb/#rrggbbaa).
func over(top, bottom string) string {
	a, ok1 := hexChannels(top)
	b, ok2 := hexChannels(bottom)
	if !ok1 || !ok2 {
		return top
	}
	alpha := a[3] + b[3]*(1-a[3])
	if alpha <= 0 {
		return "#00000000"
	}
	hx := func(v float64) string { return fmt.Sprintf("%02x", int(math.Round(math.Min(1, math.Max(0, v))*255))) }
	mix := func(i int) float64 { return (a[i]*a[3] + b[i]*b[3]*(1-a[3])) / alpha }
	return "#" + hx(mix(0)) + hx(mix(1)) + hx(mix(2)) + hx(alpha)
}

func glassChrome(appearance string, shadow bool) S {
	light := appearance == "light"
	pick := func(l, d string) string {
		if light {
			return l
		}
		return d
	}
	shadows := []any{
		S{"inset": true, "y": 1, "blur": 1, "color": pick("#ffffff80", "#ffffff33")},
		S{"inset": true, "y": -1, "blur": 1, "color": pick("#00000014", "#00000059")},
	}
	if shadow {
		shadows = append(shadows, S{"y": 10, "blur": 30, "color": pick("#00000033", "#00000080")}, S{"y": 2, "blur": 6, "color": "#0000001f"})
	}
	return S{"borderWidth": 1, "borderColor": pick("#ffffff59", "#ffffff26"), "boxShadow": shadows}
}

// GlassOptions are glassSurface's options.
type GlassOptions struct {
	Tint     string
	Radius   *float64
	Material S
	Shadow   *bool
	Merge    string
	Blend    *float64
}

func glassSurface(variant, appearance string, o GlassOptions) S {
	bg := glassVeil[appearance][variant]
	if o.Tint != "" {
		bg = over(o.Tint, bg)
	}
	radius := 26.0
	if o.Radius != nil {
		radius = *o.Radius
	}
	material := merge(glassMaterial[variant])
	if appearance == "dark" {
		material["highlight"] = 0.55
	}
	if o.Merge != "" {
		blend := 32.0
		if o.Blend != nil {
			blend = *o.Blend
		}
		material["merge"], material["blend"] = o.Merge, blend
	}
	for k, v := range o.Material {
		material[k] = v
	}
	out := S{"background": bg, "radius": radius, "glass": material}
	if o.Merge != "" {
		out["borderWidth"], out["boxShadow"] = 0, []any{}
	} else {
		shadow := true
		if o.Shadow != nil {
			shadow = *o.Shadow
		}
		for k, v := range glassChrome(appearance, shadow) {
			out[k] = v
		}
	}
	return out
}

// Glass props: variant (regular, clear, tinted), tint, appearance (light), radius (26), material, shadow, merge, blend, style.
func Glass(p Props, kids ...Child) *VNode {
	p = props(p, kids)
	o := GlassOptions{Tint: str(p, "tint"), Merge: str(p, "merge")}
	if r, ok := num(p["radius"]); ok {
		o.Radius = &r
	}
	if m, ok := asMap(p["material"]); ok {
		o.Material = m
	}
	if s, ok := p["shadow"].(bool); ok {
		o.Shadow = &s
	}
	if b, ok := num(p["blend"]); ok {
		o.Blend = &b
	}
	surface := glassSurface(orString(p["variant"], "regular"), orString(p["appearance"], "light"), o)
	for _, k := range []string{"variant", "tint", "appearance", "radius", "material", "shadow", "merge", "blend"} {
		delete(p, k)
	}
	p["style"] = merge(surface, styleOf(p))
	return container("view", p, nil)
}
