package tarve

import (
	"math"
	"reflect"
	"strconv"
)

// S is a style object (@tarve/protocol Style). A nil value unsets the key, like undefined.
type S = map[string]any

// Props are component props, named as in @tarve/core (onClick, style, control…).
type Props = map[string]any

// Child is what JSX accepts as a child: *VNode, string, number, bool, nil or []Child.
type Child = any

// Component renders props to a child (a VNode, usually).
type Component func(Props) Child

// VNode is a JSX element: a native kind ("view", "text"…), an intrinsic ("audio"),
// a Component or a *Memo, with its props and list key.
type VNode struct {
	Type   any
	Props  Props
	Key    any
	native bool
	// intrinsic: built by E with an element name, so list position variants apply to it (as to a JSX <div>).
	intrinsic bool
}

const fragmentType = "fragment"

// withChildren puts JSX children into props.children the way the TSX compiler does:
// none → unset, one → the child itself, several → an array.
func withChildren(p Props, kids []Child) Props {
	switch len(kids) {
	case 0:
	case 1:
		p["children"] = kids[0]
	default:
		p["children"] = []Child(kids)
	}
	return p
}

func copyProps(p Props) Props {
	out := make(Props, len(p)+2)
	for k, v := range p {
		out[k] = v
	}
	return out
}

func jsx(t any, p Props) *VNode {
	if p == nil {
		p = Props{}
	}
	key := p["key"]
	if key != nil {
		delete(p, "key")
	}
	return &VNode{Type: t, Props: p, Key: key}
}

func nativeJsx(t string, p Props) *VNode {
	v := jsx(t, p)
	v.native = true
	return v
}

// E builds an element: E("view", props, children…), E(component, …) or E(memo, …).
// A "key" prop becomes the element's list key, as in JSX. Elements and components own the props
// they are given (JSX makes a fresh object per element): pass a new Props each time.
func E(t any, p Props, kids ...Child) *VNode {
	if p == nil {
		p = Props{}
	}
	if len(kids) > 0 {
		withChildren(p, kids)
	}
	v := jsx(t, p)
	_, v.intrinsic = t.(string)
	return v
}

// Fragment groups children without a node, as <>…</>.
func Fragment(kids ...Child) *VNode { return jsx(fragmentType, withChildren(Props{}, kids)) }

// Memo is @tarve/core memo(): the subtree is compiled again only when the props change.
type Memo struct {
	Render Component
	Equal  func(previous, next Props) bool
}

// NewMemo wraps render; equal defaults to a shallow comparison of every prop.
func NewMemo(render Component, equal func(previous, next Props) bool) *Memo {
	if equal == nil {
		equal = ShallowEqual
	}
	return &Memo{Render: render, Equal: equal}
}

// ShallowEqual is @tarve/core shallowEqual: same keys, each value identical (Object.is).
func ShallowEqual(a, b Props) bool {
	if len(a) != len(b) {
		return false
	}
	for k, v := range a {
		w, ok := b[k]
		if !ok || !same(v, w) {
			return false
		}
	}
	return true
}

// same is Object.is for Go values: primitives by value, references (slices, maps,
// pointers, funcs) by identity.
func same(a, b any) bool {
	if a == nil || b == nil {
		return a == nil && b == nil
	}
	ra, rb := reflect.ValueOf(a), reflect.ValueOf(b)
	if ra.Type() != rb.Type() {
		return false
	}
	switch ra.Kind() {
	case reflect.Slice:
		return ra.Len() == rb.Len() && (ra.Len() == 0 || ra.Pointer() == rb.Pointer())
	case reflect.Map, reflect.Pointer, reflect.Func, reflect.Chan, reflect.UnsafePointer:
		return ra.Pointer() == rb.Pointer()
	case reflect.Float32, reflect.Float64:
		x, y := ra.Float(), rb.Float()
		return x == y || (math.IsNaN(x) && math.IsNaN(y))
	}
	if ra.Type().Comparable() {
		return a == b
	}
	return false
}

// num reads a JS number from any Go numeric value.
func num(v any) (float64, bool) {
	switch x := v.(type) {
	case string, nil, bool, map[string]any:
		return 0, false
	case float64:
		return x, true
	case int:
		return float64(x), true
	case float32:
		return float64(x), true
	case int64:
		return float64(x), true
	case int32:
		return float64(x), true
	case uint32:
		return float64(x), true
	case uint64:
		return float64(x), true
	}
	return 0, false
}

// jsString is String(value) for strings and numbers.
func jsString(v any) (string, bool) {
	switch x := v.(type) {
	case string:
		return x, true
	case int:
		return strconv.Itoa(x), true
	}
	if f, ok := num(v); ok {
		return formatNumber(f), true
	}
	return "", false
}

func formatNumber(f float64) string {
	switch {
	case math.IsNaN(f):
		return "NaN"
	case math.IsInf(f, 1):
		return "Infinity"
	case math.IsInf(f, -1):
		return "-Infinity"
	case f == 0:
		return "0"
	}
	a := math.Abs(f)
	if a >= 1e21 || a < 1e-6 {
		s := strconv.FormatFloat(f, 'e', -1, 64)
		return s
	}
	return strconv.FormatFloat(f, 'f', -1, 64)
}

func asMap(v any) (map[string]any, bool) {
	m, ok := v.(map[string]any)
	return m, ok && m != nil
}

// merge returns a copy of the styles applied in order; a nil value removes its key.
func merge(styles ...S) S {
	n := 0
	for _, s := range styles {
		n += len(s)
	}
	out := make(S, n)
	for _, s := range styles {
		for k, v := range s {
			if v == nil {
				delete(out, k)
			} else {
				out[k] = v
			}
		}
	}
	return out
}

func styleOf(p Props) S {
	s, _ := p["style"].(S)
	return s
}

func str(p Props, key string) string {
	s, _ := p[key].(string)
	return s
}

func truthy(v any) bool {
	switch x := v.(type) {
	case nil:
		return false
	case bool:
		return x
	case string:
		return x != ""
	}
	if f, ok := num(v); ok {
		return f != 0 && !math.IsNaN(f)
	}
	return true
}

func numOr(p Props, key string, fallback float64) float64 {
	if f, ok := num(p[key]); ok {
		return f
	}
	return fallback
}
