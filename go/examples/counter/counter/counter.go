// Package counter is examples/counter/counter.tsx on the Go host.
package counter

import (
	"fmt"

	. "github.com/omarcosr/tarve/go/tarve"
)

// State is the counter's module state, as the let bindings of counter.tsx.
var State = struct {
	Count        int
	Status       string
	ProtectClose bool
}{0, "Ctrl+S is registered as a global app hotkey.", true}

var app *App

// Connect gives the dialogs' buttons their app (counter.tsx assigns it after createApp).
func Connect(a *App) { app = a }

// dialog runs a file dialog off the app goroutine, then shows its result.
func dialog(run func() string) func() {
	return func() {
		go func() {
			status := run()
			app.Post(func() {
				State.Status = status
				app.Update()
			})
		}()
	}
}

// Render is the app view.
func Render() Child { return Counter() }

func Counter() *VNode {
	s := &State
	closeLabel, closeVariant := "Protect close", "secondary"
	if s.ProtectClose {
		closeLabel, closeVariant = "Allow close", "destructive"
	}
	return Window(Props{"title": "Counter", "width": 620, "height": 520, "minWidth": 520, "minHeight": 420,
		"onCloseRequest": func(event *CloseRequest) {
			if s.ProtectClose {
				event.PreventDefault()
				s.Status = "Close prevented. Click ‘Allow close’ before closing the window."
			}
		}},
		TitleBar(Props{"title": "Counter"}),
		Column(Props{"padding": 32, "gap": 20, "align": "center", "justify": "center", "flex": 1},
			Text(Props{"size": 15}, "A native Bun application + desktop APIs"),
			Text(Props{"size": 42, "weight": 600}, s.Count),
			Row(Props{"gap": 10},
				Button(Props{"variant": "outline", "onClick": func() { s.Count-- }}, "- Decrease"),
				Button(Props{"onClick": func() { s.Count++ }}, "Increase +")),
			Text(Props{"size": 13}, s.Status),
			Row(Props{"gap": 8, "style": S{"wrap": true}},
				Button(Props{"size": "sm", "variant": "outline", "onClick": dialog(func() string {
					path, _ := app.OpenFileDialog(FileDialogOptions{Title: "Open a text file", Filters: []FileDialogFilter{{Name: "Text", Extensions: []string{"txt", "md"}}}})
					if path != "" {
						return "Opened: " + path
					}
					return "Open file cancelled"
				})}, "Open file"),
				Button(Props{"size": "sm", "variant": "outline", "onClick": dialog(func() string {
					paths, _ := app.OpenFilesDialog(FileDialogOptions{Title: "Open multiple files"})
					if len(paths) > 0 {
						return fmt.Sprintf("Selected %d files", len(paths))
					}
					return "Open files cancelled"
				})}, "Open files"),
				Button(Props{"size": "sm", "variant": "outline", "onClick": dialog(func() string {
					path, _ := app.OpenFolderDialog(FileDialogOptions{Title: "Choose a folder"})
					if path != "" {
						return "Folder: " + path
					}
					return "Folder selection cancelled"
				})}, "Open folder"),
				Button(Props{"size": "sm", "variant": "outline", "onClick": dialog(func() string {
					path, _ := app.SaveFileDialog(FileDialogOptions{Title: "Save counter", FileName: "counter.txt", Filters: []FileDialogFilter{{Name: "Text", Extensions: []string{"txt"}}}})
					if path != "" {
						return "Save target: " + path
					}
					return "Save cancelled"
				})}, "Save file")),
			Button(Props{"size": "sm", "variant": closeVariant, "onClick": func() {
				s.ProtectClose = !s.ProtectClose
				if s.ProtectClose {
					s.Status = "Window close protection enabled"
				} else {
					s.Status = "Window may now be closed"
				}
			}}, closeLabel)))
}
