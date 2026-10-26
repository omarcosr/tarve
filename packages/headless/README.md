# @tarve/headless

Render Tarve apps to pixels with no window, no GPU and no native library. It runs the
WebAssembly build of Tarve's native tree — the same Taffy layout, Parley text, input handling
and Vello CPU painter a window uses — inside Bun, Node.js (26.10+) or txiki.js, so UI tests and
visual snapshots run on any CI machine (Linux, macOS, Windows, x64 or ARM). See [Runtimes](#runtimes).

Text always renders with the bundled Inter and JetBrains Mono, never with system fonts, and the
clock only moves when you advance it. The same view gives the same bytes on every machine.

```sh
bun add -d @tarve/headless
```

## Render to an image

```tsx
import { writeFileSync } from "node:fs";
import { Button } from "@tarve/core";
import { renderToPng } from "@tarve/headless";

writeFileSync("button.png", await renderToPng(<Button>Save</Button>, { width: 200, height: 80, scale: 2 }));
```

A view that is not a `Window` is wrapped in one (`width`/`height` default to 640×480, `theme`
sets its theme). `renderToRgba` returns the raw pixels instead.

## Test like a user

`createHeadlessTestRenderer` is `createTestRenderer` from `@tarve/core` on the WebAssembly
runtime: locators, clicks, typing, scrolling, `inspect` and `capture` work unchanged.

```tsx
import { expect, test } from "bun:test";
import { createHeadlessTestRenderer } from "@tarve/headless";

test("saves", async () => {
  const renderer = await createHeadlessTestRenderer(App);
  await renderer.getByRole("button", { name: "Save" }).click();
  await renderer.getByText("Saved").waitFor();
  renderer.close();
});
```

`createHeadlessApp(view, options)` returns the `AppHandle` itself, plus `pixels()`, `png()` and
`settle()` (wait until layout feedback and re-renders stop).

`app.bridge.scene()` is the compiled scene tree as the app last sent it (ids, kinds, text, values,
`control` roles and labels; `sceneVersion` bumps on each change), and `app.bridge.emit(event)`
delivers a native event to the app as the native tree would. [`@tarve/test`](../test) builds
Testing Library-style queries on them.

## Visual snapshots

```tsx
import { matchImageSnapshot, renderToRgba } from "@tarve/headless";

await matchImageSnapshot(await renderToRgba(App, { scale: 2 }), "__snapshots__/app.png");
```

A missing snapshot is written (on CI, where `CI` is set, it fails instead). A mismatch writes
`app.actual.png` next to the stored image and throws. `TARVE_UPDATE_SNAPSHOTS=1` rewrites them.
Captures are deterministic, so the default tolerance is zero; `threshold` and
`maxDifferenceRatio` loosen it.

## Time

The default `clock: "manual"` freezes time: transitions, `spin` and the caret only move with
`app.advanceMotion(ms)`, so a capture taken mid-animation is reproducible. `clock: "realtime"`
follows `performance.now()` like a window.

## Options

| Option | Default | |
|---|---|---|
| `width`, `height` | the Window's size | Logical size of the render target |
| `scale` | `1` | Device pixel ratio of the pixels |
| `clock` | `"manual"` | `"manual"` or `"realtime"` |
| `assetRoot` | `process.cwd()` | Where relative `Image` paths are read from |
| `fonts` | — | Extra fonts (`{ data, families }`), e.g. CJK or emoji |

## Limits

- No window: title bar buttons, file dialogs, the clipboard and accessibility are desktop-only.
- Images load from files and `data:` URIs; remote URLs are not fetched. Relative paths resolve from
  the main script, as in a window; web-style `/assets/a.png` paths resolve from `assetRoot`.
- Only the bundled fonts exist unless you register more: Arabic, CJK and emoji text needs a font.

## Runtimes

The package uses only `node:fs`, `node:path`, `node:zlib` (to read PNG snapshots), `fetch` and
WebAssembly; PNG encoding deflates in the WebAssembly runtime itself. Its files
(the WebAssembly runtime, the fonts) are `import … with { type: "file" }` imports, which Tarve
resolves on every runtime.

| Runtime | How | Status |
|---|---|---|
| Bun 1.4+ | `bun app.tsx`, `bun test` | Everything |
| Node.js 26.10+ | `tarve run --runtime node app.tsx` (bundles the TSX and its files) | Everything |
| txiki.js 26.6 | `tarve build --runtime txiki app.tsx`, then run the executable | Everything |

The WebAssembly runtime comes in two builds, chosen by feature detection: `simd` (wasm simd128,
about twice as fast to paint) and `baseline`, for engines without WebAssembly SIMD such as
txiki.js's WAMR. They render the same pixels; `(await loadHeadlessRuntime()).build` says which runs.

`encodePng` deflates with the WebAssembly runtime, so it needs `await loadHeadlessRuntime()` first
(`renderToPng`, `png()`, `capture` and `matchImageSnapshot` load it). txiki.js has no synchronous
`node:zlib` of its own; a Tarve txiki.js executable gets one from its native library, which reads
the stored PNG snapshots.

`bun run smoke:headless-runtimes` runs the same scenarios on all three runtimes.

## Building from the repository

The WebAssembly runtime is built, not committed:

```sh
rustup target add wasm32-unknown-unknown
cargo install wasm-bindgen-cli --version 0.2.129
bun run build:wasm     # wasm/ (simd) and wasm/baseline/
bun run test:headless
```
