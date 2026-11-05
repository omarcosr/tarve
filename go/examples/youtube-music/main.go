// A YouTube Music client on the Go host: home feed, search, albums, playlists and artists, a play
// queue, your library after signing in with Google (a browser window, or pasted cookies), and
// synced lyrics on the now-playing page. The same app as examples/youtube-music, node for node.
// Personal-use demo: YouTube's Terms of Service forbid third-party clients.
package main

import (
	"log"
	"os"
	"path/filepath"
	"time"

	"github.com/omarcosr/tarve/go/examples/youtube-music/ytm"
	"github.com/omarcosr/tarve/go/tarve"
)

// iconPath finds examples/youtube-music/icon.png from the repository or next to the executable.
func iconPath() string {
	for _, dir := range []string{".", "..", "../..", "../../.."} {
		p := filepath.Join(dir, "examples", "youtube-music", "icon.png")
		if _, err := os.Stat(p); err == nil {
			return p
		}
	}
	if exe, err := os.Executable(); err == nil {
		p := filepath.Join(filepath.Dir(exe), "icon.png")
		if _, err := os.Stat(p); err == nil {
			return p
		}
	}
	return ""
}

func main() {
	icon := iconPath()
	// Name, icon and app id match examples/package.json "tarve".
	app, err := tarve.CreateApp(func() tarve.Child { return ytm.YouTubeMusicView() }, tarve.Options{
		CloseBehavior: "hide",
		AppIdentity:   &tarve.AppIdentity{ID: "Tarve.Examples.YouTubeMusic", Name: "YouTube Music (Tarve)", Icon: icon},
	})
	if err != nil {
		log.Fatal(err)
	}
	// The queue, song, position, volume and modes of the last run come back, paused.
	ytm.RestoreSession()
	app.Post(func() {
		ytm.Connect(app)
	})
	go func() {
		saving := time.NewTicker(5 * time.Second)
		defer saving.Stop()
		for {
			select {
			case <-saving.C:
				app.Post(ytm.SaveSession)
			case <-app.Closed():
				return
			}
		}
	}()
	go func() {
		<-app.Ready()
		app.Post(func() {
			app.Tray(tarve.TrayOptions{
				Tooltip:       "YouTube Music",
				OnDoubleClick: app.Show,
				Menu: []tarve.TrayMenuItem{
					{ID: "show", Label: "Open", OnSelect: app.Show},
					{Separator: true},
					{ID: "quit", Label: "Quit", OnSelect: app.Close},
				},
			})
		})
	}()
	err = app.Run()
	ytm.SaveSession()
	if err != nil {
		log.Fatal(err)
	}
}
