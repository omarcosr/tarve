package tarve

import "math"

// sameValue is @tarve/core sameValue: deep equality of JSON-like values.
func sameValue(a, b any) bool {
	switch x := a.(type) {
	case string:
		y, ok := b.(string)
		return ok && x == y
	case int:
		if y, ok := b.(int); ok {
			return x == y
		}
	case float64:
		if y, ok := b.(float64); ok {
			return x == y || math.IsNaN(x) && math.IsNaN(y)
		}
	}
	if fa, ok := num(a); ok {
		fb, ok := num(b)
		return ok && (fa == fb || math.IsNaN(fa) && math.IsNaN(fb))
	}
	switch x := a.(type) {
	case nil:
		return b == nil
	case bool:
		y, ok := b.(bool)
		return ok && x == y
	case map[string]any:
		y, ok := b.(map[string]any)
		if !ok || len(x) != len(y) {
			return false
		}
		for k, v := range x {
			w, ok := y[k]
			if !ok || !sameValue(v, w) {
				return false
			}
		}
		return true
	case []any:
		y, ok := b.([]any)
		if !ok || len(x) != len(y) {
			return false
		}
		for i := range x {
			if !sameValue(x[i], y[i]) {
				return false
			}
		}
		return true
	case []string:
		y, ok := b.([]string)
		if !ok || len(x) != len(y) {
			return false
		}
		for i := range x {
			if x[i] != y[i] {
				return false
			}
		}
		return true
	}
	return same(a, b)
}

func sameChildren(a, b *NNode) bool {
	if len(a.Children) != len(b.Children) {
		return false
	}
	for i := range a.Children {
		if a.Children[i].ID != b.Children[i].ID {
			return false
		}
	}
	return true
}

func propertiesChanged(old, n *NNode) bool {
	if !(len(old.F) == 0 && len(n.F) == 0) && !sameValue(old.F, n.F) {
		return true
	}
	if old.style != nil && old.style == n.style {
		return false
	}
	return !sameValue(old.Style, n.Style)
}

type mutation struct {
	kind     string
	node     *NNode
	id       string
	children []string
}

// diffTreeMutations is @tarve/core diffTreeMutations; nil means the whole tree must be sent.
func diffTreeMutations(previous, next *CompiledTree, carried map[*NNode]*NNode) ([]mutation, bool) {
	if previous.Root.ID != next.Root.ID {
		return nil, false
	}
	var creates, patches, children, removes []mutation
	ids := func(n *NNode) []string {
		out := make([]string, len(n.Children))
		for i, c := range n.Children {
			out[i] = c.ID
		}
		return out
	}
	for id, n := range next.Nodes {
		old := previous.Nodes[id]
		if old == nil {
			creates = append(creates, mutation{kind: "create", node: n})
			if len(n.Children) > 0 {
				children = append(children, mutation{kind: "children", id: id, children: ids(n)})
			}
			continue
		}
		if old == n || carried[old] == n {
			continue
		}
		if old.Kind != n.Kind {
			return nil, false
		}
		if propertiesChanged(old, n) {
			patches = append(patches, mutation{kind: "patch", node: n})
		}
		if !sameChildren(old, n) {
			children = append(children, mutation{kind: "children", id: id, children: ids(n)})
		}
	}
	for id := range previous.Nodes {
		if next.Nodes[id] == nil {
			removes = append(removes, mutation{kind: "remove", id: id})
		}
	}
	out := append(creates, patches...)
	out = append(out, children...)
	return append(out, removes...), true
}
