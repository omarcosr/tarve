# Changelog

All notable changes to `@tarve/core` and `@tarve/react-icons` are documented here. Versions follow [Semantic Versioning](https://semver.org/); before 1.0, minor versions may contain breaking changes.

## Unreleased

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
