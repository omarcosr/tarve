package tarve

import "testing"

func TestSliderPaintsTakeGradientsAndTheThumbACSSShadow(t *testing.T) {
	style := resolveThemeStyle(S{
		"trackBackground":  "linear-gradient(to right, red, blue)",
		"thumbColor":       "radial-gradient(#fff, #000)",
		"thumbBorderColor": "rgb(255 0 0)",
		"thumbShadow":      "0 2px 6px rgba(0,0,0,.5)",
	}, LightTheme)
	for _, key := range []string{"trackBackground", "thumbColor"} {
		if _, ok := style[key].(map[string]any); !ok {
			t.Fatalf("%s should resolve to a gradient object, got %#v", key, style[key])
		}
	}
	if style["thumbBorderColor"] != "#ff0000ff" && style["thumbBorderColor"] != "#ff0000" {
		t.Fatalf("thumbBorderColor = %#v", style["thumbBorderColor"])
	}
	if shadows, ok := style["thumbShadow"].([]any); !ok || len(shadows) != 1 {
		t.Fatalf("thumbShadow = %#v", style["thumbShadow"])
	}
}
