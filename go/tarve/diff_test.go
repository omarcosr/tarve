package tarve

import (
	"fmt"
	"sort"
	"testing"
)

func mutationKeys(muts []mutation) []string {
	out := make([]string, len(muts))
	for i, m := range muts {
		switch m.kind {
		case "create", "patch":
			out[i] = m.kind + ":" + string(appendNode(nil, m.node, false))
		case "children":
			out[i] = fmt.Sprint("children:", m.id, m.children)
		default:
			out[i] = m.kind + ":" + m.id
		}
	}
	sort.Strings(out)
	return out
}

// TestFastDiffMatchesFullDiff renders a list through inserts, removals, reorders, style and text
// changes and typed input values, and requires the incremental diff to equal the full one.
func TestFastDiffMatchesFullDiff(t *testing.T) {
	step := 0
	view := func() Child {
		rows := []Child{}
		n := 400 + (step%3)*50
		for i := 0; i < n; i++ {
			k := i
			if step%4 == 2 {
				k = n - i
			}
			bg := "#111111"
			if (i+step)%17 == 0 {
				bg = "#222222"
			}
			rows = append(rows, Row(Props{"key": k, "style": S{"height": 30, "background": bg}},
				Text(nil, "Row ", k), Button(Props{"size": "sm", "onClick": func() {}}, "Open")))
		}
		return Window(Props{"title": fmt.Sprint("t", step%2), "width": 800, "height": 600},
			Input(Props{"id": "field", "placeholder": "x"}),
			Text(nil, "Tick ", step),
			Column(nil, rows))
	}
	a := newApp(view, Options{}, nil)
	tree, _ := a.compileView()
	a.committed, a.observed = tree, a.nativeShadow(tree, nil)
	for step = 1; step < 14; step++ {
		if step%5 == 0 {
			a.editShadow("field", S{"value": fmt.Sprint("typed", step)})
		}
		next, err := a.compileView()
		if err != nil {
			t.Fatal(err)
		}
		fast, ok1 := a.fastDiff(a.observed, next)
		full, ok2 := diffTreeMutations(a.observed, next, a.carried)
		if ok1 != ok2 {
			t.Fatalf("step %d: fast ok %v, full ok %v", step, ok1, ok2)
		}
		f, g := mutationKeys(fast), mutationKeys(full)
		if fmt.Sprint(f) != fmt.Sprint(g) {
			t.Fatalf("step %d: fast %d mutations, full %d", step, len(f), len(g))
		}
		next.base, next.fresh, next.freshSet = nil, nil, nil
		a.observed = a.nativeShadow(next, a.observed)
		a.committed = next
	}
}
