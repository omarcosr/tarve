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
