package tarve

import "testing"

func TestOrientationPointerAndMotionVariantsFold(t *testing.T) {
	defer setEnvironment(map[string]any{"fontScale": 1.0, "pointer": defaultPointer()})
	style := S{"width": 1, "portrait": S{"width": 10}, "landscape": S{"width": 20},
		"pointerCoarse": S{"minHeight": 48}, "motionReduce": S{"opacity": 1}, "motionSafe": S{"opacity": 0.5}}
	view := func(w, h float64) S {
		tree := compileTree(func() Child {
			return Window(Props{"title": "v"}, View(Props{"id": "box", "style": style}))
		}, false, "auto", nil, true, &Size{w, h}, nil)
		return tree.Nodes["box"].Style
	}
	setEnvironment(map[string]any{"fontScale": 1.0, "pointer": "fine"})
	if s := view(400, 800); fnum(s["width"]) != 10 || s["minHeight"] != nil || fnum(s["opacity"]) != 0.5 {
		t.Fatalf("portrait, fine pointer: %v", s)
	}
	setEnvironment(map[string]any{"fontScale": 1.5, "reducedMotion": true, "pointer": "coarse"})
	if s := view(800, 400); fnum(s["width"]) != 20 || fnum(s["minHeight"]) != 48 || fnum(s["opacity"]) != 1 {
		t.Fatalf("landscape, coarse pointer, reduced motion: %v", s)
	}
}

func TestViewportReadsTheRenderSizeAndMarksTheTree(t *testing.T) {
	defer setEnvironment(map[string]any{"fontScale": 1.0, "pointer": defaultPointer()})
	setEnvironment(map[string]any{"fontScale": 1.3, "pointer": "coarse"})
	var seen ViewportInfo
	tree := compileTree(func() Child {
		seen = Viewport()
		return Window(Props{"title": "v"})
	}, false, "auto", nil, true, &Size{411, 860}, nil)
	want := ViewportInfo{Width: 411, Height: 860, Orientation: "portrait", Pointer: "coarse", FontScale: 1.3}
	if seen != want {
		t.Fatalf("Viewport() = %+v, want %+v", seen, want)
	}
	if !tree.ReadsViewportSize || !tree.UsesViewport || tree.Environment == "" || tree.Root.F["reportSize"] != true {
		t.Fatalf("tree flags: size %v viewport %v environment %q", tree.ReadsViewportSize, tree.UsesViewport, tree.Environment)
	}
	plain := compileTree(func() Child { return Window(Props{"title": "v"}) }, false, "auto", nil, true, &Size{411, 860}, nil)
	if plain.ReadsViewportSize || plain.Environment != "" {
		t.Fatal("a view that reads nothing is not marked")
	}
}

func TestViewportUnitsResolveToPx(t *testing.T) {
	view := func(w, h float64) *CompiledTree {
		return compileTree(func() Child {
			return Window(Props{"title": "v"}, View(Props{"id": "hero", "style": S{"height": "50vh", "width": "100vw", "minHeight": "10vmin", "padding": S{"top": "5vh", "left": 8}}}))
		}, false, "auto", nil, true, &Size{w, h}, nil)
	}
	tree := view(1200, 800)
	style := tree.Nodes["hero"].Style
	if style["height"] != 400.0 || style["width"] != 1200.0 || style["minHeight"] != 80.0 || style["padding"].(S)["top"] != 40.0 {
		t.Fatalf("resolved style %v", style)
	}
	if !tree.UsesViewport {
		t.Fatal("viewport units do not mark the tree as reading the viewport")
	}
}

func TestCssDropShadowFilter(t *testing.T) {
	style := resolveThemeStyle(S{"filter": "drop-shadow(0 2px 6px rgba(0, 0, 0, 0.5)) blur(2px)"}, LightTheme)
	f := style["filter"].(S)
	if f["blur"] != 2.0 || f["dropShadow"].(S)["y"] != 2.0 || f["dropShadow"].(S)["blur"] != 6.0 {
		t.Fatalf("filter %v", f)
	}
}

func TestCssLayersCompileToNativeForms(t *testing.T) {
	style := resolveThemeStyle(S{"backdropFilter": "blur(20px) saturate(160%)", "filter": "blur(90px)", "backgroundLayers": []any{"#ff000033"}}, LightTheme)
	glass := style["glass"].(S)
	if glass["blur"] != 20.0 || glass["saturate"] != 1.6 || style["filter"].(S)["blur"] != 90.0 || style["backdropFilter"] != nil {
		t.Fatalf("resolved %v", style)
	}
}

func TestCssGradientsMaskAndLayersResolve(t *testing.T) {
	style := resolveThemeStyle(S{"background": "radial-gradient(circle at top, #ff000033, transparent 60%), linear-gradient(to bottom, #111, #000)",
		"maskImage": "linear-gradient(to bottom, black 60%, transparent)"}, LightTheme)
	bg := style["background"].(S)
	layers := style["backgroundLayers"].([]any)
	mask := style["maskImage"].(S)
	if bg["type"] != "linear" || bg["to"] != "bottom" || len(layers) != 1 || layers[0].(S)["type"] != "radial" || layers[0].(S)["shape"] != "circle" {
		t.Fatalf("background %v layers %v", bg, layers)
	}
	stops := mask["stops"].([]any)
	if stops[0].(S)["offset"] != 0.6 || stops[1].(S)["color"] != "#00000000" {
		t.Fatalf("mask %v", mask)
	}
}

func TestCssShadowStrings(t *testing.T) {
	style := resolveThemeStyle(S{"boxShadow": "0 4px 12px rgba(0, 0, 0, 0.5), inset 0 1px 0 #fff", "textShadow": "0 1px 2px black"}, LightTheme)
	box := style["boxShadow"].([]any)
	if len(box) != 2 || box[0].(S)["blur"] != 12.0 || box[1].(S)["inset"] != true || style["textShadow"].(S)["y"] != 1.0 {
		t.Fatalf("shadows %v %v", box, style["textShadow"])
	}
}

func TestTitleBarHoverIsAWashNotTheGlyphColour(t *testing.T) {
	if got := translucent(T.Foreground, 0x1f); got != T.Foreground+"/12" {
		t.Fatalf("token wash %q", got)
	}
	if got := translucent("rgba(255, 255, 255, 0.9)", 0x1f); got != "#ffffff1f" {
		t.Fatalf("rgba wash %q", got)
	}
}
