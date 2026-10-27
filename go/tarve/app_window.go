package tarve

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
			if r.Rate != 1 {
				a.sendInternal(S{"type": "media", "id": id, "action": "rate", "rate": r.Rate})
			}
			if r.AutoPlay {
				a.sendInternal(S{"type": "media", "id": id, "action": "play"})
			}
		} else {
			if prev.Loop != r.Loop || prev.Muted != r.Muted || prev.Volume != r.Volume {
				a.sendInternal(S{"type": "media", "id": id, "action": "set", "loop": r.Loop, "muted": r.Muted, "volume": r.Volume})
			}
			if prev.Rate != r.Rate {
				a.sendInternal(S{"type": "media", "id": id, "action": "rate", "rate": r.Rate})
			}
		}
		a.loadedMedia[id] = r
	}
}

func (a *App) Show()     { a.sendPublic(S{"type": "window", "action": "show"}) }
func (a *App) Hide()     { a.sendPublic(S{"type": "window", "action": "hide"}) }
func (a *App) Minimize() { a.sendPublic(S{"type": "window", "action": "minimize"}) }
func (a *App) Activate() { a.sendPublic(S{"type": "window", "action": "activate"}) }

// SetMaximized maximizes (true) or restores (false) the window.
func (a *App) SetMaximized(maximized bool) {
	action := "unmaximize"
	if maximized {
		action = "maximize"
	}
	a.sendPublic(S{"type": "window", "action": action})
}

// SetFullscreen switches borderless full screen on (true) or off (false).
func (a *App) SetFullscreen(fullscreen bool) {
	action := "exitFullscreen"
	if fullscreen {
		action = "fullscreen"
	}
	a.sendPublic(S{"type": "window", "action": action})
}

// ToggleFullscreen switches borderless full screen.
func (a *App) ToggleFullscreen() { a.sendPublic(S{"type": "window", "action": "toggleFullscreen"}) }
