package tarve

import (
	"encoding/base64"
	"errors"
	"fmt"
	"math"
	"os"
	"strconv"
	"time"
)

// Element events, the incremental diff, tray, system media, notifications and startup tracing.

func (a *App) elementEvent(kind, id string, ev map[string]any) {
	handlers := a.committed.Handlers[id]
	if handlers != nil {
		a.scope.invalidate(id)
	}
	optimistic := false
	if kind == "change" {
		if n := a.observed.Nodes[id]; n != nil && (n.Kind == "input" || n.Kind == "textarea") {
			a.editShadow(id, S{"value": ev["value"]})
			optimistic = true
		}
	}
	if kind == "valueChange" {
		if n := a.observed.Nodes[id]; n != nil && n.F["control"] != nil {
			c, _ := asMap(n.F["control"])
			a.editShadow(id, S{"control": merge(c, S{"value": ev["value"]})})
			optimistic = true
		}
	}
	handled, succeeded := false, true
	run := func(name string, fn func()) {
		handled = true
		if !a.invoke(name, id, fn) {
			succeeded = false
		}
	}
	h := func(name string) any { return handlers[name] }
	str := func(k string) string { s, _ := ev[k].(string); return s }
	switch kind {
	case "click":
		if f, ok := h("onClick").(func()); ok {
			run(kind, f)
		}
	case "context":
		if f, ok := h("onContextMenu").(func(Point)); ok {
			run(kind, func() { f(Point{fnum(ev["x"]), fnum(ev["y"])}) })
		}
	case "outside":
		if f, ok := h("onOutsideClick").(func()); ok {
			run(kind, f)
		}
	case "markdownLink":
		if f, ok := h("onMarkdownLink").(func(string)); ok {
			run(kind, func() { f(str("href")) })
		}
	case "diffToggleFile":
		if f, ok := h("onToggleFile").(func(string)); ok {
			run(kind, func() { f(str("path")) })
		}
	case "diffShowMore":
		if f, ok := h("onShowMore").(func(int, string)); ok {
			run(kind, func() { f(int(fnum(ev["hidden"])), str("path")) })
		}
	case "submit":
		if f, ok := h("onSubmit").(func(string)); ok {
			run(kind, func() { f(str("value")) })
		} else if f, ok := h("onSubmit").(func()); ok {
			run(kind, f)
		}
	case "change":
		if f, ok := h("onChange").(func(string)); ok {
			run(kind, func() { f(str("value")) })
		}
	case "valueChange":
		if f, ok := h("onValueChange").(func(float64)); ok {
			run(kind, func() { f(fnum(ev["value"])) })
		}
	case "scroll":
		source := str("source")
		if source == "" {
			source = "user"
		}
		info := ScrollInfo{Source: source}
		switch f := h("onScroll").(type) {
		case func(float64, float64, ScrollInfo):
			run(kind, func() { f(fnum(ev["offset"]), fnum(ev["max"]), info) })
		case func(float64):
			run(kind, func() { f(fnum(ev["offset"])) })
		}
	case "virtualListLayout":
		if f, ok := h("onVirtualListLayout").(func([]VirtualListMeasurement)); ok {
			var items []VirtualListMeasurement
			list, _ := ev["items"].([]any)
			for _, it := range list {
				m, _ := it.(map[string]any)
				k, _ := m["key"].(string)
				items = append(items, VirtualListMeasurement{Key: k, Height: fnum(m["height"])})
			}
			run(kind, func() { f(items) })
		}
	case "size":
		if f, ok := h("onSize").(func(Size)); ok {
			run(kind, func() { f(Size{fnum(ev["width"]), fnum(ev["height"])}) })
		}
	case "pointerMove":
		if f, ok := h("onPointerMove").(func(Point)); ok {
			run(kind, func() { f(Point{fnum(ev["x"]), fnum(ev["y"])}) })
		}
	case "pointerLeave":
		if f, ok := h("onPointerLeave").(func()); ok {
			run(kind, f)
		}
	case "virtualListScrollToItem":
		if f, ok := h("onVirtualListScrollToItem").(func(int, float64, bool)); ok {
			index := fnum(ev["index"])
			if index == math.Trunc(index) {
				run(kind, func() { f(int(index), fnum(ev["offset"]), ev["smooth"] == true) })
			}
		}
	case "virtualListFocus":
		if f, ok := h("onVirtualListFocus").(func(*string)); ok {
			var key *string
			if s, ok := ev["key"].(string); ok {
				key = &s
			}
			run(kind, func() { f(key) })
		}
	case "hover":
		if f, ok := h("onHover").(func(bool)); ok {
			run(kind, func() { f(ev["entered"] == true) })
		}
	case "key":
		if f, ok := h("onKeyDown").(func(string)); ok {
			run(kind, func() { f(str("key")) })
		}
	case "blur":
		if f, ok := h("onBlur").(func()); ok {
			run(kind, f)
		}
	}
	if !succeeded {
		a.restoreCommitted()
	} else if handled || optimistic {
		a.Update()
	}
}

// TrayMenuItem is a tray menu entry; Separator draws a line.
type TrayMenuItem struct {
	ID, Label string
	Separator bool
	Checked   *bool
	Disabled  bool
	OnSelect  func()
	Items     []TrayMenuItem
}

type TrayOptions struct {
	Icon, Tooltip string
	Menu          []TrayMenuItem
	OnClick       func()
	OnDoubleClick func()
	OnMenu        func(id string)
}

// Tray shows (or replaces) the system tray icon.
func (a *App) Tray(options TrayOptions) {
	a.tray = &options
	a.trayHandlers = map[string]func(){}
	seen := map[string]bool{}
	var convert func([]TrayMenuItem) []any
	convert = func(items []TrayMenuItem) []any {
		out := make([]any, len(items))
		for i, it := range items {
			if it.Separator {
				out[i] = S{"separator": true}
				continue
			}
			if it.ID == "" {
				panic("tarve: tray menu items need an id")
			}
			if len(it.Items) > 0 {
				m := S{"label": it.Label, "items": convert(it.Items)}
				if it.Disabled {
					m["disabled"] = true
				}
				out[i] = m
				continue
			}
			if seen[it.ID] {
				panic("tarve: duplicate tray menu id " + it.ID)
			}
			seen[it.ID] = true
			if it.OnSelect != nil {
				a.trayHandlers[it.ID] = it.OnSelect
			}
			m := S{"id": it.ID, "label": it.Label}
			if it.Checked != nil {
				m["checked"] = *it.Checked
			}
			if it.Disabled {
				m["disabled"] = true
			}
			out[i] = m
		}
		return out
	}
	tray := S{"menu": convert(options.Menu)}
	icon := options.Icon
	if icon == "" {
		icon = a.options.Icon
		if icon == "" && a.options.AppIdentity != nil {
			icon = a.options.AppIdentity.Icon
		}
	}
	if icon != "" && icon != a.trayIconSent {
		if bytes, err := os.ReadFile(nativeAssetPath(icon)); err == nil {
			tray["iconData"] = base64.StdEncoding.EncodeToString(bytes)
			a.trayIconSent = icon
		}
	}
	if options.Tooltip != "" {
		tray["tooltip"] = options.Tooltip
	}
	a.sendPublic(S{"type": "tray", "tray": tray})
}

// RemoveTray removes the tray icon.
func (a *App) RemoveTray() {
	a.tray, a.trayIconSent = nil, ""
	a.sendPublic(S{"type": "tray", "tray": nil})
}

// SystemMediaSession is what the system media controls show; nil hides them.
type SystemMediaSession struct {
	Title, Artist, Album, Artwork string
	Playing                       bool
	Duration                      float64
	Position                      float64
	CanSeek, CanNext, CanPrevious bool
	OnAction                      func(action string, time *float64)
}

func (a *App) SystemMedia(session *SystemMediaSession) {
	if session == nil {
		a.mediaAction = nil
		a.sendPublic(S{"type": "systemMedia", "session": nil})
		return
	}
	a.mediaAction = session.OnAction
	s := S{"title": session.Title, "artist": session.Artist, "album": session.Album, "playing": session.Playing,
		"position": session.Position, "canSeek": session.CanSeek, "canNext": session.CanNext, "canPrevious": session.CanPrevious}
	if session.Artwork != "" {
		s["artwork"] = session.Artwork
	}
	if session.Duration != 0 {
		s["duration"] = session.Duration
	}
	a.sendPublic(S{"type": "systemMedia", "session": s})
}

// Notify shows a system notification: a toast on Windows, org.freedesktop.Notifications on
// Linux, the notification shade on Android (which asks for POST_NOTIFICATIONS the first time on
// Android 13+). No tray icon is needed. A click brings the window forward and runs onClick.
func (a *App) Notify(title, body string, onClick func()) {
	a.notifyCount++
	id := "n" + strconv.Itoa(a.notifyCount)
	a.lastNotify = onClick
	if onClick != nil {
		if a.notifyClicks == nil {
			a.notifyClicks = map[string]func(){}
		}
		a.notifyClicks[id] = onClick
		// Unclicked notifications are dismissed eventually: drop the handler 100 notifications on.
		delete(a.notifyClicks, "n"+strconv.Itoa(a.notifyCount-100))
	}
	a.sendPublic(S{"type": "notify", "title": title, "body": body, "id": id})
}

// CheckPermissions reports each runtime permission ("CAMERA" or "android.permission.CAMERA") as
// "granted", "prompt" (never answered on Android) or "denied". Desktops have no per-app permission prompt: every name is granted.
func (a *App) CheckPermissions(names ...string) (map[string]string, error) {
	return a.permissions("check", names)
}

// RequestPermissions shows Android's prompt for the permissions not granted yet (each must be in
// the manifest: package.json tarve.android.permissions or tarve build --permission) and returns
// every state. It blocks until the user answers: call it from a goroutine, then Post the result.
func (a *App) RequestPermissions(names ...string) (map[string]string, error) {
	return a.permissions("request", names)
}

func (a *App) permissions(action string, names []string) (map[string]string, error) {
	results := map[string]string{}
	if len(names) == 0 {
		return results, nil
	}
	list := make([]any, len(names))
	for i, name := range names {
		list[i] = name
	}
	var timeout time.Duration
	if action == "check" {
		timeout = 10 * time.Second
	}
	ev, err := a.Request(S{"type": "permissions", "action": action, "permissions": list}, timeout)
	if err != nil {
		return nil, err
	}
	if msg, _ := ev["error"].(string); msg != "" {
		return nil, errors.New(msg)
	}
	states, _ := ev["results"].(map[string]any)
	for name, state := range states {
		if s, ok := state.(string); ok {
			results[name] = s
		}
	}
	return results, nil
}

// fastDiff diffs only what can differ: the nodes compiled anew and the ones native edited.
// Every other node of next is the committed one, which observed holds too.
func (a *App) fastDiff(previous, next *CompiledTree) ([]mutation, bool) {
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
	created := 0
	visit := func(n *NNode) {
		id := n.ID
		old := previous.Nodes[id]
		if old == nil {
			created++
			creates = append(creates, mutation{kind: "create", node: n})
			if len(n.Children) > 0 {
				children = append(children, mutation{kind: "children", id: id, children: ids(n)})
			}
			return
		}
		if old == n || a.carried[old] == n {
			return
		}
		if propertiesChanged(old, n) {
			patches = append(patches, mutation{kind: "patch", node: n})
		}
		if !sameChildren(old, n) {
			children = append(children, mutation{kind: "children", id: id, children: ids(n)})
		}
	}
	for _, n := range next.fresh {
		if next.Nodes[n.ID] != n {
			continue
		}
		if old := previous.Nodes[n.ID]; old != nil && old.Kind != n.Kind {
			return nil, false
		}
		visit(n)
	}
	for id := range a.edited {
		if n := next.Nodes[id]; n != nil && !isFresh(next, n) {
			visit(n)
		}
	}
	if len(next.Nodes)-created != len(previous.Nodes) {
		for id := range previous.Nodes {
			if next.Nodes[id] == nil {
				if _, ok := next.Nodes[id]; !ok {
					removes = append(removes, mutation{kind: "remove", id: id})
				}
			}
		}
	}
	out := append(creates, patches...)
	out = append(out, children...)
	return append(out, removes...), true
}

func isFresh(t *CompiledTree, n *NNode) bool {
	if t.freshSet == nil {
		t.freshSet = make(map[*NNode]bool, len(t.fresh))
		for _, f := range t.fresh {
			t.freshSet[f] = true
		}
	}
	return t.freshSet[n]
}

var traceStart = time.Now()

var tracing = os.Getenv("TARVE_TRACE") == "1"

func trace(label string) {
	if tracing {
		fmt.Fprintf(os.Stderr, "[tarve] %-9s %7.2f ms\n", label, float64(time.Since(traceStart).Microseconds())/1000)
	}
}
