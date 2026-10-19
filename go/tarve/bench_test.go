package tarve

import "testing"

func benchView(tick *int) func() Child {
	return func() Child {
		rows := make([]Child, 2000)
		for i := range rows {
			rows[i] = Row(Props{"key": i, "style": S{"height": 36, "shrink": 0}, "gap": 12},
				Text(Props{"style": S{"flex": 1}}, "Record ", i, ": native layout and text"),
				Button(Props{"size": "sm"}, "Open"))
		}
		return Window(Props{"title": "bench", "width": 1024, "height": 760},
			Column(Props{"padding": 16, "gap": 12, "flex": 1},
				Text(nil, "Tick ", *tick),
				Scroll(Props{"id": "list", "flex": 1}, Column(nil, rows))))
	}
}

// BenchmarkUpdate2000Rows is one app update of the bench scene: render, compile, diff and encode.
func BenchmarkUpdate2000Rows(b *testing.B) {
	tick := 0
	a := newApp(benchView(&tick), Options{}, nil)
	tree, _ := a.compileView()
	a.committed, a.observed = tree, a.nativeShadow(tree, nil)
	b.ReportAllocs()
	for b.Loop() {
		tick++
		next, _ := a.compileView()
		a.reconciliationCommand(a.observed, next)
		next.base, next.fresh, next.freshSet = nil, nil, nil
		a.observed = a.nativeShadow(next, a.observed)
		a.committed = next
	}
}

// BenchmarkView2000Rows is building the elements alone (the app's view function).
func BenchmarkView2000Rows(b *testing.B) {
	tick := 0
	view := benchView(&tick)
	b.ReportAllocs()
	for b.Loop() {
		view()
	}
}

// BenchmarkFirstDocument is the first frame's Go side: compile the view and encode the document.
func BenchmarkFirstDocument(b *testing.B) {
	tick := 0
	b.ReportAllocs()
	for b.Loop() {
		a := newApp(benchView(&tick), Options{}, nil)
		tree, _ := a.compileView()
		a.encodeDocument(tree)
	}
}
