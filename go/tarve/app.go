package tarve

import (
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"encoding/binary"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"log"
	"net/url"
	"os"
	"path/filepath"
	"regexp"
	"runtime/debug"
	"strings"
	"sync"
	"sync/atomic"
	"time"
)

// ProtocolVersion is @tarve/protocol PROTOCOL_VERSION; NativeABIVersion is NATIVE_ABI_VERSION.
const (
	ProtocolVersion  = 59
	NativeABIVersion = 6
)

// AppIdentity names the app in media controls, notifications and the taskbar (Windows AppUserModelID).
type AppIdentity struct{ ID, Name, Icon string }

// Options mirror @tarve/core AppOptions.
type Options struct {
	Debug, Headless, LowPower bool
	// Renderer is "auto", "gpu" or "cpu"; empty picks cpu for Headless/LowPower, else auto.
	Renderer string
	// CloseBehavior "hide" hides the window on close instead of quitting.
	CloseBehavior string
	AppIdentity   *AppIdentity
	// Icon is the window, taskbar and tray icon (a PNG/ICO path).
	Icon string
	// OnError receives handler panics and native errors; nil logs them.
	OnError func(source string, err error)
}

// Size is a node's laid-out content size (onSize).
type Size struct{ Width, Height float64 }

// Point is a position inside a node (onContextMenu, onPointerMove).
type Point struct{ X, Y float64 }

// UpdateTiming is the Go side of one update: view build + compile, diff, encode and send.
type UpdateTiming struct{ Render, Diff, Encode, Send time.Duration }

type nativeBridge interface {
	start([]byte) error
	send([]byte) error
	wait([]byte) ([]byte, []byte, error)
	join() error
}

type libBridge struct{ lib *library }

func (b libBridge) start(p []byte) error                    { return b.lib.call(b.lib.start, p) }
func (b libBridge) send(p []byte) error                     { return b.lib.call(b.lib.send, p) }
func (b libBridge) wait(buf []byte) ([]byte, []byte, error) { return b.lib.waitEvent(buf) }
func (b libBridge) join() error                             { return b.lib.joinThread() }

// App is a running Tarve app. Handlers, posted functions and renders all run on the goroutine
// that calls Run; other goroutines hand work to it with Post.
type App struct {
	bridge  nativeBridge
	view    func() Child
	options Options
	scope   *renderScope

	committed, observed *CompiledTree
	viewport            *Size
	carried             map[*NNode]*NNode
	// edited are the ids where observed differs from committed (typed values, carried inputs).
	edited      map[string]bool
	loadedMedia map[string]*MediaRequest
	identity    S
	buf         []byte
	Timings     []UpdateTiming

	queued  atomic.Bool
	posted  chan func()
	wake    chan struct{}
	events  chan map[string]any
	ended   bool
	closing bool

	reqMu   sync.Mutex
	pending map[string]chan map[string]any

	hotkeys      map[string][]func()
	tray         *TrayOptions
	trayHandlers map[string]func()
	trayIconSent string
	mediaAction  func(action string, time *float64)
	notifyClick  func()
	listeners    []func(map[string]any)

	ready, closed chan struct{}
	readyOnce     sync.Once
}

// CreateApp compiles the first view, opens the native window and starts the event pump.
// Call Run to deliver events.
func CreateApp(view func() Child, options Options) (*App, error) {
	trace("create")
	// Load the library (and start the GPU device) while the first view compiles.
	type loaded struct {
		lib *library
		err error
	}
	ch := make(chan loaded, 1)
	go func() {
		path, err := LibraryPath()
		if err != nil {
			ch <- loaded{err: err}
			return
		}
		lib, err := openLibrary(path)
		if err != nil {
			ch <- loaded{err: fmt.Errorf("tarve: load %s: %w", path, err)}
			return
		}
		if v := lib.abiVersion(); v != NativeABIVersion {
			ch <- loaded{err: fmt.Errorf("tarve: native ABI mismatch; expected %d, got %d", NativeABIVersion, v)}
			return
		}
		trace("loaded")
		lib.prewarmRenderer(rendererFor(options))
		ch <- loaded{lib: lib}
	}()
	bridge := &lazyBridge[loaded]{arrive: ch, take: func(v loaded) (*library, error) { return v.lib, v.err }}
	return startApp(view, options, bridge)
}

func rendererFor(o Options) string {
	if o.Renderer != "" {
		return o.Renderer
	}
	if o.Headless || o.LowPower {
		return "cpu"
	}
	return "auto"
}

// lazyBridge is a libBridge whose library arrives from the loading goroutine at start.
type lazyBridge[T any] struct {
	arrive chan T
	take   func(T) (*library, error)
	libBridge
}

func (b *lazyBridge[T]) start(p []byte) error {
	lib, err := b.take(<-b.arrive)
	if err != nil {
		return err
	}
	b.lib = lib
	return b.libBridge.start(p)
}

func newApp(view func() Child, options Options, bridge nativeBridge) *App {
	return &App{bridge: bridge, view: view, options: options, scope: newRenderScope(), loadedMedia: map[string]*MediaRequest{}, edited: map[string]bool{},
		posted: make(chan func(), 1024), wake: make(chan struct{}, 1), events: make(chan map[string]any, 1024),
		pending: map[string]chan map[string]any{}, hotkeys: map[string][]func(){}, trayHandlers: map[string]func(){},
		ready: make(chan struct{}), closed: make(chan struct{})}
}

func startApp(view func() Child, options Options, bridge nativeBridge) (*App, error) {
	a := newApp(view, options, bridge)
	tree, err := a.compileView()
	if err != nil {
		return nil, err
	}
	trace("compiled")
	a.committed, a.observed = tree, tree
	doc := a.encodeDocument(tree)
	trace("encoded")
	if err := bridge.start(doc); err != nil {
		return nil, err
	}
	trace("started")
	go a.pump()
	a.syncMedia()
	return a, nil
}

func (a *App) renderer() string { return rendererFor(a.options) }

func (a *App) compileView() (tree *CompiledTree, err error) {
	defer func() {
		if r := recover(); r != nil {
			err = fmt.Errorf("%v\n%s", r, debug.Stack())
		}
	}()
	activeApp = a
	tree = compileTree(a.view, a.options.Debug, a.renderer(), a.scope, !a.options.Headless, a.viewport, a.committed)
	if a.options.CloseBehavior == "hide" {
		tree.Root.set("closeIntercept", true)
	}
	for k, v := range a.identityDocument() {
		tree.Document[k] = v
	}
	if a.options.LowPower {
		tree.Document["msaa"], tree.Document["memoryTrimDelay"], tree.Document["lowPower"] = 0, 1000, true
	}
	return tree, nil
}

var activeApp *App

func (a *App) identityDocument() S {
	if a.identity != nil {
		return a.identity
	}
	a.identity = S{}
	icon := a.options.Icon
	if icon == "" && a.options.AppIdentity != nil {
		icon = a.options.AppIdentity.Icon
	}
	if icon != "" {
		if bytes, err := os.ReadFile(nativeAssetPath(icon)); err == nil {
			a.identity["windowIcon"] = base64.StdEncoding.EncodeToString(bytes)
		}
	}
	if id := a.options.AppIdentity; id != nil {
		identity := S{"id": id.ID, "name": id.Name}
		if id.Icon != "" {
			if shell := iconFileForShell(id.Icon); shell != "" {
				identity["icon"] = shell
			}
		}
		a.identity["appIdentity"] = identity
	}
	return a.identity
}

func iconFileForShell(icon string) string {
	path := nativeAssetPath(icon)
	if strings.HasSuffix(strings.ToLower(path), ".ico") {
		return path
	}
	bytes, err := os.ReadFile(path)
	if err != nil {
		return ""
	}
	var ico []byte
	if len(bytes) >= 6 && bytes[0] == 0 && bytes[1] == 0 && bytes[2] == 1 && bytes[3] == 0 {
		ico = bytes
	} else if len(bytes) >= 24 && string(bytes[1:4]) == "PNG" {
		size := min(256, max(binary.BigEndian.Uint32(bytes[16:]), binary.BigEndian.Uint32(bytes[20:])))
		header := make([]byte, 22)
		binary.LittleEndian.PutUint16(header[2:], 1)
		binary.LittleEndian.PutUint16(header[4:], 1)
		if size < 256 {
			header[6], header[7] = byte(size), byte(size)
		}
		binary.LittleEndian.PutUint16(header[10:], 1)
		binary.LittleEndian.PutUint16(header[12:], 32)
		binary.LittleEndian.PutUint32(header[14:], uint32(len(bytes)))
		binary.LittleEndian.PutUint32(header[18:], 22)
		ico = append(header, bytes...)
	} else {
		return ""
	}
	base := os.Getenv("LOCALAPPDATA")
	if base == "" {
		if home, err := os.UserHomeDir(); err == nil {
			base = filepath.Join(home, ".cache")
		} else {
			base = os.TempDir()
		}
	}
	dir := filepath.Join(base, "tarve", "icons")
	sum := sha256.Sum256(ico)
	out := filepath.Join(dir, hex.EncodeToString(sum[:])[:32]+".ico")
	if _, err := os.Stat(out); err != nil {
		os.MkdirAll(dir, 0o755)
		os.WriteFile(out, ico, 0o644)
	}
	return out
}

func (a *App) encodeDocument(t *CompiledTree) []byte {
	b := append(a.buf[:0], '{')
	for i, k := range sortedKeys(t.Document) {
		if i > 0 {
			b = append(b, ',')
		}
		b = appendString(b, k)
		b = append(b, ':')
		b = appendValue(b, t.Document[k])
	}
	a.buf = append(b, '}')
	return a.buf
}

func (a *App) reportError(source string, err error) {
	if a.options.OnError != nil {
		a.options.OnError(source, err)
		return
	}
	log.Printf("[tarve] %s: %v", source, err)
}

func (a *App) pump() {
	buf := make([]byte, 64<<10)
	for {
		var data []byte
		var err error
		buf, data, err = a.bridge.wait(buf)
		if err != nil {
			a.events <- map[string]any{"type": "error", "message": err.Error()}
			a.events <- map[string]any{"type": "closed"}
			close(a.events)
			return
		}
		var ev map[string]any
		if json.Unmarshal(data, &ev) != nil {
			continue
		}
		if id, ok := ev["requestId"].(string); ok {
			a.reqMu.Lock()
			ch := a.pending[id]
			delete(a.pending, id)
			a.reqMu.Unlock()
			if ch != nil {
				ch <- ev
				continue
			}
		}
		a.events <- ev
		if ev["type"] == "closed" && ev["window"] == nil {
			close(a.events)
			return
		}
	}
}

// Post runs fn on the app's goroutine (the one in Run). Safe from any goroutine.
func (a *App) Post(fn func()) {
	select {
	case a.posted <- fn:
	default:
		go func() { a.posted <- fn }()
	}
}

// Update schedules a render after the current handler, as app.update() does. Safe from any goroutine.
func (a *App) Update() {
	if a.queued.CompareAndSwap(false, true) {
		select {
		case a.wake <- struct{}{}:
		default:
		}
	}
}

// Run delivers events, posted functions and renders until the window closes, then joins the native thread.
func (a *App) Run() error {
	for !a.ended {
		select {
		case ev, ok := <-a.events:
			if !ok {
				a.finishClosed()
				continue
			}
			a.dispatchNativeEvent(ev)
		case fn := <-a.posted:
			a.invoke("posted", "", fn)
		case <-a.wake:
		}
		if a.queued.Load() {
			a.renderQueued()
		}
	}
	return a.bridge.join()
}

func (a *App) Ready() <-chan struct{}  { return a.ready }
func (a *App) Closed() <-chan struct{} { return a.closed }

func (a *App) invoke(event, target string, fn func()) (ok bool) {
	defer func() {
		if r := recover(); r != nil {
			ok = false
			a.reportError("event-handler:"+event, fmt.Errorf("%v (target %q)\n%s", r, target, debug.Stack()))
		}
	}()
	fn()
	return true
}

func (a *App) sendInternal(command S) bool {
	if a.ended {
		return false
	}
	if err := a.bridge.send(appendValue(nil, command)); err != nil {
		a.reportError("bridge", err)
		return false
	}
	return true
}

func (a *App) sendPublic(command S) {
	if a.ended {
		return
	}
	if err := a.bridge.send(appendValue(nil, command)); err != nil {
		a.reportError("bridge", err)
	}
}

func encodeMutations(muts []mutation, b []byte) []byte {
	allPatch := true
	for _, m := range muts {
		if m.kind != "patch" {
			allPatch = false
			break
		}
	}
	if allPatch {
		b = append(b, `{"type":"patch","nodes":[`...)
		for i, m := range muts {
			if i > 0 {
				b = append(b, ',')
			}
			b = appendNode(b, m.node, false)
		}
		return append(b, "]}"...)
	}
	b = append(b, `{"type":"mutate","mutations":[`...)
	for i, m := range muts {
		if i > 0 {
			b = append(b, ',')
		}
		b = append(b, `{"type":`...)
		b = appendString(b, m.kind)
		switch m.kind {
		case "create", "patch":
			b = append(b, `,"node":`...)
			b = appendNode(b, m.node, false)
		case "children":
			b = append(b, `,"id":`...)
			b = appendString(b, m.id)
			b = append(b, `,"children":`...)
			b = appendValue(b, m.children)
		case "remove":
			b = append(b, `,"id":`...)
			b = appendString(b, m.id)
		}
		b = append(b, '}')
	}
	return append(b, "]}"...)
}

// reconciliationCommand encodes what turns previous into next; nil when nothing changed.
func (a *App) reconciliationCommand(previous, next *CompiledTree) []byte {
	var muts []mutation
	ok := false
	if next.base != nil && next.base == a.committed && previous == a.observed {
		muts, ok = a.fastDiff(previous, next)
	} else {
		muts, ok = diffTreeMutations(previous, next, a.carried)
	}
	if !ok {
		b := append(a.buf[:0], `{"type":"update","root":`...)
		b = appendNode(b, next.Root, true)
		a.buf = append(b, '}')
		return a.buf
	}
	if len(muts) == 0 {
		return nil
	}
	a.buf = encodeMutations(muts, a.buf[:0])
	return a.buf
}

// nativeShadow is the tree native will hold: an input without a value keeps the one it had.
func (a *App) nativeShadow(tree, previous *CompiledTree) *CompiledTree {
	a.edited = map[string]bool{}
	shadow := &CompiledTree{Document: tree.Document, Root: tree.Root, Window: tree.Window, Handlers: tree.Handlers, HandlerOrder: tree.HandlerOrder, Nodes: tree.Nodes, Media: tree.Media}
	a.carried = map[*NNode]*NNode{}
	if previous == nil {
		return shadow
	}
	for id, n := range tree.Nodes {
		if (n.Kind == "input" || n.Kind == "textarea") && n.F["value"] == nil {
			if old := previous.Nodes[id]; old != nil && old.Kind == n.Kind && old.F["value"] != nil {
				c := *n
				c.F = merge(n.F, S{"value": old.F["value"]})
				a.carried[&c] = n
				a.edited[id] = true
				shadow.own()[id] = &c
			}
		}
	}
	return shadow
}

func (t *CompiledTree) own() map[string]*NNode {
	if !t.ownNodes {
		nodes := make(map[string]*NNode, len(t.Nodes))
		for k, v := range t.Nodes {
			nodes[k] = v
		}
		t.Nodes, t.ownNodes = nodes, true
	}
	return t.Nodes
}

func (a *App) editShadow(id string, changes S) {
	n := a.observed.Nodes[id]
	if n == nil {
		return
	}
	a.edited[id] = true
	c := *n
	c.F = merge(n.F, changes)
	a.observed.own()[id] = &c
}

func (a *App) restoreCommitted() {
	if a.ended || a.closing || a.committed == nil || a.observed == nil {
		return
	}
	command := a.reconciliationCommand(a.observed, a.committed)
	restored := a.nativeShadow(a.committed, a.observed)
	if command == nil {
		return
	}
	if err := a.bridge.send(command); err != nil {
		a.reportError("bridge", err)
		return
	}
	a.observed = restored
}

func (a *App) renderQueued() {
	a.queued.Store(false)
	if a.ended || a.closing || a.committed == nil {
		return
	}
	var t UpdateTiming
	t0 := time.Now()
	next, err := a.compileView()
	t1 := time.Now()
	t.Render = t1.Sub(t0)
	if err != nil {
		a.reportError("render", err)
		a.restoreCommitted()
		return
	}
	if a.committed.Window["decorations"] != next.Window["decorations"] {
		a.reportError("render", errors.New("adding or removing TitleBar after the native window has been created is not supported"))
		a.restoreCommitted()
		return
	}
	command := a.reconciliationCommand(a.observed, next)
	// The diff is done: drop the link to the previous tree, or every tree would keep the last alive.
	next.base, next.fresh, next.freshSet = nil, nil, nil
	nextObserved := a.nativeShadow(next, a.observed)
	t2 := time.Now()
	t.Diff = t2.Sub(t1)
	if command != nil {
		if err := a.bridge.send(command); err != nil {
			a.reportError("bridge", err)
			a.restoreCommitted()
			return
		}
	}
	t.Send = time.Since(t2)
	level := func(w S) any {
		if l, ok := w["level"]; ok {
			return l
		}
		return "normal"
	}
	if level(a.committed.Window) != level(next.Window) {
		a.sendInternal(S{"type": "windowLevel", "level": level(next.Window)})
	}
	if a.committed.Window["title"] != next.Window["title"] {
		a.sendInternal(S{"type": "windowTitle", "title": next.Window["title"]})
	}
	a.committed, a.observed = next, nextObserved
	a.syncMedia()
	a.Timings = append(a.Timings, t)
	if len(a.Timings) > 600 {
		a.Timings = a.Timings[len(a.Timings)-600:]
	}
}

var schemeURL = regexp.MustCompile(`(?i)^[a-z][a-z0-9+.-]+://`)

func resolveMediaPath(src string) string {
	path := src
	if strings.HasPrefix(src, "file://") {
		if u, err := url.Parse(src); err == nil {
			path = u.Path
			if len(path) > 2 && path[0] == '/' && path[2] == ':' {
				path = path[1:]
			}
		}
	}
	if schemeURL.MatchString(path) || strings.HasPrefix(path, "data:") {
		return path
	}
	if filepath.IsAbs(path) {
		return nativeAssetPath(path)
	}
	return path
}

func (a *App) syncMedia() {
	if a.ended || a.committed == nil {
		return
	}
	wanted := a.committed.Media
	for id := range a.loadedMedia {
		if r := wanted[id]; r == nil || r.Src == "" {
			delete(a.loadedMedia, id)
			a.sendInternal(S{"type": "media", "id": id, "action": "unload"})
		}
	}
	for _, id := range sortedKeys(wanted) {
		r := wanted[id]
		if r.Src == "" {
			continue
		}
		prev := a.loadedMedia[id]
		src := resolveMediaPath(r.Src)
		if prev == nil || resolveMediaPath(prev.Src) != src || prev.Video != r.Video {
			c := S{"type": "media", "id": id, "action": "load", "src": src, "loop": r.Loop, "muted": r.Muted, "volume": r.Volume}
			if r.Video {
				c["kind"] = "video"
			}
			a.sendInternal(c)
			if r.AutoPlay {
				a.sendInternal(S{"type": "media", "id": id, "action": "play"})
			}
		} else if prev.Loop != r.Loop || prev.Muted != r.Muted || prev.Volume != r.Volume {
			a.sendInternal(S{"type": "media", "id": id, "action": "set", "loop": r.Loop, "muted": r.Muted, "volume": r.Volume})
		}
		a.loadedMedia[id] = r
	}
}

func (a *App) finishClosed() {
	if a.ended {
		return
	}
	a.ended, a.closing = true, true
	a.reqMu.Lock()
	for id, ch := range a.pending {
		close(ch)
		delete(a.pending, id)
	}
	a.reqMu.Unlock()
	close(a.closed)
}

func fnum(v any) float64 { f, _ := num(v); return f }

func (a *App) dispatchNativeEvent(ev map[string]any) {
	activeApp = a
	kind, _ := ev["type"].(string)
	if _, ok := ev["window"]; ok {
		return
	}
	switch kind {
	case "ready":
		a.readyOnce.Do(func() { close(a.ready) })
	case "error":
		msg, _ := ev["message"].(string)
		a.reportError("native", errors.New(msg))
	case "closed":
		a.finishClosed()
	case "escape":
		if a.committed != nil {
			for i := len(a.committed.HandlerOrder) - 1; i >= 0; i-- {
				id := a.committed.HandlerOrder[i]
				if h, ok := a.committed.Handlers[id]["onEscape"].(func()); ok {
					if a.invoke("escape", id, h) {
						a.Update()
					}
					break
				}
			}
		}
	case "closeRequest":
		a.closeRequest()
	case "tray", "trayMenu", "notificationClick":
		ran := false
		run := func(name string, fn func()) {
			if fn != nil && a.invoke(name, "", fn) {
				ran = true
			}
		}
		if kind == "tray" && a.tray != nil {
			if ev["action"] == "click" {
				run("trayClick", a.tray.OnClick)
			} else {
				run("trayDoubleClick", a.tray.OnDoubleClick)
			}
		} else if kind == "trayMenu" {
			id, _ := ev["id"].(string)
			run("trayMenu", a.trayHandlers[id])
			if a.tray != nil && a.tray.OnMenu != nil {
				run("trayMenu", func() { a.tray.OnMenu(id) })
			}
		} else if kind == "notificationClick" {
			run("notificationClick", a.notifyClick)
		}
		if ran {
			a.Update()
		}
	case "systemMedia":
		if a.mediaAction != nil {
			action, _ := ev["action"].(string)
			var t *float64
			if f, ok := num(ev["time"]); ok {
				t = &f
			}
			a.invoke("systemMedia:"+action, "", func() { a.mediaAction(action, t) })
		}
	case "media":
		var request *MediaRequest
		if a.committed != nil {
			id, _ := ev["id"].(string)
			request = a.committed.Media[id]
		}
		if h := applyMediaEvent(ev, request); h != nil {
			id, _ := ev["id"].(string)
			a.invoke("media", id, h)
		}
		a.Update()
	case "shortcut":
		name, _ := ev["shortcut"].(string)
		succeeded := false
		for _, h := range append([]func(){}, a.hotkeys[name]...) {
			if a.invoke("hotkey", name, h) {
				succeeded = true
			}
		}
		if succeeded {
			a.Update()
		}
	}
	if id, ok := ev["id"].(string); ok && kind == "size" && !a.ended && a.committed != nil && id == a.committed.Root.ID {
		crossed := a.committed.UsesViewport && (a.viewport == nil || a.viewport.Width != fnum(ev["width"]))
		a.viewport = &Size{fnum(ev["width"]), fnum(ev["height"])}
		if crossed {
			a.Update()
		}
	}
	if id, ok := ev["id"].(string); ok && !a.ended && a.committed != nil && kind != "keyboard" && kind != "pointer" {
		a.elementEvent(kind, id, ev)
	}
	for _, l := range a.listeners {
		l := l
		a.invoke("listener", "", func() { l(ev) })
	}
}

func (a *App) closeRequest() {
	if a.ended || a.committed == nil {
		return
	}
	root := a.committed.Root.ID
	h, _ := a.committed.Handlers[root]["onCloseRequest"].(func(*CloseRequest))
	if h == nil {
		if a.options.CloseBehavior == "hide" {
			a.sendInternal(S{"type": "window", "action": "hide"})
			a.sendInternal(S{"type": "cancelCloseRequest"})
		} else if a.sendInternal(S{"type": "close"}) {
			a.closing = true
		}
		return
	}
	req := &CloseRequest{}
	if !a.invoke("closeRequest", root, func() { h(req) }) {
		if !a.closing {
			a.sendInternal(S{"type": "cancelCloseRequest"})
		}
	} else if !a.closing && req.defaultPrevented {
		if a.sendInternal(S{"type": "cancelCloseRequest"}) {
			a.Update()
		}
	} else if !a.closing && a.sendInternal(S{"type": "close"}) {
		a.closing = true
	}
}

func requestID() string {
	var b [16]byte
	rand.Read(b[:])
	return hex.EncodeToString(b[:])
}

// Request sends a command with a fresh requestId and waits for the answer (timeout 0 waits forever).
func (a *App) Request(command S, timeout time.Duration) (map[string]any, error) {
	if a.ended {
		return nil, errors.New("tarve: native window is closed")
	}
	id := requestID()
	ch := make(chan map[string]any, 1)
	a.reqMu.Lock()
	a.pending[id] = ch
	a.reqMu.Unlock()
	command = merge(command, S{"requestId": id})
	if err := a.bridge.send(appendValue(nil, command)); err != nil {
		return nil, err
	}
	var timer <-chan time.Time
	if timeout > 0 {
		t := time.NewTimer(timeout)
		defer t.Stop()
		timer = t.C
	}
	select {
	case ev, ok := <-ch:
		if !ok {
			return nil, errors.New("tarve: native window closed")
		}
		return ev, nil
	case <-timer:
		a.reqMu.Lock()
		delete(a.pending, id)
		a.reqMu.Unlock()
		return nil, fmt.Errorf("tarve: native request timed out: %v", command["type"])
	}
}

// Inspect returns the native snapshot (frames, fps, nodes…).
func (a *App) Inspect() (map[string]any, error) {
	ev, err := a.Request(S{"type": "inspect"}, 10*time.Second)
	if err != nil {
		return nil, err
	}
	s, _ := ev["snapshot"].(map[string]any)
	return s, nil
}

// Stats returns native phase percentiles and memory.
func (a *App) Stats(reset bool) (map[string]any, error) {
	ev, err := a.Request(S{"type": "stats", "reset": reset}, 10*time.Second)
	if err != nil {
		return nil, err
	}
	s, _ := ev["stats"].(map[string]any)
	return s, nil
}

// FileDialogFilter and FileDialogOptions mirror @tarve/protocol.
type FileDialogFilter struct {
	Name       string
	Extensions []string
}

type FileDialogOptions struct {
	Title, Directory, FileName string
	Filters                    []FileDialogFilter
}

func (o FileDialogOptions) wire() S {
	s := S{}
	if o.Title != "" {
		s["title"] = o.Title
	}
	if o.Directory != "" {
		s["directory"] = o.Directory
	}
	if o.FileName != "" {
		s["fileName"] = o.FileName
	}
	if len(o.Filters) > 0 {
		list := make([]any, len(o.Filters))
		for i, f := range o.Filters {
			list[i] = S{"name": f.Name, "extensions": f.Extensions}
		}
		s["filters"] = list
	}
	return s
}

func (a *App) fileDialog(mode string, o FileDialogOptions) ([]string, error) {
	ev, err := a.Request(S{"type": "fileDialog", "mode": mode, "options": o.wire()}, 0)
	if err != nil {
		return nil, err
	}
	if msg, _ := ev["error"].(string); msg != "" {
		return nil, errors.New(msg)
	}
	list, _ := ev["paths"].([]any)
	paths := make([]string, 0, len(list))
	for _, p := range list {
		if s, ok := p.(string); ok {
			paths = append(paths, s)
		}
	}
	return paths, nil
}

func firstPath(paths []string, err error) (string, error) {
	if err != nil || len(paths) == 0 {
		return "", err
	}
	return paths[0], nil
}

// The file dialogs block until the user answers: call them from a goroutine, then Post the result.
func (a *App) OpenFileDialog(o FileDialogOptions) (string, error) {
	return firstPath(a.fileDialog("openFile", o))
}
func (a *App) OpenFilesDialog(o FileDialogOptions) ([]string, error) {
	return a.fileDialog("openFiles", o)
}
func (a *App) OpenFolderDialog(o FileDialogOptions) (string, error) {
	return firstPath(a.fileDialog("openFolder", o))
}
func (a *App) SaveFileDialog(o FileDialogOptions) (string, error) {
	return firstPath(a.fileDialog("saveFile", o))
}

func (a *App) sendAfterRender(command S) {
	if a.queued.Load() {
		a.Post(func() { a.sendPublic(command) })
		return
	}
	a.sendPublic(command)
}

func (a *App) Close() {
	if a.ended || a.closing {
		return
	}
	a.sendPublic(S{"type": "close"})
	a.closing = true
}
func (a *App) Show()           { a.sendPublic(S{"type": "window", "action": "show"}) }
func (a *App) Hide()           { a.sendPublic(S{"type": "window", "action": "hide"}) }
func (a *App) Minimize()       { a.sendPublic(S{"type": "window", "action": "minimize"}) }
func (a *App) Activate()       { a.sendPublic(S{"type": "window", "action": "activate"}) }
func (a *App) Focus(id string) { a.sendAfterRender(S{"type": "focus", "id": id}) }

// ScrollToItem scrolls a VirtualList to item index (offset px from its top).
func (a *App) ScrollToItem(id string, index int, offset float64, smooth bool) {
	c := S{"type": "scrollToItem", "id": id, "index": index}
	if offset != 0 {
		c["offset"] = offset
	}
	if smooth {
		c["smooth"] = true
	}
	a.sendAfterRender(c)
}

// Media drives the <audio> element with this id.
func (a *App) Media(id string) MediaController { return MediaController{app: a, id: id} }

// OnEvent adds a listener for every native event.
func (a *App) OnEvent(listener func(map[string]any)) { a.listeners = append(a.listeners, listener) }

// Debug sends a diagnostic input/resize command (Options.Debug).
func (a *App) Debug(command S) { a.sendPublic(command) }

var modifierAliases = map[string]string{"ctrl": "Ctrl", "control": "Ctrl", "alt": "Alt", "option": "Alt", "shift": "Shift",
	"meta": "Meta", "cmd": "Meta", "command": "Meta", "super": "Meta", "win": "Meta", "windows": "Meta"}
var namedKeys = map[string]string{"esc": "Escape", "escape": "Escape", "return": "Enter", "enter": "Enter", "space": "Space", "spacebar": "Space",
	"del": "Delete", "delete": "Delete", "backspace": "Backspace", "tab": "Tab", "home": "Home", "end": "End", "pageup": "PageUp", "pagedown": "PageDown",
	"up": "ArrowUp", "arrowup": "ArrowUp", "down": "ArrowDown", "arrowdown": "ArrowDown", "left": "ArrowLeft", "arrowleft": "ArrowLeft",
	"right": "ArrowRight", "arrowright": "ArrowRight", "insert": "Insert"}
var functionKey = regexp.MustCompile(`(?i)^f([1-9]|1\d|2[0-4])$`)

// NormalizeHotkey is @tarve/core normalizeHotkey: "ctrl+s" → "Ctrl+S".
func NormalizeHotkey(shortcut string) string {
	mods := map[string]bool{}
	key := ""
	for _, raw := range strings.Split(shortcut, "+") {
		part := strings.TrimSpace(raw)
		if part == "" {
			panic("tarve: invalid hotkey: " + shortcut)
		}
		if m, ok := modifierAliases[strings.ToLower(part)]; ok {
			if mods[m] {
				panic("tarve: duplicate hotkey modifier: " + m)
			}
			mods[m] = true
			continue
		}
		if key != "" {
			panic("tarve: hotkey must contain exactly one key: " + shortcut)
		}
		if n, ok := namedKeys[strings.ToLower(part)]; ok {
			key = n
		} else if functionKey.MatchString(part) {
			key = strings.ToUpper(part)
		} else if len([]rune(part)) == 1 {
			key = strings.ToUpper(part)
		} else {
			panic("tarve: unsupported hotkey key: " + part)
		}
	}
	if key == "" {
		panic("tarve: hotkey must contain a key: " + shortcut)
	}
	var out []string
	for _, m := range []string{"Ctrl", "Alt", "Shift", "Meta"} {
		if mods[m] {
			out = append(out, m)
		}
	}
	return strings.Join(append(out, key), "+")
}

// RegisterHotkey runs handler on the shortcut; the returned func removes it.
func (a *App) RegisterHotkey(shortcut string, handler func()) func() {
	name := NormalizeHotkey(shortcut)
	a.hotkeys[name] = append(a.hotkeys[name], handler)
	return func() {
		list := a.hotkeys[name]
		for i, h := range list {
			if fmt.Sprintf("%p", h) == fmt.Sprintf("%p", handler) {
				a.hotkeys[name] = append(list[:i:i], list[i+1:]...)
				break
			}
		}
	}
}
