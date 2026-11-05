package ytm

// The last session, as youtube-music-session.ts: the queue, the song and where it was, volume
// and playback modes. Reopening the app picks up where it was left, paused, instead of an
// empty player (the official web app forgets its queue on reload).

import (
	"encoding/json"
	"math"
	"os"
	"path/filepath"
)

var sessionFile = filepath.Join(dataDir, "session.json")

// sessionKept: songs kept around the current one, enough history and up-next for a small file.
const sessionKept = 200

type session struct {
	Queue    []*Item `json:"queue"`
	Index    int     `json:"index"`
	Time     float64 `json:"time"`
	Source   string  `json:"source"`
	Volume   float64 `json:"volume"`
	Muted    bool    `json:"muted"`
	Shuffle  bool    `json:"shuffle"`
	Repeat   string  `json:"repeat"`
	Autoplay bool    `json:"autoplay"`
}

// RestoreSession loads the last session into the state, paused.
func RestoreSession() {
	data, err := os.ReadFile(sessionFile)
	if err != nil {
		return
	}
	var saved struct {
		Queue    []*Item  `json:"queue"`
		Index    *float64 `json:"index"`
		Time     *float64 `json:"time"`
		Source   *string  `json:"source"`
		Volume   *float64 `json:"volume"`
		Muted    *bool    `json:"muted"`
		Shuffle  *bool    `json:"shuffle"`
		Repeat   *string  `json:"repeat"`
		Autoplay *bool    `json:"autoplay"`
	}
	if json.Unmarshal(data, &saved) != nil {
		return
	}
	if saved.Volume != nil && *saved.Volume >= 0 && *saved.Volume <= 1 {
		state.Volume = *saved.Volume
	}
	if saved.Muted != nil {
		state.Muted = *saved.Muted
	}
	if saved.Shuffle != nil {
		state.Shuffle = *saved.Shuffle
	}
	if saved.Repeat != nil && (*saved.Repeat == "off" || *saved.Repeat == "all" || *saved.Repeat == "one") {
		state.Repeat = *saved.Repeat
	}
	if saved.Autoplay != nil {
		state.Autoplay = *saved.Autoplay
	}
	queue := []*Item{}
	for _, song := range saved.Queue {
		if song != nil && song.Kind == "song" && song.ID != "" {
			queue = append(queue, song)
		}
	}
	index := -1
	if saved.Index != nil {
		index = int(math.Floor(*saved.Index))
	}
	if index < 0 || index >= len(queue) {
		return
	}
	state.Queue, state.Index = queue, index
	if saved.Source != nil {
		state.Source = *saved.Source
	}
	state.Time = 0
	if saved.Time != nil && *saved.Time > 0 {
		state.Time = *saved.Time
	}
	state.Duration = 0
	if queue[index].Duration != nil {
		state.Duration = *queue[index].Duration
	}
}

var sessionWritten string

// SaveSession writes the session when it changed; a read-only home only loses it.
func SaveSession() {
	from := max(0, state.Index-20)
	queue := state.Queue[min(from, len(state.Queue)):min(from+sessionKept, len(state.Queue))]
	data, err := json.Marshal(session{Queue: queue, Index: state.Index - from, Time: math.Floor(state.Time), Source: state.Source,
		Volume: state.Volume, Muted: state.Muted, Shuffle: state.Shuffle, Repeat: state.Repeat, Autoplay: state.Autoplay})
	if err != nil || string(data) == sessionWritten {
		return
	}
	if os.MkdirAll(dataDir, 0o755) == nil && os.WriteFile(sessionFile, data, 0o600) == nil {
		sessionWritten = string(data)
	}
}
