package tarve

import (
	"fmt"
	"os"
	"runtime"
	"sync"
	"sync/atomic"
)

// ViewportInfo is the window and system the UI renders for, as @tarve/core viewport():
// the content size and orientation, the pointer (a finger or a mouse), the system text
// size and whether to animate. Reading it in a view renders the view again when it changes.
type ViewportInfo struct {
	Width, Height float64
	// Orientation is "portrait" (height above width) or "landscape".
	Orientation string
	// Pointer is "coarse" for a finger (Android), "fine" for a mouse: CSS pointer.
	Pointer string
	// FontScale is the system text size; the runtime already scales text by it.
	FontScale float64
	// ReducedMotion: the system asks for no animation; the runtime already skips transitions.
	ReducedMotion bool
}

type viewportEnvironment struct {
	fontScale     float64
	reducedMotion bool
	pointer       string
}

var (
	environmentMu sync.Mutex
	environment   = viewportEnvironment{fontScale: 1, pointer: defaultPointer()}
	// viewportSize is the size of the render in progress (or the last one).
	viewportSize *Size
	// viewportReads and environmentReads count reads: a render (or a memoized subtree) that
	// saw them change read the viewport.
	viewportReads, environmentReads atomic.Int64
)

func defaultPointer() string {
	if runtime.GOOS == "android" {
		return "coarse"
	}
	return "fine"
}

// initialViewport is the screen the native runtime reported before the first layout
// (Android: TARVE_VIEWPORT, WxH in dp).
func initialViewport() *Size {
	var w, h float64
	if v := os.Getenv("TARVE_VIEWPORT"); v != "" {
		if n, err := fmt.Sscanf(v, "%gx%g", &w, &h); n == 2 && err == nil {
			return &Size{w, h}
		}
	}
	return nil
}

// Viewport is the current window and system. Inside a view, reading it renders the view
// again when they change.
func Viewport() ViewportInfo {
	viewportReads.Add(1)
	environmentReads.Add(1)
	environmentMu.Lock()
	defer environmentMu.Unlock()
	size := Size{1120, 760}
	if viewportSize != nil {
		size = *viewportSize
	} else if s := initialViewport(); s != nil {
		size = *s
	}
	orientation := "landscape"
	if size.Height > size.Width {
		orientation = "portrait"
	}
	return ViewportInfo{Width: size.Width, Height: size.Height, Orientation: orientation, Pointer: environment.pointer,
		FontScale: environment.fontScale, ReducedMotion: environment.reducedMotion}
}

// readEnvironment is the environment the variants fold against, noting the read.
func readEnvironment() viewportEnvironment {
	environmentReads.Add(1)
	environmentMu.Lock()
	defer environmentMu.Unlock()
	return environment
}

// environmentKey changes whenever the environment does.
func environmentKey() string {
	environmentMu.Lock()
	defer environmentMu.Unlock()
	return fmt.Sprintf("%v|%v|%s", environment.fontScale, environment.reducedMotion, environment.pointer)
}

// setEnvironment applies a native "environment" event.
func setEnvironment(ev map[string]any) {
	environmentMu.Lock()
	defer environmentMu.Unlock()
	pointer := "fine"
	if ev["pointer"] == "coarse" {
		pointer = "coarse"
	}
	scale := fnum(ev["fontScale"])
	if scale <= 0 {
		scale = 1
	}
	environment = viewportEnvironment{fontScale: scale, reducedMotion: ev["reducedMotion"] == true, pointer: pointer}
}

func setViewportSize(size Size) {
	environmentMu.Lock()
	defer environmentMu.Unlock()
	viewportSize = &size
}

// startViewport sets the size the render compares with (the window's laid-out size once
// known, else the screen the runtime reported) and returns what the render then read: the
// size (Viewport()), and the environment key when it read the environment.
func (c *compiler) startViewport(viewport *Size) func() (bool, string) {
	if viewport == nil {
		viewport = initialViewport()
	}
	if viewport != nil {
		c.width, c.height = viewport.Width, viewport.Height
		setViewportSize(*viewport)
	}
	sizeReads, envReads := viewportReads.Load(), environmentReads.Load()
	return func() (bool, string) {
		readsSize := viewportReads.Load() != sizeReads
		if readsSize {
			c.usesViewport = true
		}
		if environmentReads.Load() == envReads {
			return readsSize, ""
		}
		return readsSize, environmentKey()
	}
}

// viewportWidth is the width breakpoints compare with: the window's laid-out width once known.
func (c *compiler) viewportWidth() float64 {
	if c.width >= 0 {
		return c.width
	}
	if w, ok := num(c.window["width"]); ok {
		return w
	}
	return 1120
}

// viewportHeight is the height portrait/landscape compare with.
func (c *compiler) viewportHeight() float64 {
	if c.height >= 0 {
		return c.height
	}
	if h, ok := num(c.window["height"]); ok {
		return h
	}
	return 760
}

// viewportKey is what a memoized subtree that read the viewport was styled for: the
// breakpoints passed, the orientation and the environment; the exact size when it read Viewport().
func (c *compiler) viewportKey(exact bool) string {
	w, h := c.viewportWidth(), c.viewportHeight()
	orientation := "l"
	if h > w {
		orientation = "p"
	}
	key := fmt.Sprintf("%d|%s|%s", breakpointOf(w), orientation, environmentKey())
	if exact {
		key += fmt.Sprintf("|%vx%v", w, h)
	}
	return key
}

// viewportEvent applies an "environment" event and the root's "size" events; true when the
// committed view read what changed and renders again.
func (a *App) viewportEvent(kind string, ev map[string]any) bool {
	if kind == "environment" {
		setEnvironment(ev)
		return !a.ended && a.committed != nil && a.committed.Environment != "" && a.committed.Environment != environmentKey()
	}
	id, ok := ev["id"].(string)
	if !ok || kind != "size" || a.ended || a.committed == nil || id != a.committed.Root.ID {
		return false
	}
	w, h := fnum(ev["width"]), fnum(ev["height"])
	crossed := a.committed.UsesViewport && (a.viewport == nil || a.viewport.Width != w || (a.viewport.Height > a.viewport.Width) != (h > w)) ||
		a.committed.ReadsViewportSize && (a.viewport == nil || a.viewport.Height != h)
	a.viewport = &Size{w, h}
	return crossed
}
