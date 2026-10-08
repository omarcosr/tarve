# Changelog

All notable changes to `@tarve/core`, `@tarve/react-icons` and `@tarve/headless` are documented here. Versions follow [Semantic Versioning](https://semver.org/); before 1.0, minor versions may contain breaking changes.

## Unreleased

### Changed
- Windows (D3D11): 8x MSAA renders through a fixed 256px tile instead of window-sized targets, and each tile is hashed so an unchanged one is reused from the last frame. Memory no longer grows with the window (2560×1400: 369 → 151 MB of working set) and a hover redraws only the tiles it touches (player example: median GPU time per hover frame 3.9 → 1.3 ms). Linear-gradient bands are cut to the shape's box instead of covering ~7× its area, and draws inside a clip only mark the clip's tiles dirty; the tile hash is computed once per command per frame. With 600 spinning gradient squares: tiles redrawn per frame 16 → 12, CPU time per frame 3.2 → 0.85 ms. Output is identical (gradient edges within 1/255).
- **Breaking:** `flex` follows CSS. `flex: 1` is now `flex: 1 1 0` with CSS's automatic minimum size: the item shrinks when space runs out but not below its content. Before, a numeric `flex` never shrank and could be squeezed below its content. Add `minWidth: 0` (or `minHeight: 0` in a column) where content should be clipped or scroll instead of pushing the layout, as in CSS. Scroll areas already do this.
- **Breaking:** every flex item shrinks by default (`shrink: 1`, CSS `flex-shrink: 1`), never below its content; sized `Image`s and `Svg`s keep their size like CSS replaced elements. Set `shrink: 0` to keep a fixed size when space runs out.

### Added
- `app.setMaxFps(fps)` and the `maxFps` option set the animation frame rate (transitions, `spin`, keyframes); `null` follows the display's refresh rate. Animations stay clock-based, so a lower rate draws fewer frames at the same speed. The clock now ticks on a fixed grid: a late frame no longer delays the next one, so 60 fps animations run at 60 instead of ~52. Example: `examples/fps.tsx`. Native protocol v55.
- `<audio src controls autoPlay loop muted volume>` with the browser's default control bar (play/pause, time, seek, mute) and `onLoadedMetadata`, `onPlay`, `onPause`, `onTimeUpdate`, `onSeeked`, `onEnded`, `onError`. Play after the end starts over, as in `HTMLMediaElement`. `app.media(id)` plays, pauses, seeks and sets volume. MP3, WAV, FLAC, Ogg Vorbis and AAC/MP4 decode in pure Rust (rodio): WASAPI on Windows, ALSA on Linux (`libasound2` at runtime, `libasound2-dev` to build). Without an output device, or with `TARVE_AUDIO=silent`, playback runs on a real-time silent clock so time and `ended` still advance. `bun run smoke:media` checks the lifecycle. Native protocol v54.
- `<audio src="https://…">` streams: playback starts once the first 256 KB chunk arrives (≈0.15 s on YouTube's CDN), the rest downloads behind it over up to four HTTP range connections (rustls via `ureq`, no system TLS), and a seek fetches the chunk it lands in first. Servers without range support still stream in order. Remote MP4s open unseekable so they start before the file is in; the first seek builds a seekable decoder in the background and then emits `seeked`. A connection that fails mid-way reports `error`, not `ended`.
- `memo(Component, equal?)`: a component whose compiled subtree is reused while its props are equal (shallowly by default), so an update renders, compiles and diffs only the components whose props changed. Reused subtrees keep their native shadow, so the diff skips them by identity; subtrees tied to a `<label htmlFor>` elsewhere, or containing the `Window`, always recompile. In the YouTube Music example the clock ticking during playback costs 1.4 ms per update instead of 30 ms.
- `onSize` on any node (a ResizeObserver): native sends the content-box size on first layout and whenever it changes, window resizes included.
- `VirtualList` without `height` fills its parent (`flex: 1`) and follows its real laid-out height through `onSize`; it needs an `id`. Fixed, variable and windowed lists all support it.
- A handler that runs inside a `memo` subtree recompiles that subtree on the next render, so components keeping their own state (VirtualList's measured height) stay current.
- Anonymous nodes are named from their nearest node instead of the root, so scrolling a virtual list sends about 40% fewer bytes per step; memo bookkeeping no longer rescans every compiled node on each cache miss.
- Decoded images are shared by `key`: a new node showing a cached key reuses the decode, and images no node shows stay decoded (up to 256, 32 MB of CPU pixels; on D3D11 only the texture) so a list row scrolling back or a page reopening decodes nothing. Returning to the YouTube Music home (125 covers): 104–126 ms → 58–68 ms. Byte sources are base64-encoded once per source object. Measured and rejected: a binary bridge for image bytes, which saved under 0.1 ms per cover against 0.35 ms of JPEG decode.
- `memo` keeps nested memoized components alive from a list recorded at compile time instead of scanning every cache entry on each hit: an update of 2,000 memoized rows went from 19 ms to 3.7 ms of JS.
- Text measurement is cached per width, and any width at least as wide as the unwrapped line reuses the unwrapped size: a window resize relayouts 2,000 labelled rows in 18 ms instead of 21.5 ms, and 400 wrapped paragraphs in 9 ms instead of 13 ms.
- `createApp({ headless: true })` (tests, captures, `createTestRenderer`) renders on the CPU unless a `renderer` is given: a hidden window never reaches the screen, so it no longer loads the GPU driver. Empty headless app on Windows: 138 MB → 51 MB working set, first frame 86 ms → 20 ms.
- Windows: once a window has been idle for `memoryTrimDelay` ms (default 3000) after its last frame, the pages only startup touched (driver and shader setup) are handed back with `EmptyWorkingSet` (the first time even while animating: startup's pages are done with by then; later only after the window has been still that long); they stay committed and return from the standby list if touched. Counter app: 50 MB → 3 MB private working set (Task Manager). `memoryTrimDelay: false` turns it off; `TARVE_TRIM` (ms, 0 = off) overrides it.
- D3D11 no longer multisamples by default: `msaa: 0` (the default) gives filled and stroked shapes a one-pixel coverage fringe instead, ~30 MB less memory (counter app: 80 → 50 MB private working set, 259 → 229 MB committed). Without MSAA, a rectangle, rounded rectangle or circle clip (`overflow: hidden` with `radius`, gradient fills, nested scroll areas, also rotated, e.g. spinning) is applied in the pixel shader with coverage, as MyGo does; other `clip-path` shapes and hard stops inside gradients stay aliased. `msaa: 2 | 4 | 8` (or `TARVE_MSAA`) brings MSAA back.
- D3D11 keeps an uploaded image only as its texture: the decoded CPU pixels are released after upload and decoded again from the node if the texture is lost, and fully restored when another renderer takes over. 30 screenshot-sized images: 622 MB → 429 MB working set.
- `<canvas width height onDraw={ctx => …}>` with the Canvas 2D API: paths (`moveTo`, `lineTo`, `quadraticCurveTo`, `bezierCurveTo`, `arc`, `arcTo`, `ellipse`, `rect`, `roundRect`), `fill` (nonzero/evenodd), `stroke` (width, caps, joins, miter limit, dashes), `fillRect`/`strokeRect`/`clearRect`, linear and radial gradients, `save`/`restore`, `translate`/`rotate`/`scale`/`setTransform`, `globalAlpha` and `fillText`/`strokeText` with the CSS `font` shorthand. Each render records into a vector scene, sharp at any DPI. `bun run test:canvas` compares 10 drawings pixel by pixel with Chromium's canvas.
- `<sub>` and `<sup>`: `vertical-align: sub | super` with `font-size: smaller`, shifting by Chromium's parent size / 5 + 1px and / 3 + 1px, nesting, and growing the line box (and the lines below it) to contain the shifted text; selection and caret follow. The CSS parity suite checks them against Chromium within 2px.
- `<input type="color">` (swatch, palette and hex field; values normalize to lowercase `#rrggbb`) and `<input type="time">` (`HH:MM`, 24-hour; invalid entries submit as empty, as in HTML).
- `display: "block"`: CSS block flow, where adjacent vertical margins collapse (Taffy's block layout). In a flex container margins add up, as in CSS. The CSS parity suite covers collapsing paragraphs and headings (49 layouts).
- **Breaking:** HTML block elements get the browser's user-agent margins: `<p>` and `<pre>` 1em above and below, `<h1>`–`<h6>` 0.67em–2.33em, lists and `<dl>` 1em, `<blockquote>` 1em 40px. `Text`, `View` and the other components are unchanged; set `margin` to override.
- `cursor` style (CSS keywords, inherited by descendants). `gridColumn`/`gridRow` placements (`"span 2"`, `"1 / 3"`), and table `colSpan`/`rowSpan`. `<pre>`, `<blockquote>`, `<meter>` and `<abbr title>`. The CSS parity suite covers spanning tables, `pre` and `blockquote` (46 layouts). Native protocol v53.
- HTML elements: `<input type="checkbox" | "radio" | "range" | "date" | "file">` (radios grouped by `name`; `accept`/`multiple` for files through the native dialog); `<form onSubmit onInvalid>` collecting named values on Enter or a submit button, with `required`, and `<button type="button">` opting out; `<fieldset>`/`<legend>`; `<ul>`, `<ol start>`, `<li>`, `<dl>`/`<dt>`/`<dd>` with the user-agent 40px indent; `<table>` with `caption`/`thead`/`tbody`/`tfoot`/`tr`/`th`/`td` as auto columns with `border-spacing: 2px` and 1px cell padding; `<details>`/`<summary>`. Uncontrolled elements keep their state like the DOM. The CSS parity suite adds lists and a table against Chromium (43 layouts). Bare string children now inherit text style like any text. Example: `examples/html.tsx`.
- Text properties are inherited like CSS. `fontFamily`, `fontStyle`, `letterSpacing`, `wordSpacing` and `textTransform` reach every text descendant (text, buttons, inputs, Markdown); `color`, `fontSize`, `fontWeight`, `lineHeight`, `textAlign` and `whiteSpace` also reach `Text`/`p`/`span`/headings and `Markdown`, while controls keep their own size, weight and colour. Set them on a `Window` or any container; a node's own value wins. The theme gives the root's initial values; `Code`, `Diff` and `<code>` stay monospace.
- **Breaking:** text follows CSS `white-space: normal` by default: runs of spaces and newlines collapse to one space and leading/trailing spaces are dropped. Use `whiteSpace: "pre-wrap"` (or `"pre"`/`"pre-line"`) to keep them, or `<br />` for a line break.
- CSS text and overflow: phrasing elements inside a paragraph (`strong`, `b`, `em`, `i`, `u`, `s`, `del`, `ins`, `code`, `kbd`, `mark`, `small`, nested `span`, `a`, `br`) become styled runs of one text node with Chromium's user-agent styles and relative `bolder`/`smaller`; `<a href>` and `<span onClick>` inside text are click targets. New styles `fontStyle`, `letterSpacing`, `wordSpacing`, `textTransform`, `whiteSpace` (`normal`/`nowrap`/`pre`/`pre-wrap`/`pre-line`), `textOverflow: "ellipsis"`, `lineClamp` and `overflow: "hidden" | "clip"` (clips children and lets the box shrink below its content). Links and clickable spans inside text show the pointer cursor. `fontFaces` in `createApp` options loads app font files like CSS `@font-face`, and variable fonts follow `font-optical-sizing: auto` (the `opsz` axis tracks the font size). The CSS parity suite covers 15 text cases against Chromium with the bundled Inter on every OS, plus two overflow cases; `bun run smoke:text` checks the painted `<mark>`, ellipsis, clamp and clip pixels. Example: `examples/text.tsx`. Native protocol v52.
- Windows: dragging a window between monitors with different display scaling keeps its size; it grew by the scale ratio on every crossing and could bounce on the boundary. A window with a custom `TitleBar` can be dragged again right after a move.
- `@tarve/headless`: renders and tests Tarve apps with the WebAssembly build of the native tree, with no window, GPU or native library. `renderToPng`/`renderToRgba`, `createHeadlessApp`, `createHeadlessTestRenderer` (the `TestRenderer` API) and `matchImageSnapshot`. Text uses bundled Inter and JetBrains Mono and time only moves with `advanceMotion`, so a view renders to the same bytes on every machine. CI runs its image snapshots on Linux, Windows and macOS; releases publish it next to `@tarve/core`.
- `style.spin`: continuous rotation about the centre, one turn per `spin` milliseconds, driven by the native clock. `Spinner` uses it.
- `destructiveText` theme colour for error text and icons.
- Pointer drag and drop. `draggable` on `Pressable` turns a press that travels past 4px into a drag (a short press still clicks); `onDragStart`, `onDragMove` and `onDragEnd` report position, the target under the pointer and whether the drag was cancelled (Escape or window blur). Any view with `onDrop`, `onDragEnter` or `onDragLeave` becomes a drop target; the innermost visible target wins, targets inside the dragged node, clipped by a scroll area, disabled or behind a modal are skipped. Example: `examples/drag-and-drop.tsx`. Native protocol v49.
- System tray and notifications on Windows and Linux: `app.tray({ icon, tooltip, menu, onClick, onDoubleClick, onMenu })` shows a tray icon with a native menu (items, separators, checkmarks, disabled items, submenus); `update()` changes it in place. `app.notify({ title, body, onClick })` shows a desktop notification. `app.show()`, `app.hide()`, `app.minimize()` and `closeBehavior: "hide"` keep an app running in the tray. Windows calls `Shell_NotifyIconW`/`TrackPopupMenu` directly (no new dependency) and re-adds the icon after Explorer restarts. Linux publishes a StatusNotifierItem with dbusmenu (`ksni`) and uses org.freedesktop.Notifications (`notify-rust`), both pure-Rust zbus; KDE, XFCE, Cinnamon, MATE and most wlroots bars show it natively, GNOME needs the AppIndicator extension (the app gets an error event otherwise). `onDoubleClick` maps to middle click on Linux. Icons are read in JS so compiled executables can use imported assets. `bun run smoke:tray` drives the real icon and menu on both systems. Example: `examples/tray.tsx`. Native protocol v50.
- CSS flex and grid sizing: `flex` accepts the CSS shorthand (`"1 1 176px"`, `"auto"`, `"none"`), plus `grow` and `basis`. Grid `columns` and new `rows` accept CSS track lists, including `repeat(auto-fill, minmax(176px, 1fr))`, `fr`, percentages and `auto`. `bun run test:css-layout` lays out 23 cases in Chromium and in Tarve and fails on any box more than a pixel apart. Native protocol v51.

- Node.js 26.10+ runtime alongside Bun: the same TSX apps run through `node:ffi`. One CLI for both: `tarve run|dev|build` uses the runtime that launched it (`bunx`/`bun run` → Bun, `npx`/`npm run` → Node 26.10+, or Bun as before on older Node; `--runtime` overrides). Node builds are single-executable apps with the native library and imported assets embedded, the same GUI subsystem and app name/version metadata as Bun builds; `dev` remounts into the same window on edits; `--target linux-x64`/`windows-x64` cross-compiles by downloading (checksum-verified, cached) the matching official Node.js binary, and `--target-executable` supplies one offline. `build({ runtime: "node" })` and `@tarve/core/build-node` expose the same from code. `TestRenderer`, `launchTestProcess` and `readPngRgba` no longer depend on Bun APIs.

### Fixed
- Thin dotted underlines (`text-decoration-style: dotted`, `abbr[title]`) draw square dots snapped to device pixels, as browsers do; round 1px dots smeared into a grey line at fractional scales, on the CPU renderer most visibly.
- Changing an `<Image>`'s byte source (its `cacheKey` or bytes) on an existing node now repaints; the diff ignored `image` and sent nothing.
- An explicit `minWidth` on an item with numeric `flex` is respected; it was reset to 0. Grid `auto` tracks stretch to fill the container, as in CSS. `DataGrid` rows and sortable headers are square instead of inheriting `Pressable` rounding.
- `examples/drag-and-drop-view.tsx` used the unsupported `justify: "space-between"` and failed the package smoke typecheck; it now uses `"between"`.
- A modal opened with the mouse no longer paints the keyboard focus ring on its first control, and closing it no longer rings the trigger.
- `Tooltip` text no longer wraps to the width of its trigger; `Command` lists no longer clip with group headings; the search field of `Command` and `Combobox` no longer draws a ring across its icon.
- `Alert`, `Field` errors and failed `Attachment`s use readable destructive text; `Alert` tints an uncoloured icon; `Field` shows the description with the error; `InputGroup` strips its `Input`'s border; `NavigationMenu` triggers show open and current state.
- `getByRole("button", { name })` finds plain `Button`s.
- `InputGroup` is clickable across its whole box: presses on the prefix, suffix or padding focus the field (text cursor included), and the group shows a focus border. New style value `pointerEvents: "delegate"` sends presses on a node's own area to its first enabled input or textarea and gives the node that field's focus state.

### Changed
- Startup: the native tree takes the startup document's nodes instead of deep-cloning them (~11 ms and ~23 MB less for a 2,000-row list), and the first layout and text shaping run while the prewarmed D3D11 device finishes. First paint of a 2,000-row list on D3D11 drops from ~384 ms to ~349 ms.

## 0.4.0 — 2026-10-01

### Added
- `bun run smoke:steady-frames`: scrolls a list on every renderer and fails if redrawing already-seen text rasterizes glyphs again. The debug snapshot reports `glyphRasterizations` on D3D11.
- `bun run bench:compare <exe…>` with `examples/bench.tsx`: compares compiled builds scene by scene (first frame, memory, idle/busy CPU, GPU memory).
- `examples/gradients.tsx`: linear, radial and conic gradients, repeating patterns, gradient text and gradient borders in every style.
- `conic-gradient(…)` and `repeating-conic-gradient(…)` (or `{ type: "conic", from, at, stops }`) for `background`, `borderColor` and `foreground`, in state styles too, on D3D11, Vello GPU and the CPU renderer. `from` and stop positions take `deg`, `turn`, `rad`, `grad` or `%`; `at` takes every position form radial gradients accept. Conic gradients with the same stop count transition stop by stop.

### Fixed
- D3D11: blank glyphs (spaces) are cached like every other glyph. Before, each visible space rebuilt a font scaler on every frame; scrolling a 2,000-row list spent ~13.7 ms per frame in text and now ~1.1 ms.
- Gradient `borderColor` now paints `dashed`, `dotted` and `double` borders with the gradient instead of its first colour: the style's strokes become one clip over a single gradient fill, on every renderer.
- CSS colour strings accept all 148 CSS named colours (`lime`, `rebeccapurple`, …), not only the 14 most common.
- `TextArea` Up/Down keep the column they started from when they pass a shorter line.
- `Backspace` at the start and `Delete` at the end of an `Input`/`TextArea` no longer emit a `change` event with the unchanged value.

### Changed
- JSON protocol version 48.
- The JS-side native shadow tree copies nodes shallowly and shares their styles instead of deep-cloning the whole document on every render. On a 6,000-node tree the copy drops from ~25 ms to ~3.5 ms (first frame and every update), and the second copy of every style object is gone.
- Renderer fallback (D3D11 → Vello/DX12 → CPU on Windows, Vello → CPU on Linux) is one ordered list shared by startup and device-loss recovery, documented in `PERFORMANCE.md`. Startup errors now name every failed attempt. Removes an unreachable Vulkan-first Vello path on Windows.
- Compiled executables reuse the extracted native runtime without reading or hashing it on every launch: `tarve build` embeds its SHA-256 and size, and a launch that finds the cached copy at that size uses it directly (the hash is checked when the copy is written). An empty window reaches its first frame in ~52 ms instead of ~80 ms.

## 0.3.0 — 2026-09-30

### Added
- Gradient backgrounds: `linear-gradient(…)`, `radial-gradient(…)` and their `repeating-` forms as CSS strings or `{ type, angle | to, shape, size, at, repeating, stops }` objects, in state styles too, on D3D11, Vello GPU and the CPU renderer. Stops take `%` or `px` with CSS fix-up of omitted positions; radial gradients take every size keyword, explicit radii and `at` centres in keywords, `%` or `px` (with edge offsets like `right 10px bottom 20%`). Gradients with matching shape and stop count transition stop by stop.
- `textShadow` blur (`{ blur }` or CSS `"1px 2px 4px #0006"`): glyphs are rasterized, blurred on the CPU and cached as one image per node, so the gaussian matches on every renderer. Blur transitions with the rest of the shadow.
- Gradient `borderColor` (fills the border ring; solid borders) and gradient `foreground` on `Text` (glyph coverage filled with the gradient, cached per node). Both transition like background gradients.

### Changed
- JSON protocol version 47.
- Pointer moves no longer walk the whole tree: transitions advance only on animating nodes, hit testing skips the stacking sort for containers whose children share a z-index, and portal and `transform` lookups are cached per tree update. On a 10,000-node tree a pointer move drops from ~2.6 ms to ~0.5 ms.
- Windows GPU startup: the D3D11 device (driver load, ~140 ms) is created on a background thread as soon as the app starts, overlapping window creation and the first layout. Apps on the CPU renderer skip it.
- The D3D11 shaders ship as precompiled DXBC (`native/src/shaders`), so startup no longer loads `d3dcompiler_47.dll` or compiles HLSL (~20 ms). A test fails if `ui.hlsl` changes without regenerating the bytecode.

### Fixed
- `bun --hot`: editing a file now reloads into the open window. A second `render()` in the same process remounts instead of failing with "Only one native app can be started per process", and under `--hot` `render()` resolves once the window is ready (Bun defers reloads while a top-level `await` is pending) and the process exits when the window closes.
- Windows: when the session is out of USER/atom memory (`SetPropW` fails with `0x80070008`), the window starts without UI Automation exposure and logs a warning instead of panicking the window thread in the AccessKit subclassing adapter.
- `InputOTP` focus: clicking now shows the active slot (slots had only a keyboard focus-visible ring), a click maps to the nearest slot instead of the hidden input's text position, and clicking a filled slot selects its character so typing replaces it instead of inserting before the code.
- Idle memory: the native runtime returns free `mimalloc` pages to the OS once rendering settles (at most every 500 ms). Since 0.2.0 an idle app stayed at its startup peak; a 2,000-row list now idles at ~225 MB instead of ~255 MB.

## 0.2.0 — 2026-09-29

### Breaking
- `hover` styles now also apply to ancestors of the hovered node and to non-interactive nodes, like CSS `:hover`. Containers with a `hover` style that never activated before will now react.
- Unsupported colour strings in colour properties throw when the view is compiled instead of painting black.
- State styles with a matching `transition` now animate instead of switching instantly, and emit `motionComplete`.
- JSON protocol version 46: `@tarve/core` 0.2.0 requires its bundled native runtime (as always, runtimes are not mixed across versions).

### Added
- `transform`: translate/scale about the box centre (object or CSS `translate*()`/`scale*()` syntax), applied to the whole subtree on every renderer, followed by hit testing and hover, and animatable with `transition` (e.g. a hover lift).
- CSS colours in every colour property: `rgb()`/`rgba()`, `hsl()`/`hsla()`, short hex and common names. Unsupported colour strings now throw instead of silently rendering black.
- CSS syntax for shadows: `boxShadow: "0 8px 24px -4px rgba(0,0,0,.2), inset 0 1px 0 #fff"` and `textShadow: "1px 2px #0006"`, including `rgb()`/`hsl()` colours and theme tokens. Shadow objects also accept those colour formats.
- `hover` styles apply to every node under the pointer and its ancestors (CSS `:hover`), not only interactive nodes.
- Native transitions for `background`, `foreground`, `borderColor`, `boxShadow` and `textShadow`, and state-driven transitions: hover/active/focus/disabled changes animate `opacity`, `radius`, colours and shadows from the value on screen. No frames are scheduled once a transition ends.
- `boxShadow`: `{ x, y, blur, spread, color, inset }` or a list of up to 8, in base and state styles. Analytic gaussian blur on D3D11, Vello GPU and the CPU renderer; outer shadows are clipped out of their own box; `inset` paints inside the padding box.
- `borderStyle` (`dashed`, `dotted`, `double`, `groove`, `ridge`, `inset`, `outset`, `none`) on any node with a uniform border width.
- `textShadow: { x, y, color }` on text, button labels, `Input` and `TextArea`, including state styles such as `hover` (solid offset; no blur). Protocol version is now 46.
- Linux accessibility: the AccessKit bridge now runs on Linux through AT-SPI, so screen readers such as Orca can read and drive Tarve apps.
- Word-wise editing in `Input`/`TextArea`: `Ctrl+←/→` (Option on macOS) moves by word, with `Shift` to select; `Ctrl+Backspace`/`Ctrl+Delete` delete a word.

### Changed
- Faster native runtime: `mimalloc` allocator and `FxHash` maps cut native tree update time by ~40% on a 6,000-node tree.
- Syntax highlight cache uses an O(1) LRU.
- Text highlight search no longer depends on the `regex` crate.

## 0.1.2 — 2026-09-28

### Added
- `@tarve/react-icons` is published alongside `@tarve/core`.

### Changed
- The published `package.json` contains only consumer-facing fields.

## 0.1.1 — 2026-09-28

### Changed
- Package renamed from `tarve` to `@tarve/core`. The CLI command is still `tarve`.

## 0.1.0 — 2026-09-28

Initial release: native Windows x64 and Linux x64 runtime with JSX components, Taffy layout, Parley text, Vello and D3D11 rendering, rich markdown/code/diff, native text editing with undo/redo, motion transitions, Windows accessibility, file dialogs, global hotkeys and standalone executable builds.
