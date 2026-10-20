// Benchmark twin of go/bench/ts-bench.tsx: same scenes, same input script, same output keys.
// SCENE=empty|fixed|updates, R=auto|gpu|cpu.
package main

import (
	"encoding/json"
	"fmt"
	"log"
	"math"
	"os"
	"sort"
	"time"

	"github.com/omarcosr/tarve/go/tarve"
)

var processStart = time.Now()

func env(key, fallback string) string {
	if v := os.Getenv(key); v != "" {
		return v
	}
	return fallback
}

func percentiles(values []float64) []float64 {
	if len(values) == 0 {
		return nil
	}
	sort.Float64s(values)
	at := func(p float64) float64 {
		return math.Round(values[int(math.Min(float64(len(values)-1), math.Floor(p*float64(len(values)))))]*1000) / 1000
	}
	return []float64{at(0.5), at(0.95), at(0.99)}
}

// memory reads the process numbers native measures (Task Manager "Memory" and private commit).
func memory(app *tarve.App, out map[string]any, label string) {
	stats, err := app.Stats(false)
	if err != nil {
		return
	}
	if m, ok := stats["memory"].(map[string]any); ok {
		if c, ok := m["current"].(map[string]any); ok {
			out[label+"WorkingSetMb"], out[label+"PrivateMb"] = c["workingSetMb"], c["privateMb"]
		}
	}
}

func main() {
	scene := env("SCENE", "fixed")
	renderer := env("R", "auto")
	tick := 0
	listOffset := 0.0
	view := func() tarve.Child {
		if scene == "empty" {
			return tarve.Window(tarve.Props{"title": "bench", "width": 800, "height": 600}, tarve.Text(nil, "hi"))
		}
		row := func(i int) tarve.Child {
			return tarve.Row(tarve.Props{"key": i, "style": tarve.S{"height": 36, "shrink": 0}, "gap": 12},
				tarve.Text(tarve.Props{"style": tarve.S{"flex": 1}}, "Record ", i, ": native layout and text"),
				tarve.Button(tarve.Props{"size": "sm"}, "Open"))
		}
		if scene == "virtual" {
			// The same 2,000 rows through VirtualList: only those in view (and the overscan) are compiled.
			return tarve.Window(tarve.Props{"title": "bench", "width": 1024, "height": 760},
				tarve.Column(tarve.Props{"padding": 16, "gap": 12, "flex": 1},
					tarve.Text(nil, "Tick ", tick),
					tarve.VirtualList(tarve.Props{"id": "list", "count": 2000, "itemHeight": 36, "overscan": 4, "offset": listOffset,
						"keyForItem": func(i int) any { return i },
						"renderItem": func(i int) tarve.Child { return row(i) },
						"onScroll":   func(offset float64) { listOffset = offset },
						"style":      tarve.S{"flex": 1}})))
		}
		rows := make([]tarve.Child, 2000)
		for i := range rows {
			rows[i] = tarve.Row(tarve.Props{"key": i, "style": tarve.S{"height": 36, "shrink": 0}, "gap": 12},
				tarve.Text(tarve.Props{"style": tarve.S{"flex": 1}}, "Record ", i, ": native layout and text"),
				tarve.Button(tarve.Props{"size": "sm"}, "Open"))
		}
		var header tarve.Child = false
		if scene == "updates" {
			header = tarve.Text(nil, "Tick ", tick)
		}
		return tarve.Window(tarve.Props{"title": "bench", "width": 1024, "height": 760},
			tarve.Column(tarve.Props{"padding": 16, "gap": 12, "flex": 1},
				header,
				tarve.Scroll(tarve.Props{"id": "list", "flex": 1}, tarve.Column(nil, rows))))
	}
	app, err := tarve.CreateApp(view, tarve.Options{Debug: true, Renderer: renderer})
	if err != nil {
		log.Fatal(err)
	}
	go func() {
		defer app.Post(app.Close)
		<-app.Ready()
		// "ready" comes after native presented the first frame.
		firstFrame := time.Since(processStart).Milliseconds()
		out := map[string]any{"runtime": "go", "scene": scene, "renderer": renderer}
		s, err := app.Inspect()
		for err == nil && s["frames"].(float64) == 0 {
			time.Sleep(time.Millisecond)
			s, err = app.Inspect()
		}
		if err != nil {
			log.Println(err)
			return
		}
		out["firstFrameMs"] = firstFrame
		frames := func() float64 { s, _ := app.Inspect(); return s["frames"].(float64) }
		time.Sleep(3 * time.Second)
		memory(app, out, "idle")
		f0 := frames()
		time.Sleep(4 * time.Second)
		out["idleFrames"] = frames() - f0
		app.Stats(true)
		reset := make(chan struct{})
		app.Post(func() { app.Timings = nil; close(reset) })
		<-reset
		cx, cy := s["width"].(float64)/2, s["height"].(float64)/2
		f0 = frames()
		for i := 0; i < 240; i++ {
			delta := 60.0
			if i%80 >= 40 {
				delta = -60
			}
			app.Debug(tarve.S{"type": "input", "action": "wheel", "delta": delta})
			app.Debug(tarve.S{"type": "input", "action": "move", "x": cx + math.Sin(float64(i)/7)*cx*0.8, "y": cy + math.Cos(float64(i)/9)*cy*0.6})
			if scene == "updates" || scene == "virtual" {
				app.Post(func() { tick++; app.Update() })
			}
			time.Sleep(16 * time.Millisecond)
		}
		out["busyFrames"] = frames() - f0
		memory(app, out, "busy")
		timings := make(chan []tarve.UpdateTiming)
		app.Post(func() { timings <- append([]tarve.UpdateTiming(nil), app.Timings...) })
		var build, diff, total []float64
		for _, t := range <-timings {
			ms := func(d time.Duration) float64 { return float64(d.Microseconds()) / 1000 }
			build, diff = append(build, ms(t.Render)), append(diff, ms(t.Diff))
			total = append(total, ms(t.Render+t.Diff+t.Send))
		}
		out["hostRenderMs"], out["hostDiffMs"], out["hostUpdateMs"] = percentiles(build), percentiles(diff), percentiles(total)
		if stats, err := app.Stats(false); err == nil {
			if phases, ok := stats["phases"].(map[string]any); ok {
				for _, name := range []string{"apply", "layout", "paint", "present", "frame"} {
					if p, ok := phases[name].(map[string]any); ok {
						out[name+"Ms"] = []any{p["p50"], p["p95"], p["p99"]}
					}
				}
			}
		}
		b, _ := json.Marshal(out)
		fmt.Println("@result " + string(b))
	}()
	if err := app.Run(); err != nil {
		log.Fatal(err)
	}
}
