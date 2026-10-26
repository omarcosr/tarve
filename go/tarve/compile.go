package tarve

import (
	"fmt"
	"math"
	"path/filepath"
	"regexp"
	"strings"
)

// NNode is a compiled native node (@tarve/protocol NativeNode).
type NNode struct {
	ID       string
	Kind     string
	Style    S
	Children []*NNode
	// F holds the node's other fields (text, control, svg, value, …).
	F map[string]any
	// style is the interned Style: equal styles share it.
	style *interned
}

func (n *NNode) set(key string, value any) {
	if n.F == nil {
		n.F = map[string]any{}
	}
	n.F[key] = value
}

// Handlers are a node's event handlers, by prop name (onClick, onScroll…).
type Handlers = map[string]any

// CompiledTree is @tarve/core CompiledTree.
type CompiledTree struct {
	Document S
	Root     *NNode
	Window   S
	Handlers map[string]Handlers
	// HandlerOrder lists the ids with handlers in compile order.
	HandlerOrder []string
	// UsesViewport: a style has breakpoints, so the app renders again when the width crosses one.
	UsesViewport bool
	// ReadsViewportSize: the view read Viewport(), so any resize renders it again.
	ReadsViewportSize bool
	// Environment is the environment key the render read (viewport.go), "" when it read none.
	Environment string
	// fresh are the nodes not reused from base, the tree this one was compiled against.
	fresh    []*NNode
	freshSet map[*NNode]bool
	base     *CompiledTree
	Nodes    map[string]*NNode
	Media    map[string]*MediaRequest
	ownNodes bool
}

var nativeKinds = set("window", "titlebar", "view", "row", "column", "text", "markdown", "code", "diff", "button", "image", "svg", "scroll", "input", "textarea", "pressable", "slider", "splitter", "video")
var interactiveKinds = set("button", "input", "textarea", "pressable", "slider", "splitter")
var handlerProps = set("onClick", "onMarkdownLink", "onToggleFile", "onShowMore", "onLineClick", "onHighlight", "onContextMenu", "onOutsideClick", "onChange", "onSubmit",
	"onPaste", "onValueChange", "onScroll", "onScrollPosition", "onVirtualListLayout", "onVirtualListScrollToItem", "onVirtualListFocus", "onEscape", "onKeyDown", "onBlur",
	"onCloseRequest", "onTransitionEnd", "onDragStart", "onDragMove", "onDragEnd", "onDragEnter", "onDragLeave", "onDrop", "onFileDragEnter", "onFileDragLeave", "onFileDrop",
	"onSize", "onPointerMove", "onPointerLeave", "onHover")
var inheritedFont = []string{"fontFamily", "fontStyle", "letterSpacing", "wordSpacing", "fontVariantNumeric", "fontFeatureSettings", "fontSize", "fontWeight", "lineHeight", "foreground", "textAlign", "textTransform", "whiteSpace"}
var inheritedFontSet = set(inheritedFont...)
var controlFont = []string{"fontFamily", "fontStyle", "letterSpacing", "wordSpacing", "textTransform"}
var variantKeys = []string{"first", "last", "odd", "even", "sm", "md", "lg", "xl", "2xl", "portrait", "landscape", "pointerCoarse", "pointerFine", "motionReduce", "motionSafe", "dark"}

func set(keys ...string) map[string]bool {
	m := make(map[string]bool, len(keys))
	for _, k := range keys {
		m[k] = true
	}
	return m
}

type memoEntry struct {
	memo     *Memo
	props    Props
	group    string
	theme    *Theme
	font     *interned
	result   []*NNode
	ids      []string
	nodes    []*NNode
	handlers map[string]Handlers
	media    map[string]*MediaRequest
	nested   []string
	idSet    map[string]bool
	// breakpoint is the breakpoint, orientation and environment the subtree was styled for
	// (viewportKey); "" when it reads none.
	breakpoint string
}

// renderScope holds what outlives one render: memoized subtrees and component state.
type renderScope struct {
	memos map[string]*memoEntry
	state map[string]any
	epoch int
	// lastNodes and lastHandlers size the next render's maps.
	lastNodes, lastHandlers int
}

func newRenderScope() *renderScope {
	return &renderScope{memos: map[string]*memoEntry{}, state: map[string]any{}}
}

var activeScope = newRenderScope()

// scopedState is @tarve/core scopedState: one value per key in the current render scope.
func scopedState[T any](key string, create func() T) T {
	if v, ok := activeScope.state[key]; ok {
		return v.(T)
	}
	v := create()
	activeScope.state[key] = v
	return v
}

func (s *renderScope) invalidate(id string) {
	for path, e := range s.memos {
		if e.idSet == nil {
			e.idSet = set(e.ids...)
		}
		if e.idSet[id] {
			delete(s.memos, path)
		}
	}
}

type compiler struct {
	debug, visible bool
	scope          *renderScope
	handlers       map[string]Handlers
	order          []string
	memoDepth      int
	idLog          []string
	nodes          map[string]*NNode
	media          map[string]*MediaRequest
	window         S
	theme          *Theme
	font           *interned
	t, base        *tables
	memoSeen       map[string]bool
	memoSeenLog    []string
	focusRing      S
	initialFont    map[string]any
	// pos is the position of the element being visited among its element siblings.
	pos          *position
	width        float64
	height       float64
	usesViewport bool
	// prev are the last render's nodes: an equal node is reused, so the diff skips it by pointer.
	prev  map[string]*NNode
	fresh []*NNode
}

func compileTree(view func() Child, debug bool, renderer string, scope *renderScope, visible bool, viewport *Size, prev *CompiledTree) *CompiledTree {
	if scope == nil {
		scope = newRenderScope()
	}
	previous := activeScope
	activeScope = scope
	scope.epoch++
	defer func() { activeScope = previous }()
	n := scope.lastNodes
	c := &compiler{debug: debug, visible: visible, scope: scope, handlers: make(map[string]Handlers, scope.lastHandlers), nodes: make(map[string]*NNode, n), media: map[string]*MediaRequest{}, theme: LightTheme, memoSeen: map[string]bool{},
		idLog: make([]string, 0, n), width: -1, height: -1}
	c.t = sharedFor(LightTheme)
	c.font = c.intern(1, S{})
	if prev != nil {
		c.prev = prev.Nodes
	}
	reads := c.startViewport(viewport)
	roots := c.visit(view(), "root", "", nil)
	readsSize, environment := reads()
	for path := range scope.memos {
		if !c.memoSeen[path] {
			delete(scope.memos, path)
		}
	}
	scope.lastNodes, scope.lastHandlers = len(c.nodes)+16, len(c.handlers)+16
	if len(roots) != 1 || roots[0].Kind != "window" || c.window == nil {
		panic("tarve: render() requires one Window root")
	}
	root := roots[0]
	titleBars := 0
	for _, n := range c.nodes {
		if n != nil && n.Kind == "titlebar" {
			titleBars++
		}
	}
	if titleBars > 1 {
		panic("tarve: Window can contain only one TitleBar")
	}
	if titleBars == 1 || c.window["decorations"] == false {
		root.Style = merge(root.Style)
		bg, _ := root.Style["background"].(string)
		if titleBars == 1 {
			c.window["decorations"] = false
			if _, ok := root.Style["borderWidth"]; !ok {
				root.Style["borderWidth"] = 1
			}
		}
		if _, ok := root.Style["borderColor"]; !ok {
			root.Style["borderColor"] = windowBorder(bg, c.theme)
		}
		if _, ok := root.Style["radius"]; !ok && titleBars == 1 {
			root.Style["radius"] = RadiusMd
		}
		if root == c.prev[root.ID] {
			copied := *root
			root = &copied
			c.nodes[root.ID] = root
			c.fresh = append(c.fresh, root)
		}
		root.style = c.intern(0, root.Style)
		root.Style = root.style.style
	}
	if c.usesViewport && root.F["reportSize"] != true {
		if root == c.prev[root.ID] {
			copied := *root
			copied.F = merge(root.F)
			root = &copied
			c.nodes[root.ID] = root
			c.fresh = append(c.fresh, root)
		}
		root.set("reportSize", true)
	}
	doc := S{"version": ProtocolVersion, "renderer": renderer, "window": c.window, "root": root}
	return &CompiledTree{Document: doc, Root: root, Window: c.window, Handlers: c.handlers, HandlerOrder: c.order, Nodes: c.nodes, Media: c.media, UsesViewport: c.usesViewport, ReadsViewportSize: readsSize, Environment: environment, fresh: c.fresh, base: prev}
}

func (c *compiler) claim(id string) {
	if _, taken := c.nodes[id]; taken {
		panic("tarve: duplicate node id: " + id)
	}
	c.nodes[id] = nil
	if c.memoDepth > 0 {
		c.idLog = append(c.idLog, id)
	}
}

func (c *compiler) seeMemo(path string) {
	if !c.memoSeen[path] {
		c.memoSeen[path] = true
		c.memoSeenLog = append(c.memoSeenLog, path)
	}
}

func isPrimitive(v Child) bool {
	switch v.(type) {
	case string:
		return true
	}
	_, ok := num(v)
	return ok
}

func (c *compiler) visitMemo(m *Memo, props Props, path, group string) []*NNode {
	c.seeMemo(path)
	if prev := c.scope.memos[path]; prev != nil && prev.memo == m && prev.group == group && prev.theme == c.theme &&
		prev.font == c.font && (prev.breakpoint == "" || prev.breakpoint == c.viewportKey(strings.Contains(prev.breakpoint, "x"))) && m.Equal(prev.props, props) {
		if prev.breakpoint != "" {
			c.usesViewport = true
		}
		for _, id := range prev.ids {
			c.claim(id)
		}
		for _, n := range prev.nodes {
			c.nodes[n.ID] = n
		}
		for _, id := range prev.ids {
			if h := prev.handlers[id]; h != nil {
				c.handlers[id] = h
				c.order = append(c.order, id)
			}
		}
		for id, r := range prev.media {
			c.media[id] = r
		}
		for _, p := range prev.nested {
			c.seeMemo(p)
		}
		prev.props = props
		return prev.result
	}
	seenBefore := len(c.memoSeenLog)
	mark := len(c.idLog)
	window := c.window
	font, theme := c.font, c.theme
	outerViewport := c.usesViewport
	c.usesViewport = false
	c.memoDepth++
	sizeReads := viewportReads.Load()
	result := c.visit(m.Render(props), path, group, nil)
	exact := viewportReads.Load() != sizeReads
	c.memoDepth--
	readViewport := c.usesViewport || exact
	c.usesViewport = outerViewport || readViewport
	if (window == nil) != (c.window == nil) {
		delete(c.scope.memos, path)
		return result
	}
	e := &memoEntry{memo: m, props: props, group: group, theme: theme, font: font, result: result,
		handlers: map[string]Handlers{}, media: map[string]*MediaRequest{}}
	if readViewport {
		c.usesViewport = true
		e.breakpoint = c.viewportKey(exact)
	}
	seen := map[string]bool{}
	for _, id := range c.idLog[mark:] {
		if _, live := c.nodes[id]; seen[id] || !live {
			continue
		}
		seen[id] = true
		e.ids = append(e.ids, id)
		if n := c.nodes[id]; n != nil {
			e.nodes = append(e.nodes, n)
		}
		if h := c.handlers[id]; h != nil {
			e.handlers[id] = h
		}
		if r := c.media[id]; r != nil {
			e.media[id] = r
		}
	}
	e.nested = append([]string(nil), c.memoSeenLog[seenBefore:]...)
	c.scope.memos[path] = e
	return result
}

func (c *compiler) defaultFocusRing() S {
	if c.focusRing == nil {
		c.focusRing = merge(S{"outlineColor": T.Ring}, LightTheme.FocusOutline, c.theme.FocusOutline)
	}
	return c.focusRing
}

func (c *compiler) initial() map[string]any {
	if c.initialFont == nil {
		c.initialFont = map[string]any{"fontFamily": FontFamily, "fontSize": FontSize, "fontWeight": 400, "lineHeight": LineHeight,
			"foreground": resolveStyleString("foreground", T.Foreground, c.theme)}
	}
	return c.initialFont
}

func (c *compiler) visit(child Child, path, group string, out []*NNode) []*NNode {
	switch v := child.(type) {
	case nil, bool:
		return out
	case []Child:
		if len(v) >= parallelMin && workers > 1 && parallelSafe(v) {
			return c.visitParallel(v, path, group, out)
		}
		elements := 0
		for _, item := range v {
			if el, ok := item.(*VNode); ok && el != nil {
				elements++
			}
		}
		return c.visitRange(v, 0, len(v), 0, elements, path, group, out)
	case []*VNode:
		list := make([]Child, len(v))
		for i, n := range v {
			if n != nil {
				list[i] = n
			}
		}
		return c.visit(list, path, group, out)
	case *VNode:
		if v == nil {
			return out
		}
		return c.visitNode(v, path, group, out)
	}
	if s, ok := jsString(child); ok {
		c.claim(path)
		delete(c.nodes, path)
		return c.visit(Text(Props{"id": path, "children": s}), path, group, out)
	}
	panic(fmt.Sprintf("tarve: unsupported child %T", child))
}

var inputLike = set("input", "textarea")

func (c *compiler) visitNode(child *VNode, path, group string, out []*NNode) []*NNode {
	pos := c.pos
	c.pos = nil
	switch t := child.Type.(type) {
	case *Memo:
		return append(out, c.visitMemo(t, child.Props, path, group)...)
	case Component:
		return c.visit(t(child.Props), path, group, out)
	case func(Props) Child:
		return c.visit(t(child.Props), path, group, out)
	case func(Props) *VNode:
		return c.visit(t(child.Props), path, group, out)
	}
	kind, _ := child.Type.(string)
	p := child.Props
	if kind == fragmentType {
		return c.visit(p["children"], path, group, out)
	}
	if !child.native && kind == "audio" {
		id := str(p, "id")
		if id == "" {
			id = path
		}
		c.media[id] = mediaRequest(p)
		return c.visit(expandAudio(p, id), path, group, out)
	}
	if !child.intrinsic {
		pos = nil
	}
	if !child.native {
		if expanded := expandIntrinsic(child, path); expanded != nil {
			if v, ok := expanded.(*VNode); ok && kind == "div" {
				v.intrinsic = true
				c.pos = pos
			}
			return c.visit(expanded, path, group, out)
		}
	}
	if !nativeKinds[kind] {
		panic("tarve: unknown native component: " + kind)
	}
	// One pass over the props: a node has a few, and the compiler asks about thirty.
	var (
		id                                         string
		style                                      S
		rawControl                                 any
		children                                   Child
		handlers                                   Handlers
		fields                                     map[string]any
		rovingTrue, notFocusable                   bool
		drop, fileDrop, size, pointer, closeHandle bool
		hasDropTarget, hasFileDropTarget           bool
		uaMargin                                   float64
	)
	setField := func(k string, v any) {
		if fields == nil {
			fields = make(map[string]any, 4)
		}
		fields[k] = v
	}
	for k, v := range p {
		if v == nil {
			continue
		}
		switch k {
		case "id":
			id, _ = v.(string)
		case "style":
			style, _ = v.(S)
		case "control":
			rawControl = v
		case "children":
			children = v
		case "rovingGroup":
			rovingTrue = v == true
		case "focusable":
			notFocusable = v == false
			setField(k, v)
		case "language", "path", "showLineNumbers", "wordDiff", "maxLines", "highlight", "oldText", "newText", "svg",
			"collapsedPaths", "value", "placeholder", "inputType", "scrollSpeed", "scrollOrientation", "virtualList", "disabled", "modal",
			"portal", "dismissOnOutside", "dragRegion", "draggable", "windowAction", "motionFrom":
			setField(k, v)
		case "dropTarget":
			hasDropTarget = true
			setField(k, v)
		case "fileDropTarget":
			hasFileDropTarget = true
			setField(k, v)
		case "submitOnEnter":
			setField(k, v == true)
		case "uaMargin":
			uaMargin, _ = num(v)
		default:
			if len(k) > 2 && k[0] == 'o' && k[1] == 'n' && handlerProps[k] {
				if handlers == nil {
					handlers = make(Handlers, 2)
				}
				handlers[k] = v
				switch k {
				case "onDrop", "onDragEnter", "onDragLeave":
					drop = true
				case "onFileDrop", "onFileDragEnter", "onFileDragLeave":
					fileDrop = true
				case "onSize":
					size = true
				case "onPointerMove", "onPointerLeave":
					pointer = true
				case "onCloseRequest":
					closeHandle = true
				}
			}
		}
	}
	if id == "" {
		id = path
	}
	c.claim(id)
	if kind == "window" {
		c.windowOptions(p, style)
	}
	if handlers != nil {
		c.handlers[id] = handlers
		c.order = append(c.order, id)
	}
	var control S
	if ctl, ok := asMap(rawControl); ok {
		control = merge(ctl)
	}
	role, _ := control["role"].(string)
	childGroup := group
	semanticRoving := false
	switch role {
	case "radiogroup", "tablist", "navigation", "togglegroup", "tree", "grid":
		childGroup = id
	case "radio", "tab", "menuitem", "toggle", "treeitem", "row":
		semanticRoving = true
	}
	if (semanticRoving || rovingTrue) && control != nil {
		if group != "" {
			control["group"] = group
		} else {
			delete(control, "group")
		}
	}
	if hasVariants(style) {
		style = foldVariants(style, c.theme, variantContext{pos: pos, width: c.viewportWidth(), height: c.viewportHeight(), usedViewport: &c.usesViewport})
	}
	if uaMargin != 0 && style["margin"] == nil {
		size := numberOr(style["fontSize"], numberOr(c.font.style["fontSize"], FontSize))
		vertical := math.Round(uaMargin*size*100) / 100
		style = merge(style, S{"margin": S{"top": vertical, "bottom": vertical, "left": 0, "right": 0}})
	}
	isText := kind == "text" || kind == "button"
	isRichLeaf := kind == "markdown" || kind == "code" || kind == "diff"
	focus := (interactiveKinds[kind] && !notFocusable) || role == "otpSlot"
	custom := focus && (style["focus"] != nil || style["focusVisible"] != nil || role == "otpSlot")
	var entry *resolvedEntry
	if custom {
		raw := merge(style)
		fv, _ := asMap(style["focusVisible"])
		raw["focusVisible"] = merge(S{"outlineColor": T.Ring}, LightTheme.FocusOutline, c.theme.FocusOutline, focusOutlineOverrides(style["focus"]), fv)
		if role == "otpSlot" {
			f, _ := asMap(style["focus"])
			raw["focus"] = merge(raw["focusVisible"].(S), f)
		}
		entry = c.resolveEntry(raw)
	} else {
		entry = c.resolveEntry(style)
	}
	class := uint8(0)
	if kind == "text" || kind == "markdown" {
		class = 1
	} else if isText || isRichLeaf || inputLike[kind] {
		class = 2
	}
	parentFont := c.font
	d := c.derive(derivedKey{entry: entry, ring: focus && !custom, class: class, font: parentFont})
	shared := d.style
	resolved := shared.style
	var kids []*NNode
	if !isText && !isRichLeaf && children != nil {
		c.font = d.childFont
		kids = c.visit(children, id+"/children", childGroup, nil)
		c.font = parentFont
	}
	if kids == nil {
		kids = noChildren
	}
	node := &NNode{ID: id, Kind: kind, Style: resolved, Children: kids, style: shared, F: fields}
	switch kind {
	case "text":
		ws, _ := resolved["whiteSpace"].(string)
		if ws == "" {
			ws = "normal"
		}
		text, runs := c.inlineText(id, children, ws, resolved)
		node.set("text", text)
		if len(runs) > 0 {
			node.set("runs", runs)
		}
	case "button":
		node.set("text", textContent(children))
	case "code":
		node.set("text", p["code"])
	case "markdown", "diff":
		node.set("source", p["source"])
	case "video":
		node.set("fit", orString(p["fit"], "contain"))
	case "image":
		if p["src"] != nil {
			src, _ := p["src"].(string)
			if src == "" {
				panic("tarve: Image src must be a non-empty string")
			}
			node.set("src", nativeAssetPath(src))
			node.set("fit", orString(p["fit"], "cover"))
		}
	case "window":
		if closeHandle {
			node.set("closeIntercept", true)
		}
	}
	if drop && !hasDropTarget {
		node.set("dropTarget", true)
	}
	if fileDrop && !hasFileDropTarget {
		node.set("fileDropTarget", true)
	}
	if size {
		node.set("reportSize", true)
	}
	if pointer {
		node.set("reportPointer", true)
	}
	if isRichLeaf {
		syntax := map[string]any{}
		for k, v := range c.theme.Syntax {
			syntax[k] = v
		}
		if o, ok := asMap(p["syntaxTheme"]); ok {
			for k, v := range o {
				syntax[k] = v
			}
		}
		node.set("syntaxTheme", syntax)
	}
	if control != nil {
		node.set("control", control)
	}
	if group != "" && (rovingTrue || semanticRoving) {
		node.set("rovingGroup", group)
	}
	if old := c.prev[id]; old != nil && old.Kind == kind && old.style == shared && sameNodes(old.Children, kids) && sameValue(old.F, node.F) {
		node = old
	} else {
		c.fresh = append(c.fresh, node)
	}
	c.nodes[id] = node
	return append(out, node)
}

func (c *compiler) windowOptions(p Props, style S) {
	if c.window != nil {
		panic("tarve: this bootstrap supports one Window per app")
	}
	if t, ok := p["theme"].(*Theme); ok && t != nil {
		c.theme = t
	}
	c.t = sharedFor(c.theme)
	c.font = c.intern(1, c.font.style)
	width, height := numOr(p, "width", 1120), numOr(p, "height", 820)
	title := str(p, "title")
	if _, ok := p["title"]; !ok {
		title = "Tarve"
	}
	bg, _ := style["background"].(string)
	if bg == "" {
		bg = T.Background
	}
	resizable := true
	if r, ok := p["resizable"].(bool); ok {
		resizable = r
	}
	position := p["position"]
	if position == nil {
		position = "center"
	}
	c.window = S{"title": title, "width": width, "height": height,
		"minWidth": numOr(p, "minWidth", min(780, width)), "minHeight": numOr(p, "minHeight", min(580, height)),
		"background": resolveStyleString("background", bg, c.theme), "decorations": !truthy(p["frameless"]), "resizable": resizable,
		"position": position, "debug": c.debug, "visible": c.visible}
	if l := str(p, "level"); l != "" && l != "normal" {
		c.window["level"] = l
	}
	if truthy(p["skipTaskbar"]) {
		c.window["skipTaskbar"] = true
	}
	if b := str(p, "backdrop"); b != "" && b != "none" {
		c.window["backdrop"] = b
	}
}

func focusOutlineOverrides(v any) S {
	m, _ := asMap(v)
	out := S{}
	for _, k := range []string{"outlineWidth", "outlineColor", "outlineOffset", "outlineRadius", "outlineStyle"} {
		if m[k] != nil {
			out[k] = m[k]
		}
	}
	return out
}

func orString(v any, fallback string) string {
	if s, ok := v.(string); ok && s != "" {
		return s
	}
	return fallback
}

var remoteURL = regexp.MustCompile(`(?i)^https?://`)

func nativeAssetPath(src string) string {
	if remoteURL.MatchString(src) {
		return src
	}
	if abs, err := filepath.Abs(src); err == nil {
		return abs
	}
	return src
}

// plainText joins string and number children, or reports false when an element is among them.
func plainText(children Child) (string, bool) {
	switch v := children.(type) {
	case nil, bool:
		return "", true
	case string:
		return strings.ReplaceAll(strings.ReplaceAll(v, "\r\n", "\n"), "\r", "\n"), true
	case []Child:
		var b strings.Builder
		for _, c := range v {
			s, ok := plainText(c)
			if !ok {
				return "", false
			}
			b.WriteString(s)
		}
		return b.String(), true
	}
	if s, ok := jsString(children); ok {
		return s, true
	}
	return "", false
}

func needsCollapse(s string) bool {
	for i := 0; i < len(s); i++ {
		switch s[i] {
		case '\t', '\n', '\f':
			return true
		case ' ':
			if i+1 < len(s) && s[i+1] == ' ' {
				return true
			}
		}
	}
	return false
}

var whiteSpaces = regexp.MustCompile("[ \t\n\f]+")

// textContent is the text of a button's children.
func textContent(children Child) string {
	switch v := children.(type) {
	case nil, bool:
		return ""
	case []Child:
		var b strings.Builder
		for _, c := range v {
			b.WriteString(textContent(c))
		}
		return b.String()
	case *VNode:
		if v == nil {
			return ""
		}
		return textContent(v.Props["children"])
	}
	s, _ := jsString(children)
	return s
}
