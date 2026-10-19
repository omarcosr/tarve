package tarve

import (
	"fmt"
	"math"
)

// MediaEventInfo is what <audio> handlers receive.
type MediaEventInfo struct {
	CurrentTime float64
	// Duration is nil until known.
	Duration                *float64
	Paused                  bool
	VideoWidth, VideoHeight float64
}

// MediaRequest is an <audio>/<video> element's wanted native media.
type MediaRequest struct {
	Src                   string
	Loop, Muted, AutoPlay bool
	Volume                float64
	Video                 bool
	Handlers              Props
}

func mediaRequest(p Props) *MediaRequest {
	volume := 1.0
	if f, ok := num(p["volume"]); ok {
		volume = f
	}
	return &MediaRequest{Src: str(p, "src"), Loop: p["loop"] == true, Muted: p["muted"] == true,
		Volume: math.Min(1, math.Max(0, volume)), AutoPlay: p["autoPlay"] == true, Handlers: p}
}

// Audio is the <audio> element: props id, src, autoPlay, loop, muted, volume, onPlay, onPause, onTimeUpdate,
// onSeeked, onLoadedMetadata, onEnded (func(MediaEventInfo)) and onError (func(string)).
func Audio(p Props) *VNode { return jsx("audio", copyProps(p)) }

func expandAudio(p Props, id string) *VNode {
	style := canonicalizeIntrinsicStyle(styleOf(p))
	if !truthy(p["controls"]) {
		return View(Props{"id": id, "style": S{"display": "none"}})
	}
	label := orString(p["ariaLabel"], "Audio")
	return controlBar(p, id, id, label, merge(S{"width": 300}, style))
}

func mediaClock(seconds *float64) string {
	if seconds == nil || math.IsInf(*seconds, 0) || math.IsNaN(*seconds) {
		return "--:--"
	}
	total := int(math.Max(0, math.Floor(*seconds)))
	h, m, s := total/3600, (total%3600)/60, total%60
	if h != 0 {
		return fmt.Sprintf("%d:%02d:%02d", h, m, s)
	}
	return fmt.Sprintf("%d:%02d", m, s)
}

func shownMediaState(p Props, id string) *mediaState {
	st := mediaStates()[id]
	if st == nil {
		return &mediaState{paused: true}
	}
	if st.hasSrc && st.src != str(p, "src") {
		return &mediaState{paused: true}
	}
	return st
}

func mediaMuted(p Props, st *mediaState) bool {
	attribute := p["muted"] == true
	if st.hasMuted && st.mutedAttribute == attribute {
		return st.muted
	}
	return attribute
}

var mediaGlyphs = map[string][]SvgElement{
	"play":  {Path("M8 5.6v12.8a1.2 1.2 0 0 0 1.84 1.02l10.1-6.4a1.2 1.2 0 0 0 0-2.04L9.84 4.58A1.2 1.2 0 0 0 8 5.6z")},
	"pause": {SvgEl("rect", "x", 6, "y", 4.5, "width", 4, "height", 15, "rx", 1.4), SvgEl("rect", "x", 14, "y", 4.5, "width", 4, "height", 15, "rx", 1.4)},
}

func controlBar(p Props, id, barID, label string, style S) *VNode {
	states := mediaStates()
	st := shownMediaState(p, id)
	muted := mediaMuted(p, st)
	foreground := T.Foreground
	overVideo := false
	if f, ok := style["foreground"].(string); ok {
		foreground, overVideo = f, true
	}
	round := S{"width": 36, "height": 36, "padding": S{"left": 0, "right": 0}, "radius": 18, "foreground": foreground}
	if overVideo {
		round["hover"], round["active"] = S{"background": "rgba(255, 255, 255, 0.16)"}, S{"background": "rgba(255, 255, 255, 0.26)"}
	}
	app := activeApp
	ctl := func() *MediaController {
		if app == nil {
			return nil
		}
		m := app.Media(id)
		return &m
	}
	playLabel, glyph := "Pause", "pause"
	if st.paused {
		playLabel, glyph = "Play", "play"
	}
	timeStyle := S{"fontFamily": "monospace", "shrink": 0}
	if overVideo {
		timeStyle["foreground"] = foreground
	}
	duration := st.time
	if st.duration != nil {
		duration = *st.duration
	}
	maxD := 0.001
	if st.duration != nil {
		maxD = math.Max(*st.duration, 0.001)
	}
	muteLabel, muteIcon := "Mute", "🔊"
	if muted {
		muteLabel, muteIcon = "Unmute", "🔇"
	}
	t := st.time
	return Row(Props{"id": barID, "gap": 8, "align": "center", "control": S{"role": "group", "label": label},
		"style": merge(S{"height": 54, "padding": S{"left": 10, "right": 10}, "radius": 27, "background": T.Muted}, style)},
		Button(Props{"id": id + "-play", "size": "sm", "variant": "ghost", "control": S{"role": "button", "label": playLabel}, "style": round,
			"onClick": func() {
				if m := ctl(); m != nil {
					if shownMediaState(p, id).paused {
						m.Play()
					} else {
						m.Pause()
					}
				}
			}},
			Svg(Props{"size": 18, "color": foreground, "fill": "currentColor", "stroke": "none", "viewBox": [4]float64{0, 0, 24, 24}}, mediaGlyphs[glyph]...)),
		Text(Props{"id": id + "-time", "size": 12, "style": timeStyle}, mediaClock(&t)+" / "+mediaClock(st.duration)),
		Slider(Props{"id": id + "-seek", "label": label + " position", "value": math.Min(st.time, duration), "min": 0, "max": maxD, "step": 0.1,
			"style": S{"flex": 1, "minWidth": 40}, "onValueChange": func(v float64) {
				next := *shownMediaState(p, id)
				next.time, next.waiting = v, true
				states[id] = &next
				if m := ctl(); m != nil {
					m.Seek(v)
				}
			}}),
		Button(Props{"id": id + "-mute", "size": "sm", "variant": "ghost", "control": S{"role": "button", "label": muteLabel},
			"onClick": func() {
				next := *shownMediaState(p, id)
				next.muted, next.mutedAttribute, next.hasMuted = !muted, p["muted"] == true, true
				states[id] = &next
				if m := ctl(); m != nil {
					m.SetMuted(!muted)
				}
			}}, muteIcon))
}

type mediaState struct {
	paused, ended, loaded, waiting  bool
	time                            float64
	duration                        *float64
	videoWidth, videoHeight         float64
	err, src                        string
	hasSrc                          bool
	muted, mutedAttribute, hasMuted bool
}

func mediaStates() map[string]*mediaState {
	return scopedState("tarve.mediaStates", func() map[string]*mediaState { return map[string]*mediaState{} })
}

func applyMediaEvent(ev map[string]any, request *MediaRequest) func() {
	id, _ := ev["id"].(string)
	states := mediaStates()
	known := states[id]
	if known == nil {
		known = &mediaState{paused: true}
	}
	var prev mediaState
	if request != nil && request.Src != "" && known.hasSrc && known.src != request.Src {
		prev = mediaState{paused: true, src: request.Src, hasSrc: true}
	} else {
		prev = *known
		if request != nil && request.Src != "" {
			prev.src, prev.hasSrc = request.Src, true
		}
	}
	next := prev
	if f, ok := num(ev["time"]); ok {
		next.time = f
	}
	if f, ok := num(ev["duration"]); ok {
		next.duration = &f
	}
	if b, ok := ev["paused"].(bool); ok {
		next.paused = b
	}
	if f, ok := num(ev["videoWidth"]); ok {
		next.videoWidth = f
	}
	if f, ok := num(ev["videoHeight"]); ok {
		next.videoHeight = f
	}
	kind, _ := ev["event"].(string)
	message, _ := ev["message"].(string)
	switch kind {
	case "ended":
		next.ended, next.paused = true, true
	case "play":
		next.ended = false
	case "error":
		next.err, next.waiting = message, false
	case "loadedmetadata":
		next.loaded = true
	}
	if kind == "seeked" || kind == "ended" || kind == "loadedmetadata" {
		next.waiting = false
	}
	states[id] = &next
	if request == nil {
		return nil
	}
	info := MediaEventInfo{CurrentTime: next.time, Duration: next.duration, Paused: next.paused, VideoWidth: next.videoWidth, VideoHeight: next.videoHeight}
	name := map[string]string{"loadedmetadata": "onLoadedMetadata", "play": "onPlay", "pause": "onPause", "timeupdate": "onTimeUpdate", "seeked": "onSeeked", "ended": "onEnded"}[kind]
	if kind == "error" {
		if h, ok := request.Handlers["onError"].(func(string)); ok {
			if message == "" {
				message = "media error"
			}
			return func() { h(message) }
		}
		return nil
	}
	if h, ok := request.Handlers[name].(func(MediaEventInfo)); ok {
		return func() { h(info) }
	}
	return nil
}

// MediaController drives an <audio> element by id.
type MediaController struct {
	app *App
	id  string
}

func (m MediaController) command(c S) {
	c["type"], c["id"] = "media", m.id
	m.app.sendPublic(c)
}
func (m MediaController) Play()  { m.command(S{"action": "play"}) }
func (m MediaController) Pause() { m.command(S{"action": "pause"}) }
func (m MediaController) Seek(seconds float64) {
	m.command(S{"action": "seek", "time": math.Max(0, seconds)})
}
func (m MediaController) SetVolume(v float64) {
	m.command(S{"action": "set", "volume": math.Min(1, math.Max(0, v))})
}
func (m MediaController) SetMuted(muted bool) { m.command(S{"action": "set", "muted": muted}) }
