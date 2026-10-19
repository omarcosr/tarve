package tarve

import (
	"math"
	"strconv"
)

// ScrollInfo says what moved a scroll container: "user", "program" or "layout".
type ScrollInfo struct{ Source string }

// VirtualListMeasurement is a rendered row's measured height (variable lists).
type VirtualListMeasurement struct {
	Key    string
	Height float64
}

const fillEstimate = 800

type variableListState struct {
	heights         map[string]float64
	order           []string
	effectiveOffset float64
	lastExternal    *float64
	anchorKey       string
	hasAnchor       bool
	anchorInset     float64
	anchorEdge      string
	followingTail   bool
	lastFollowTail  bool
	scrollRequest   *scrollRequest
	focusedKey      string
	lastSeenEpoch   int
}

type scrollRequest struct {
	generation int
	index      int
	offset     float64
	smooth     bool
}

type variableListStore struct {
	states         map[string]*variableListState
	nextGeneration int
	lastSweep      int
}

func itemToken(key any) string {
	if s, ok := key.(string); ok {
		return "s:" + s
	}
	k, _ := jsString(key)
	return "n:" + k
}

func upperBoundPrefix(prefix []float64, offset float64) int {
	low, high := 0, len(prefix)-1
	for low < high {
		mid := (low + high) / 2
		if prefix[mid+1] <= offset {
			low = mid + 1
		} else {
			high = mid
		}
	}
	return min(low, len(prefix)-2)
}

var filling bool

func viewportStyle(style S, height float64) S {
	if filling {
		return merge(S{"flex": 1, "minHeight": 0}, style)
	}
	return merge(style, S{"height": height, "shrink": 0})
}

// VirtualList renders only the rows in view.
// Props: id, count (item count), itemHeight (fixed) or estimatedItemHeight (variable), height (unset: fills its parent),
// offset, overscan (2), keyForItem func(int) any, renderItem func(int) Child,
// onScroll func(offset, max float64, info ScrollInfo), alignment, followTail, style; other props go to the Scroll.
func VirtualList(p Props) *VNode {
	if p["height"] == nil {
		id := str(p, "id")
		if id == "" {
			panic("tarve: VirtualList without a height needs an id to remember its measured height")
		}
		heights := scopedState("tarve.filledHeights", func() map[string]float64 { return map[string]float64{} })
		h, ok := heights[id]
		if !ok {
			h = fillEstimate
		}
		onSize, _ := p["onSize"].(func(Size))
		q := copyProps(p)
		q["height"] = h
		q["onSize"] = func(size Size) {
			if size.Height > 0 {
				heights[id] = size.Height
			}
			if onSize != nil {
				onSize(size)
			}
		}
		filling = true
		defer func() { filling = false }()
		return VirtualList(q)
	}
	if p["estimatedItemHeight"] != nil {
		return variableVirtualList(p)
	}
	return fixedVirtualList(p)
}

func listRest(p Props) Props {
	rest := Props{}
	for k, v := range p {
		switch k {
		case "count", "itemHeight", "estimatedItemHeight", "height", "offset", "overscan", "keyForItem", "renderItem", "onScroll", "alignment", "followTail", "style":
		default:
			rest[k] = v
		}
	}
	return rest
}

func overscanOf(p Props) int {
	if f, ok := num(p["overscan"]); ok {
		if f < 0 || f != math.Trunc(f) {
			panic("tarve: VirtualList overscan must be a nonnegative integer")
		}
		return int(f)
	}
	return 2
}

func fixedVirtualList(p Props) *VNode {
	count := int(numOr(p, "count", 0))
	itemHeight, height, offset := numOr(p, "itemHeight", 0), numOr(p, "height", fillEstimate), numOr(p, "offset", 0)
	overscan := overscanOf(p)
	if itemHeight <= 0 || height <= 0 || offset < 0 {
		panic("tarve: VirtualList requires positive fixed heights and a nonnegative offset")
	}
	keyFor, _ := p["keyForItem"].(func(int) any)
	render, _ := p["renderItem"].(func(int) Child)
	total := float64(count) * itemHeight
	scroll := math.Min(offset, math.Max(0, total-height))
	start := max(0, int(math.Floor(scroll/itemHeight))-overscan)
	end := min(count, int(math.Ceil((scroll+height)/itemHeight))+overscan)
	children := []Child{}
	if start > 0 {
		children = append(children, Row(Props{"key": "before", "style": S{"height": float64(start) * itemHeight, "shrink": 0}}))
	} else {
		children = append(children, nil)
	}
	for i := start; i < end; i++ {
		var key any = i
		if keyFor != nil {
			key = keyFor(i)
		}
		children = append(children, Row(Props{"key": key, "style": S{"width": "100%", "height": itemHeight, "shrink": 0}, "children": render(i)}))
	}
	if end < count {
		children = append(children, Row(Props{"key": "after", "style": S{"height": float64(count-end) * itemHeight, "shrink": 0}}))
	} else {
		children = append(children, nil)
	}
	q := listRest(p)
	q["onScroll"] = p["onScroll"]
	q["control"] = S{"role": "virtualList", "value": scroll}
	q["style"] = viewportStyle(styleOf(p), height)
	q["children"] = Column(Props{"style": S{"width": "100%"}, "children": children})
	return Scroll(q)
}

func (s *variableListStore) state(id string) *variableListState {
	epoch := activeScope.epoch
	if epoch > s.lastSweep {
		for k, st := range s.states {
			if st.lastSeenEpoch < epoch-1 {
				delete(s.states, k)
			}
		}
		s.lastSweep = epoch
	}
	if st := s.states[id]; st != nil {
		st.lastSeenEpoch = epoch
		return st
	}
	st := &variableListState{heights: map[string]float64{}, anchorEdge: "top", lastSeenEpoch: epoch}
	s.states[id] = st
	return st
}

func variableVirtualList(p Props) *VNode {
	id := str(p, "id")
	if id == "" {
		panic("tarve: variable VirtualList requires a stable id")
	}
	count := int(numOr(p, "count", 0))
	estimated, height, offset := numOr(p, "estimatedItemHeight", 0), numOr(p, "height", fillEstimate), numOr(p, "offset", 0)
	overscan := overscanOf(p)
	alignment := orString(p["alignment"], "top")
	followTail := truthy(p["followTail"])
	if estimated <= 0 || height <= 0 || offset < 0 {
		panic("tarve: variable VirtualList requires a positive estimatedItemHeight/height and nonnegative offset")
	}
	keyFor, _ := p["keyForItem"].(func(int) any)
	render, _ := p["renderItem"].(func(int) Child)
	onScroll, _ := p["onScroll"].(func(float64, float64, ScrollInfo))
	rawKeys := make([]any, count)
	keys := make([]string, count)
	unique := make(map[string]int, count)
	for i := range keys {
		rawKeys[i] = keyFor(i)
		keys[i] = itemToken(rawKeys[i])
		unique[keys[i]] = i
	}
	if len(unique) != count {
		panic("tarve: variable VirtualList requires unique keyForItem values")
	}
	store := scopedState("tarve.variableLists", func() *variableListStore { return &variableListStore{states: map[string]*variableListState{}} })
	st := store.state(id)
	for k := range st.heights {
		if _, ok := unique[k]; !ok {
			delete(st.heights, k)
		}
	}
	if st.focusedKey != "" {
		if _, ok := unique[st.focusedKey]; !ok {
			st.focusedKey = ""
		}
	}
	prefix := make([]float64, count+1)
	for i := 0; i < count; i++ {
		h, ok := st.heights[keys[i]]
		if !ok {
			h = estimated
		}
		prefix[i+1] = prefix[i] + h
	}
	total := prefix[count]
	maxScroll := math.Max(0, total-height)
	firstRender := st.lastExternal == nil
	externalChanged := firstRender || math.Abs(offset-*st.lastExternal) > 1e-6
	if followTail && !st.lastFollowTail {
		st.followingTail = true
	}
	if !followTail {
		st.followingTail = false
	}
	st.lastFollowTail = followTail
	requested, hasRequested := 0.0, false
	if st.scrollRequest != nil && count > 0 {
		idx := min(st.scrollRequest.index, count-1)
		requested, hasRequested = math.Max(0, math.Min(prefix[idx]+st.scrollRequest.offset, maxScroll)), true
	}
	switch {
	case hasRequested && !st.scrollRequest.smooth:
		st.effectiveOffset = requested
	case followTail && st.followingTail:
		st.effectiveOffset = maxScroll
	case firstRender && alignment == "bottom":
		st.effectiveOffset = maxScroll
	case externalChanged:
		st.effectiveOffset = offset
	case st.hasAnchor:
		if i, ok := unique[st.anchorKey]; ok {
			if st.anchorEdge == "bottom" {
				st.effectiveOffset = prefix[i+1] + st.anchorInset - height
			} else {
				st.effectiveOffset = prefix[i] + st.anchorInset
			}
		}
	}
	scroll := math.Max(0, math.Min(st.effectiveOffset, maxScroll))
	st.effectiveOffset = scroll
	first := 0
	if count > 0 {
		first = upperBoundPrefix(prefix, scroll)
	}
	last := first
	for last < count && prefix[last] < scroll+height {
		last++
	}
	start := max(0, first-overscan)
	end := min(count, max(first+1, last)+overscan)
	if count > 0 {
		anchor := first
		if alignment == "bottom" {
			anchor = max(first, last-1)
		}
		st.anchorKey, st.hasAnchor = keys[anchor], true
		if alignment == "bottom" {
			st.anchorInset = scroll + height - prefix[anchor+1]
		} else {
			st.anchorInset = scroll - prefix[anchor]
		}
	} else {
		st.anchorKey, st.hasAnchor, st.anchorInset = "", false, 0
	}
	st.anchorEdge = alignment
	ext := offset
	st.lastExternal = &ext
	row := func(i int) *VNode {
		return Row(Props{"key": rawKeys[i], "style": S{"width": "100%", "shrink": 0}, "children": render(i)})
	}
	children := []Child{nil}
	if start > 0 {
		children[0] = Row(Props{"key": "before", "style": S{"height": prefix[start], "shrink": 0}})
	}
	for i := start; i < end; i++ {
		children = append(children, row(i))
	}
	var after Child
	if end < count {
		after = Row(Props{"key": "after", "style": S{"height": total - prefix[end], "shrink": 0}})
	}
	children = append(children, after)
	retainedKey := ""
	if i, ok := unique[st.focusedKey]; ok && st.focusedKey != "" && (i < start || i >= end) {
		retainedKey = st.focusedKey
		r := row(i)
		r.Props = copyProps(r.Props)
		r.Props["style"] = merge(styleOf(r.Props), S{"position": "absolute", "top": -1_000_000, "left": 0, "width": "100%", "shrink": 0})
		children = append(children, r)
	} else {
		children = append(children, nil)
	}
	rendered := make([]any, 0, end-start)
	for _, k := range keys[start:end] {
		rendered = append(rendered, k)
	}
	vl := S{"estimatedItemHeight": estimated, "itemCount": count, "windowStart": start, "windowEnd": end, "renderedKeys": rendered,
		"alignment": alignment, "followTail": followTail}
	if retainedKey != "" {
		vl["retainedKey"] = retainedKey
	}
	if hasRequested && st.scrollRequest != nil {
		r := S{"generation": st.scrollRequest.generation, "offset": requested}
		if st.scrollRequest.smooth {
			r["smooth"] = true
		}
		vl["scrollRequest"] = r
	}
	q := listRest(p)
	q["id"] = id
	q["onScroll"] = func(next, nextMax float64, info ScrollInfo) {
		st.effectiveOffset = next
		e := offset
		st.lastExternal = &e
		st.followingTail = followTail && math.Abs(next-nextMax) <= 0.5
		st.scrollRequest = nil
		if onScroll != nil {
			onScroll(next, nextMax, info)
		}
	}
	q["onVirtualListLayout"] = func(items []VirtualListMeasurement) {
		for _, m := range items {
			if _, ok := unique[m.Key]; !ok || m.Height <= 0 || math.IsInf(m.Height, 0) || math.IsNaN(m.Height) {
				continue
			}
			st.heights[m.Key] = m.Height
		}
	}
	q["onVirtualListScrollToItem"] = func(index int, itemOffset float64, smooth bool) {
		if index < 0 || math.IsInf(itemOffset, 0) || math.IsNaN(itemOffset) {
			return
		}
		st.followingTail = false
		store.nextGeneration++
		st.scrollRequest = &scrollRequest{generation: store.nextGeneration, index: index, offset: itemOffset, smooth: smooth}
	}
	q["onVirtualListFocus"] = func(key *string) {
		if key == nil {
			st.focusedKey = ""
			return
		}
		st.focusedKey = *key
	}
	q["control"] = S{"role": "virtualList", "value": scroll}
	q["virtualList"] = vl
	q["style"] = viewportStyle(styleOf(p), height)
	q["children"] = Column(Props{"style": S{"width": "100%"}, "children": children})
	return Scroll(q)
}

var _ = strconv.Itoa
