package tarve

import (
	"runtime"
	"strconv"
	"sync"
)

// Derived node styles, node reuse and the parallel compile of long lists.

func sameNodes(a, b []*NNode) bool {
	if len(a) != len(b) {
		return false
	}
	for i := range a {
		if a[i] != b[i] {
			return false
		}
	}
	return true
}

var noChildren = []*NNode{}

type derivedKey struct {
	entry *resolvedEntry
	ring  bool
	class uint8
	font  *interned
}

type derivedEntry struct {
	style, childFont *interned
}

// derive is a node's final style (theme-resolved, focus ring, inherited font) and the font its
// children inherit, cached per (style, inherited font): a list of equal rows computes it once.
func (c *compiler) derive(key derivedKey) *derivedEntry {
	if d := c.t.derived[key]; d != nil {
		return d
	}
	if c.base != nil {
		if d := c.base.derived[key]; d != nil {
			return d
		}
	}
	resolved := key.entry.resolved
	copied := false
	put := func(k string, v any) {
		if !copied {
			resolved, copied = merge(resolved), true
		}
		resolved[k] = v
	}
	if key.ring {
		put("focusVisible", resolveThemeStyle(S{"focusVisible": c.defaultFocusRing()}, c.theme)["focusVisible"])
	}
	parent := key.font.style
	switch key.class {
	case 1:
		init := c.initial()
		for _, k := range inheritedFont {
			if resolved[k] != nil {
				continue
			}
			v := parent[k]
			if v == nil {
				v = init[k]
			}
			if v != nil {
				put(k, v)
			}
		}
	case 2:
		for _, k := range controlFont {
			if resolved[k] == nil && parent[k] != nil {
				put(k, parent[k])
			}
		}
		if resolved["fontFamily"] == nil {
			put("fontFamily", FontFamily)
		}
	}
	d := &derivedEntry{style: c.intern(0, resolved), childFont: key.font}
	var own S
	for k, v := range d.style.style {
		if !inheritedFontSet[k] || v == nil || sameValue(v, parent[k]) {
			continue
		}
		if own == nil {
			own = merge(parent)
		}
		own[k] = v
	}
	if own != nil {
		d.childFont = c.intern(1, own)
	}
	c.t.derived[key] = d
	return d
}

// visitRange compiles v[lo:hi]; firstEl is the number of element children before lo, elements their total.
func (c *compiler) visitRange(v []Child, lo, hi, firstEl, elements int, path, group string, out []*NNode) []*NNode {
	seenEl := firstEl
	for i := lo; i < hi; i++ {
		item := v[i]
		primitive := isPrimitive(item)
		if primitive && i > 0 && isPrimitive(v[i-1]) {
			continue
		}
		var key any
		if el, ok := item.(*VNode); ok && el != nil {
			key = el.Key
		}
		piece := item
		if primitive {
			text, _ := jsString(item)
			for n := i + 1; n < len(v) && isPrimitive(v[n]); n++ {
				s, _ := jsString(v[n])
				text += s
			}
			piece = text
		}
		var sub string
		if key != nil {
			k, _ := jsString(key)
			sub = path + "/k:" + k
		} else {
			sub = path + "/" + strconv.Itoa(i)
		}
		if el, ok := item.(*VNode); ok && el != nil {
			c.pos = &position{seenEl, elements}
			seenEl++
		}
		out = c.visit(piece, sub, group, out)
		c.pos = nil
	}
	return out
}

// Lists this long compile on several goroutines.
const parallelMin = 256

var workers = runtime.GOMAXPROCS(0)

// parallelSafe: the subtrees hold only elements, no Memo or Component (user code that may share
// state) and no window or media; they compile the same on any goroutine.
func parallelSafe(list []Child) bool {
	var ok func(Child) bool
	ok = func(c Child) bool {
		switch v := c.(type) {
		case nil, bool, string:
			return true
		case []Child:
			for _, x := range v {
				if !ok(x) {
					return false
				}
			}
			return true
		case *VNode:
			if v == nil {
				return true
			}
			switch v.Type {
			case "window", "audio", "video":
				return false
			}
			if _, isString := v.Type.(string); !isString {
				return false
			}
			return ok(v.Props["children"])
		}
		_, isNum := num(c)
		return isNum
	}
	return ok(list)
}

func (c *compiler) worker() *compiler {
	return &compiler{debug: c.debug, visible: c.visible, scope: c.scope, handlers: map[string]Handlers{}, nodes: map[string]*NNode{},
		media: map[string]*MediaRequest{}, window: c.window, theme: c.theme, font: c.font, memoSeen: map[string]bool{},
		width: c.width, t: newTables(c.theme), base: c.t, memoDepth: c.memoDepth, focusRing: c.focusRing, initialFont: c.initialFont, prev: c.prev}
}

func (c *compiler) visitParallel(v []Child, path, group string, out []*NNode) []*NNode {
	c.defaultFocusRing()
	c.initial()
	before := make([]int, len(v)+1)
	for i, item := range v {
		before[i+1] = before[i]
		if el, ok := item.(*VNode); ok && el != nil {
			before[i+1]++
		}
	}
	n := min(workers, len(v)/64)
	parts := make([]*compiler, n)
	results := make([][]*NNode, n)
	panics := make([]any, n)
	var wg sync.WaitGroup
	for w := 0; w < n; w++ {
		lo, hi := len(v)*w/n, len(v)*(w+1)/n
		wc := c.worker()
		parts[w] = wc
		wg.Add(1)
		go func(w, lo, hi int) {
			defer wg.Done()
			defer func() { panics[w] = recover() }()
			results[w] = wc.visitRange(v, lo, hi, before[lo], before[len(v)], path, group, make([]*NNode, 0, hi-lo))
		}(w, lo, hi)
	}
	wg.Wait()
	for _, p := range panics {
		if p != nil {
			panic(p)
		}
	}
	for w, wc := range parts {
		remap := c.t.absorb(wc.t)
		for id, node := range wc.nodes {
			if _, taken := c.nodes[id]; taken {
				panic("tarve: duplicate node id: " + id)
			}
			if node != nil {
				if r := remap[node.style]; r != nil {
					node.style, node.Style = r, r.style
				}
			}
			c.nodes[id] = node
		}
		for _, node := range wc.fresh {
			if r := remap[node.style]; r != nil {
				node.style, node.Style = r, r.style
			}
		}
		c.fresh = append(c.fresh, wc.fresh...)
		for id, h := range wc.handlers {
			c.handlers[id] = h
		}
		c.order = append(c.order, wc.order...)
		if c.memoDepth > 0 {
			c.idLog = append(c.idLog, wc.idLog...)
		}
		c.usesViewport = c.usesViewport || wc.usesViewport
		out = append(out, results[w]...)
	}
	return out
}
