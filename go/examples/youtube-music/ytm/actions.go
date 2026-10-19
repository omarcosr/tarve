package ytm

import (
	"context"
	"fmt"
	"math"
	"math/rand"
	"strings"
	"time"

	"github.com/tarve/tarve-go/tarve"
)

// blockedRetries are the waits before retrying a song the bot check refused (VPN exits
// change; the block often lifts).
var blockedRetries = []time.Duration{20 * time.Second, time.Minute, 3 * time.Minute}

// Connect wires the view's state to the data source, the sign-in window and the app.
// Everything that touches state runs on the app goroutine; network work runs in goroutines
// that Post their results back.
func Connect(app *tarve.App) {
	queued := false
	mediaKey := ""
	var refresh func()
	syncSystemMedia := func() {
		song := state.current()
		duration := state.Duration
		if duration == 0 && song != nil && song.Duration != nil {
			duration = *song.Duration
		}
		key := ""
		if song != nil {
			key = fmt.Sprintf("%s|%v|%v|%v|%v", song.ID, state.Playing, duration, math.Floor(state.Time), state.Index > 0)
		}
		if key == mediaKey {
			return
		}
		mediaKey = key
		if song == nil {
			app.SystemMedia(nil)
			return
		}
		artwork := ""
		if song.Thumbnail != nil {
			artwork = replaceFirst(coverS, replaceFirst(coverWH, *song.Thumbnail, "=w544-h544"), "=s544")
		}
		app.SystemMedia(&tarve.SystemMediaSession{Title: song.Title, Artist: song.Artist, Album: song.Album, Artwork: artwork,
			Playing: state.Playing, Duration: duration, Position: state.Time, CanSeek: state.Path != "" && duration > 0,
			CanNext: len(state.Queue) > 0, CanPrevious: state.Index >= 0,
			OnAction: func(action string, t *float64) {
				switch action {
				case "play":
					state.media(tarve.MediaController.Play)
				case "pause":
					state.media(tarve.MediaController.Pause)
				case "next":
					state.Next()
				case "previous":
					state.Previous()
				default:
					if t != nil {
						at := *t
						state.media(func(m tarve.MediaController) { m.Seek(at) })
						state.Time = at
					}
				}
				refresh()
			}})
	}
	refresh = func() {
		if queued {
			return
		}
		queued = true
		app.Post(func() { queued = false; syncSystemMedia(); app.Update() })
	}
	// async runs work off the app goroutine and then done on it.
	async := func(work func() func()) {
		go func() {
			done := work()
			app.Post(done)
		}()
	}
	state.Refresh = refresh
	state.Hide = app.Hide
	state.Media = func() *tarve.MediaController { m := app.Media(AudioID); return &m }

	prefetch := func(song *Item) {
		if song != nil {
			id := song.ID
			go StreamURL(id)
		}
	}
	WarmUp()

	followed := -2
	var userScrolledAt time.Time
	state.LyricsScrolled = func(offset float64, info tarve.ScrollInfo) {
		state.LyricsOffset = offset
		if info.Source == "user" {
			userScrolledAt = time.Now()
		}
	}
	state.FollowLyrics = func() {
		song := state.current()
		var lines []LyricLine
		if song != nil && state.Lyrics != nil && state.Lyrics.ID == song.ID && state.Lyrics.Data != nil {
			lines = state.Lyrics.Data.Lines
		}
		if lines == nil || !LyricsShown() {
			followed = -2
			return
		}
		line := LineAt(lines, state.Time)
		if line == followed || time.Since(userScrolledAt) < 4*time.Second {
			return
		}
		smooth := followed >= 0 && line == followed+1
		followed = line
		height := 600.0
		if state.Stage != nil {
			height = state.Stage.Height
		}
		app.ScrollToItem(LyricsList, max(0, line), -math.Round(height*0.3), smooth)
	}

	type cached struct{ data *Lyrics }
	lyricsCache := map[string]cached{}
	var lyricsOrder []string
	var lyricsCancel context.CancelFunc
	loadLyrics := func() {
		song := state.current()
		if song == nil || state.Page.Kind != "playing" {
			return
		}
		if state.Lyrics != nil && state.Lyrics.ID == song.ID && state.Lyrics.Status != "error" {
			return
		}
		state.LyricsOffset = 0
		followed = -2
		if lyricsCancel != nil {
			lyricsCancel()
		}
		if hit, ok := lyricsCache[song.ID]; ok {
			if hit.data != nil {
				state.Lyrics = &LyricsEntry{ID: song.ID, Status: "ready", Data: hit.data}
			} else {
				state.Lyrics = &LyricsEntry{ID: song.ID, Status: "none"}
			}
			return
		}
		ctx, cancel := context.WithCancel(context.Background())
		lyricsCancel = cancel
		state.Lyrics = &LyricsEntry{ID: song.ID, Status: "loading"}
		async(func() func() {
			data, err := LyricsFor(ctx, song)
			return func() {
				if err == nil {
					if _, ok := lyricsCache[song.ID]; !ok {
						lyricsOrder = append(lyricsOrder, song.ID)
					}
					lyricsCache[song.ID] = cached{data}
					for len(lyricsOrder) > 100 {
						delete(lyricsCache, lyricsOrder[0])
						lyricsOrder = lyricsOrder[1:]
					}
				}
				if ctx.Err() != nil {
					return
				}
				if err != nil {
					msg := err.Error()
					state.Lyrics = &LyricsEntry{ID: song.ID, Status: "error", Error: &msg}
				} else if data != nil {
					state.Lyrics = &LyricsEntry{ID: song.ID, Status: "ready", Data: data}
				} else {
					state.Lyrics = &LyricsEntry{ID: song.ID, Status: "none"}
				}
				refresh()
			}
		})
	}

	pageToken := 0
	var pageCancel context.CancelFunc
	load := func(token int, task func() (any, error), apply func(any)) {
		async(func() func() {
			value, err := task()
			return func() {
				if err == nil {
					if token == pageToken {
						apply(value)
					}
				} else if token == pageToken && !(state.Page.Kind == "home" && state.Shelves != nil) && !(state.Page.Kind == "collection" && state.Opened != nil) {
					msg := err.Error()
					state.PageError = &msg
				}
				refresh()
			}
		})
	}
	show := func(page *Page) {
		if pageCancel != nil {
			pageCancel()
		}
		ctx, cancel := context.WithCancel(context.Background())
		pageCancel = cancel
		pageToken++
		token := pageToken
		state.Page = page
		state.PageError = nil
		state.ListOffset = 0
		switch {
		case page.Kind == "home":
			if state.Shelves == nil {
				load(token, func() (any, error) {
					return Home(ctx, func(shelves []*Shelf) {
						app.Post(func() {
							if token != pageToken {
								return
							}
							state.Shelves = shelves
							refresh()
						})
					})
				}, func(v any) { state.Shelves = v.([]*Shelf) })
			}
		case page.Kind == "search":
			state.Results = nil
			if page.Query != "" {
				q := page.Query
				load(token, func() (any, error) { return Search(q) }, func(v any) {
					state.Results = v.([]*Item)
					if len(state.Results) > 0 {
						prefetch(state.Results[0])
					}
				})
			}
		case page.Kind == "library":
			if state.SignedIn {
				load(token, func() (any, error) { return Library() }, func(v any) { state.Library = v.([]*Item) })
			}
		case page.Kind == "collection" && (state.Opened == nil || state.Opened.Header.ID != page.Entry.ID):
			state.Opened = nil
			entry := page.Entry
			load(token, func() (any, error) {
				return CollectionOf(ctx, entry, func(o *Opened) {
					app.Post(func() {
						if token != pageToken {
							return
						}
						state.Opened = o
						refresh()
					})
				})
			}, func(v any) {
				state.Opened = v.(*Opened)
				if len(state.Opened.Songs) > 0 {
					prefetch(state.Opened.Songs[0])
				}
			})
		case page.Kind == "playing":
			loadLyrics()
		}
		refresh()
	}
	pageKey := func(p *Page) string {
		if p == nil {
			return ""
		}
		k := p.Kind + "|" + p.Query
		if p.Entry != nil {
			k += "|" + p.Entry.Kind + "|" + p.Entry.ID + "|" + p.Entry.Title + "|" + p.Entry.Subtitle
		}
		if p.Kind == "search" {
			k += "|q"
		}
		return k
	}
	state.Open = func(page *Page) {
		if pageKey(page) != pageKey(state.Page) {
			state.Back = append(state.Back, state.Page)
		}
		show(page)
	}
	state.GoBack = func() {
		if n := len(state.Back); n > 0 {
			page := state.Back[n-1]
			state.Back = state.Back[:n-1]
			show(page)
		}
	}

	playToken, retriedToken, skipped := 0, -1, 0
	// Retries of the current song after YouTube's bot check refused the network.
	blocked := 0
	radioFor := ""
	var radioWaiters []func()
	radioLoading := false
	var start func()
	extendQueue := func(done func()) {
		if len(state.Queue) == 0 || state.Repeat != "off" {
			if done != nil {
				done()
			}
			return
		}
		seed := state.Queue[len(state.Queue)-1]
		if seed.ID == radioFor && radioLoading {
			if done != nil {
				radioWaiters = append(radioWaiters, done)
			}
			return
		}
		radioFor, radioLoading = seed.ID, true
		if done != nil {
			radioWaiters = append(radioWaiters, done)
		}
		queueAtStart := state.Queue
		async(func() func() {
			songs, err := Radio(seed.ID)
			return func() {
				radioLoading = false
				if err != nil {
					radioFor = ""
				} else if len(state.Queue) == len(queueAtStart) && (len(queueAtStart) == 0 || &state.Queue[0] == &queueAtStart[0]) {
					have := map[string]bool{}
					for _, s := range state.Queue {
						have[s.ID] = true
					}
					var more []*Item
					for _, s := range songs {
						if !have[s.ID] {
							more = append(more, s)
						}
					}
					if len(more) > 0 {
						state.Queue = append(append([]*Item{}, state.Queue...), more...)
						if !strings.HasSuffix(state.Source, "radio") {
							if state.Source != "" {
								state.Source += " · radio"
							} else {
								state.Source = seed.Title + " radio"
							}
						}
						refresh()
					}
				}
				waiters := radioWaiters
				radioWaiters = nil
				for _, w := range waiters {
					w()
				}
			}
		})
	}
	skipUnplayable := func(failure string) {
		state.PlayError = &failure
		state.Playing = false
		// The bot check refuses the network, not the song: every next song would fail the same
		// way, so skipping would only spam YouTube. Retry this one a few times, slower each time.
		if failure == botCheck {
			if blocked < len(blockedRetries) {
				token, index := playToken, state.Index
				time.AfterFunc(blockedRetries[blocked], func() {
					app.Post(func() {
						if token == playToken && state.Index == index {
							blocked++
							start()
						}
					})
				})
			}
			refresh()
			return
		}
		skipped++
		if skipped > 3 {
			refresh()
			return
		}
		token := playToken
		time.AfterFunc(1500*time.Millisecond, func() {
			app.Post(func() {
				if token == playToken {
					state.Next()
				}
			})
		})
		refresh()
	}
	state.MediaFailed = func(failure string) {
		song := state.current()
		token := playToken
		if song == nil || retriedToken == token {
			skipUnplayable(failure)
			return
		}
		retriedToken = token
		resumeAt := state.Time
		ForgetStreamURL(song.ID)
		state.Path = ""
		state.Loading = ptr(0)
		refresh()
		async(func() func() {
			url, err := StreamURL(song.ID)
			return func() {
				if token != playToken {
					return
				}
				state.Loading = nil
				if err != nil {
					skipUnplayable(err.Error())
					return
				}
				state.ResumeAt = resumeAt
				state.Path = url
				refresh()
			}
		})
	}
	loadedID := ""
	start = func() {
		song := state.current()
		if song == nil {
			return
		}
		if song.ID == loadedID && state.Path != "" && state.PlayError == nil {
			playToken++
			state.media(tarve.MediaController.Play)
			state.media(func(m tarve.MediaController) { m.Seek(0) })
			state.Time = 0
			refresh()
			return
		}
		loadedID = ""
		loadLyrics()
		playToken++
		token := playToken
		state.Path, state.Playing, state.Time = "", false, 0
		state.Duration = 0
		if song.Duration != nil {
			state.Duration = *song.Duration
		}
		state.PlayError, state.ResumeAt, state.Loading = nil, 0, ptr(0)
		async(func() func() {
			url, err := StreamURL(song.ID)
			return func() {
				if token != playToken {
					return
				}
				state.Loading = nil
				if err != nil {
					skipUnplayable(err.Error())
					return
				}
				state.Path = url
				loadedID = song.ID
				refresh()
				if state.Index+1 < len(state.Queue) && blocked == 0 {
					go StreamURL(state.Queue[state.Index+1].ID)
				}
			}
		})
		if state.Index+3 >= len(state.Queue) {
			extendQueue(nil)
		}
		refresh()
	}
	state.Played = func() { skipped, blocked = 0, 0 }
	state.Play = func(queue []*Item, index int, from string) {
		state.Queue = append([]*Item{}, queue...)
		state.Index = index
		state.Source = from
		if state.Shuffle {
			state.Shuffle = false
			state.ToggleShuffle()
		}
		start()
	}
	state.Jump = func(index int) {
		if index != state.Index && index >= 0 && index < len(state.Queue) {
			state.Index = index
			start()
		}
	}
	state.Next = func() {
		switch {
		case state.Index+1 < len(state.Queue):
			state.Index++
			start()
		case state.Repeat == "all" && len(state.Queue) > 0:
			state.Index = 0
			start()
		case len(state.Queue) > 0:
			token := playToken
			state.Loading = ptr(0)
			refresh()
			extendQueue(func() {
				if token != playToken {
					return
				}
				state.Loading = nil
				if state.Index+1 < len(state.Queue) {
					state.Index++
					start()
				} else {
					refresh()
				}
			})
		}
	}
	state.Previous = func() {
		if state.Time > 3 || state.Index == 0 {
			state.media(func(m tarve.MediaController) { m.Seek(0) })
			state.Time = 0
			return
		}
		state.Index--
		start()
	}
	state.ToggleShuffle = func() {
		state.Shuffle = !state.Shuffle
		if !state.Shuffle || state.Index < 0 {
			return
		}
		rest := append([]*Item{}, state.Queue[state.Index+1:]...)
		for i := len(rest) - 1; i > 0; i-- {
			j := rand.Intn(i + 1)
			rest[i], rest[j] = rest[j], rest[i]
		}
		state.Queue = append(append([]*Item{}, state.Queue[:state.Index+1]...), rest...)
	}

	loadLibrary := func() {
		async(func() func() {
			list, err := Library()
			return func() {
				if err == nil {
					state.Library = list
					refresh()
				}
			}
		})
	}
	signedIn := func() {
		state.SignedIn = SignedIn()
		state.SignIn = "closed"
		state.SignInError = nil
		state.PastedCookies = ""
		state.Library, state.Shelves, state.Opened = nil, nil, nil
		if state.Page.Kind == "library" {
			show(state.Page)
		} else {
			show(&Page{Kind: "home"})
		}
		if state.SignedIn {
			loadLibrary()
		}
	}
	var signInCancel context.CancelFunc
	var signInCtx context.Context
	state.SignInWithBrowser = func() {
		if signInCancel != nil {
			signInCancel()
		}
		ctx, cancel := context.WithCancel(context.Background())
		signInCtx, signInCancel = ctx, cancel
		state.SignIn = "browser"
		state.SignInError = nil
		async(func() func() {
			cookies, err := SignInWithBrowser(ctx)
			return func() {
				if err == nil {
					if err = UseCookies(cookies); err == nil {
						signedIn()
						return
					}
				}
				if ctx.Err() != nil && state.SignIn == "closed" {
					return
				}
				state.SignIn = "choose"
				msg := err.Error()
				state.SignInError = &msg
				refresh()
			}
		})
		refresh()
	}
	state.SavePastedCookies = func() {
		if err := UseCookies(state.PastedCookies); err != nil {
			msg := err.Error()
			state.SignInError = &msg
			return
		}
		signedIn()
	}
	state.SignOut = func() { SignOut(); signedIn() }

	closeWatch := time.NewTicker(500 * time.Millisecond)
	mediaWatch := time.NewTicker(time.Second)
	go func() {
		for {
			select {
			case <-closeWatch.C:
				app.Post(func() {
					if state.SignIn != "browser" && signInCtx != nil && signInCtx.Err() == nil {
						signInCancel()
					}
				})
			case <-mediaWatch.C:
				app.Post(syncSystemMedia)
			case <-app.Closed():
				closeWatch.Stop()
				mediaWatch.Stop()
				if signInCancel != nil {
					signInCancel()
				}
				return
			}
		}
	}()

	app.RegisterHotkey("Space", func() {
		if state.Path == "" {
			return
		}
		if state.Playing {
			state.media(tarve.MediaController.Pause)
		} else {
			state.media(tarve.MediaController.Play)
		}
	})
	state.SignedIn = SignedIn()
	show(&Page{Kind: "home"})
	if state.SignedIn {
		loadLibrary()
	}
}
