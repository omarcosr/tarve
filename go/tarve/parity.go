package tarve

import (
	"fmt"
	"reflect"
)

// RenderDocument compiles view once, in a fresh render scope, and returns the SceneDocument JSON
// (no app identity or app options). The parity tests compare it with the TypeScript output.
func RenderDocument(view func() Child) []byte {
	return NewTestRenderer(view).Render()
}

// TestRenderer compiles a view repeatedly in one render scope and fires its handlers, like an app
// without a window.
type TestRenderer struct {
	view  func() Child
	scope *renderScope
	tree  *CompiledTree
	// Viewport is the window size breakpoints see (nil: the Window's width).
	Viewport *Size
}

func NewTestRenderer(view func() Child) *TestRenderer {
	return &TestRenderer{view: view, scope: newRenderScope()}
}

// Render compiles the view and returns the document JSON.
func (r *TestRenderer) Render() []byte {
	r.tree = compileTree(r.view, false, "auto", r.scope, true, r.Viewport, r.tree)
	r.tree.base, r.tree.fresh = nil, nil
	a := &App{}
	return append([]byte(nil), a.encodeDocument(r.tree)...)
}

// Fire calls handler (onClick, onHover…) of node id from the last render with JSON-decoded args.
func (r *TestRenderer) Fire(id, handler string, args ...any) error {
	h := r.tree.Handlers[id][handler]
	if h == nil {
		return fmt.Errorf("no %s on %s", handler, id)
	}
	r.scope.invalidate(id)
	fn := reflect.ValueOf(h)
	in := make([]reflect.Value, fn.Type().NumIn())
	for i := range in {
		t := fn.Type().In(i)
		var v any
		if i < len(args) {
			v = args[i]
		}
		switch {
		case v == nil:
			in[i] = reflect.Zero(t)
		case t == reflect.TypeOf(Size{}):
			m := v.(map[string]any)
			in[i] = reflect.ValueOf(Size{fnum(m["width"]), fnum(m["height"])})
		case t == reflect.TypeOf(ScrollInfo{}):
			m := v.(map[string]any)
			s, _ := m["source"].(string)
			in[i] = reflect.ValueOf(ScrollInfo{Source: s})
		case t == reflect.TypeOf([]VirtualListMeasurement{}):
			var list []VirtualListMeasurement
			for _, e := range v.([]any) {
				m := e.(map[string]any)
				k, _ := m["key"].(string)
				list = append(list, VirtualListMeasurement{Key: k, Height: fnum(m["height"])})
			}
			in[i] = reflect.ValueOf(list)
		case t.Kind() == reflect.Int:
			in[i] = reflect.ValueOf(int(fnum(v)))
		default:
			in[i] = reflect.ValueOf(v).Convert(t)
		}
	}
	fn.Call(in)
	return nil
}
