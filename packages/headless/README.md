# @tarve/headless

Render Tarve apps to pixels with no window, no GPU and no native library. It runs the
WebAssembly build of Tarve's native tree — the same Taffy layout, Parley text, input handling
and Vello CPU painter a window uses — inside Bun, so UI tests and visual snapshots run on any
CI machine (Linux, macOS, Windows, x64 or ARM).

Text always renders with the bundled Inter and JetBrains Mono, never with system fonts, and the
clock only moves when you advance it. The same view gives the same bytes on every machine.

```sh
bun add -d @tarve/headless
```

## Render to an image

```tsx
import { Button } from "@tarve/core";
import { renderToPng } from "@tarve/headless";

await Bun.write("button.png", await renderToPng(<Button>Save</Button>, { width: 200, height: 80, scale: 2 }));
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
- Images load from files and `data:` URIs; remote URLs are not fetched.
- Only the bundled fonts exist unless you register more: Arabic, CJK and emoji text needs a font.

## Building from the repository

The WebAssembly runtime is built, not committed:

```sh
rustup target add wasm32-unknown-unknown
cargo install wasm-bindgen-cli --version 0.2.129
bun run build:wasm
bun run test:headless
```
