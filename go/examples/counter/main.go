// The counter example (examples/counter) on the Go host, node for node: a counter, the native file
// dialogs, a close request the app can refuse, and a global Ctrl+S hotkey.
package main

import (
	"fmt"
	"log"

	"github.com/tarve/tarve-go/examples/counter/counter"
	"github.com/tarve/tarve-go/tarve"
)

func main() {
	app, err := tarve.CreateApp(counter.Render, tarve.Options{Renderer: "cpu", LowPower: true})
	if err != nil {
		log.Fatal(err)
	}
	counter.Connect(app)
	app.RegisterHotkey("Ctrl+S", func() {
		counter.State.Status = fmt.Sprintf("Ctrl+S handled at count %d", counter.State.Count)
	})
	if err := app.Run(); err != nil {
		log.Fatal(err)
	}
}
