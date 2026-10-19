# tarve-go (experimental)

Go host for the Tarve native renderer: the same Rust library and JSON protocol (`@tarve/protocol`),
loaded with [purego](https://github.com/ebitengine/purego) (no cgo, no C toolchain). Builds for
Windows, Linux and macOS (`GOOS=…`); run so far on Windows.

```
cd go
go run ./examples/counter
go run ./examples/youtube-music
```

The library is found through `TARVE_NATIVE` or `native/bin/current.json` (`bun run build:native`).

## Same app, node for node

`tarve` ports @tarve/core's reconciler (ids, font inheritance, theme tokens, focus rings, memo,
patch/mutate diffs, style variants `first`/`last`/`odd`/`even`/`sm`…`2xl`/`dark`, inline text runs) and
its components: `Window`, `TitleBar` (glass too), `View`, `Row`, `Column`, `Pressable`, `Scroll`, `Text`,
`Button`, `Svg`/`Icon`, `Image`, `Input`, `TextArea`, `Slider`, `Checkbox`, `Switch`, `RadioGroup`,
`Tabs`, `Accordion`, `Card`, `Badge`, `Separator`, `Progress`, `Link`, `Markdown`, `Code`, `Diff`, `Glass`,
`Modal`, `Tooltip`, `DropdownMenu`, `VirtualList`, `<audio>` (with `controls`) and HTML elements through
`E("div" | "p" | "h1" | "strong" | "a" | "img" …)`; plus the app API (tray, system media controls, hotkeys,
file dialogs, close requests, `scrollToItem`).

Props are named as in TSX, children follow JSX (one child, or a list):

```go
Row(Props{"gap": 10},
	Button(Props{"variant": "outline", "onClick": func() { count-- }}, "- Decrease"),
	Button(Props{"onClick": func() { count++ }}, "Increase +"))
```

Handlers, renders and `Post`ed functions run on the goroutine in `app.Run()`; network work runs in
goroutines that `app.Post` their results back.

`go test ./...` renders the counter, YouTube Music and `go/parity/fixtures.tsx` views in Go and in
TypeScript (`go/parity/dump.tsx`, through bun) over 56 states and handler sequences and requires
identical native documents.

## Where Go is faster

- Unchanged nodes are reused from the last render, so the diff only looks at the nodes compiled anew
  (and the ones native edited): 0 ms instead of ~3 ms for 2,000 rows.
- Lists of 256+ plain elements compile on all cores; caches are per goroutine and merged after.
- Styles are interned: equal styles share one object, compared by pointer and encoded to JSON once.

## Go vs TypeScript

```
bun go/bench/compare.ts updates auto 3   # scene: empty | fixed | updates
go test ./tarve -bench .                 # one update of 2,000 rows, without a window
```
