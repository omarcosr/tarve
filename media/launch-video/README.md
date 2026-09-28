# Tarve launch film

A 15-second, 1920×1080 / 60 fps motion-graphics reveal for Tarve.

- `tarve-launch.mp4`: the rendered film (H.264, yuv420p, 4× sub-frame motion blur)
- `poster.png`: the final hero frame
- `index.html` + `scene.js`: the film's source. Every frame is a pure function of time, drawn with Canvas 2D.
- `render.mjs`: frame-accurate offline capture (Playwright → PNG → ffmpeg)

## Sequence

| Time | Beat |
| --- | --- |
| 0.0–2.0 s | A cursor in the dark. `bun add @tarve/core` is typed, runs, and compresses into a point of light. |
| 2.0–6.1 s | The point detonates and a native UI system assembles itself from wireframe primitives: a data grid with search, a dropdown that opens a **Build executable** dialog, a resizable inspector, syntax-highlighted code, Markdown, and a word-level diff. The camera racks focus through depth. |
| 6.1–7.9 s | A zoom into `"tarve"` match-cuts into kinetic type: **TypeScript · Bun · Rust · Taffy · Vello · Parley**, each over a visual of what it does (flex layout boxes for Taffy, Bézier handles for Vello, glyph metrics and selection for Parley). |
| 7.9–8.4 s | Architecture stack: TSX → FFI → native core → layout, text and rendering. |
| 8.3–11.8 s | Performance: a tunnel of about 10,000 UI tiles at speed with a 120 fps profiler HUD. A 100,000-row `VirtualList` scrolls to row 84,216, then the window is resized natively while its card grid reflows live. |
| 11.8–12.8 s | The interface drops to wireframe and collapses as 2,600 particles into the wordmark. |
| 12.8–15.0 s | **TARVE** / *Native UI. TypeScript velocity.* / `bun add @tarve/core` |

## Preview live

Serve this folder and open `index.html`. Any static server works:

```sh
bunx serve media/launch-video
```

Space plays or pauses, ←/→ steps one frame (hold Shift to step one second), and you can click the bar to seek.
Query parameters: `?t=9.8` opens paused on a frame, and `?samples=4` turns on motion blur in the preview.

## Render

```sh
cd media/launch-video
node render.mjs                           # full film -> tarve-launch.mp4
node render.mjs --samples 1 --out draft.mp4   # fast draft, no motion blur
node render.mjs --stills 2.4,6.3,13.9     # PNG frames into ./stills
node render.mjs --from 8 --to 12 --out perf.mp4
```

The script needs Playwright's Chromium and an `ffmpeg` that includes `libx264`. Set `FFMPEG=/path/to/ffmpeg` if `ffmpeg` is not on your `PATH`.

Fonts are Geist and Geist Mono (SIL Open Font License, see `fonts/OFL.txt`). They are bundled so the film renders the same on every machine.
