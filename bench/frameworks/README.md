# Cross-framework GUI benchmark

The same screen built in Tarve and in 5 other GUI frameworks (Electron, Tauri, Flutter, Dioxus Native, egui), all measured from outside the process in exactly the same way.

- **Date:** 2026-11-22 · median of 5 runs per app and scene · **lower is better for every metric**
- **Machine:** Intel Core Ultra 7 255HX, RTX 5070 Laptop, 31 GB, Windows 11 Insider 26340, 125% scaling, 240 Hz
- **Versions:** Tarve 0.13.6 at `f1d055f` (Bun 1.4.4, Node 26.10, txiki), Electron 45.4.1 + React 19.3, Tauri 2.12 (WebView2 157) + React 19.3, Flutter 3.50.1, Dioxus Native 0.7.10, egui/eframe 0.33
- **Tarve variants:** Bun, Node or txiki as the JavaScript runtime; GPU rendering by default (`auto`, D3D11) or the `lowPower` option (CPU rendering).

## Summary

| # | Metric | 1st place | Best Tarve | Tarve rank |
| ---: | --- | --- | --- | :---: |
| 1 | [Disk size](#1-disk-size) | egui · 3.5 MB | Tarve · txiki · 11.5 MB | 3rd of 11 |
| 2 | [First frame, empty screen](#2-first-frame-empty-screen) | Tarve · txiki `lowPower` · 120 ms | Tarve · txiki `lowPower` · 120 ms | 1st of 11 |
| 3 | [First frame, 2,000 rows](#3-first-frame-2000-rows) | Tarve · Bun `lowPower` · 200 ms | Tarve · Bun `lowPower` · 200 ms | 1st of 11 |
| 4 | [Idle RAM, empty screen](#4-idle-ram-empty-screen) | Tarve · txiki `lowPower` · 18.1 MB | Tarve · txiki `lowPower` · 18.1 MB | 1st of 11 |
| 5 | [Idle RAM, 2,000 rows](#5-idle-ram-2000-rows) | Tarve · txiki `lowPower` · 62.1 MB | Tarve · txiki `lowPower` · 62.1 MB | 1st of 11 |
| 6 | [GPU memory](#6-gpu-memory) | Tarve · Bun `lowPower` · 0 MB | Tarve · Bun `lowPower` · 0 MB | 1st of 11 |
| 7 | [CPU while scrolling](#7-cpu-while-scrolling) | Tarve · Node · 24.3 % of one core | Tarve · Node · 24.3 % of one core | 1st of 11 |
| 8 | [Update time](#8-update-time) | Tarve · Bun · 20.6 ms (median) | Tarve · Bun · 20.6 ms (median) | 1st of 11 |

**At a glance:** Tarve is 1st in metrics 2, 3, 4, 5, 6, 7, 8 and behind in 1 (each with its best variant; see [PERFORMANCE.md](../../PERFORMANCE.md) for what changed between runs).

## Size and startup

### 1. Disk size

What has to ship (the executable and the files next to it). "Zipped" is the download size as a .zip. Tauri relies on the WebView2 runtime already installed on Windows, which is not counted.

| # | App | MB | vs 1st | Zipped MB |
| ---: | --- | ---: | ---: | ---: |
| 1 | egui | 3.5 | — | 1.8 |
| 2 | Tauri | 4.1 | 1.2× | 1.6 |
| 3 | **Tarve · txiki** | 11.5 | 3.3× | 8.6 |
| 4 | **Tarve · txiki `lowPower`** | 11.5 | 3.3× | 8.6 |
| 5 | Dioxus Native | 14.9 | 4.3× | 6.4 |
| 6 | Flutter | 24.8 | 7.1× | 10.4 |
| 7 | **Tarve · Node** | 114.9 | 32.8× | 43.4 |
| 8 | **Tarve · Node `lowPower`** | 114.9 | 32.8× | 43.4 |
| 9 | **Tarve · Bun** | 150.8 | 43.1× | 75.9 |
| 10 | **Tarve · Bun `lowPower`** | 150.8 | 43.1× | 75.9 |
| 11 | Electron | 357.1 | 102.0× | 150.9 |

### 2. First frame, empty screen

From `CreateProcess` until the content shows on screen.

| # | App | ms | vs 1st | Window created (ms) |
| ---: | --- | ---: | ---: | ---: |
| 1 | **Tarve · txiki `lowPower`** | 120 | — | 47 |
| 2 | **Tarve · Bun `lowPower`** | 122 | 1.0× | 48 |
| 3 | **Tarve · txiki** | 126 | 1.1× | 50 |
| 4 | **Tarve · Bun** | 131 | 1.1× | 50 |
| 5 | egui | 267 | 2.2× | 165 |
| 6 | Electron | 369 | 3.1× | 118 |
| 7 | Tauri | 420 | 3.5× | 30 |
| 8 | **Tarve · Node `lowPower`** | 458 | 3.8× | 385 |
| 9 | **Tarve · Node** | 460 | 3.8× | 384 |
| 10 | Flutter | 590 | 4.9× | 510 |
| 11 | Dioxus Native | 907 | 7.6× | 245 |

### 3. First frame, 2,000 rows

The same, with the whole list built.

| # | App | ms | vs 1st | Window created (ms) |
| ---: | --- | ---: | ---: | ---: |
| 1 | **Tarve · Bun `lowPower`** | 200 | — | 121 |
| 2 | **Tarve · Bun** | 221 | 1.1× | 139 |
| 3 | egui | 301 | 1.5× | 186 |
| 4 | Electron | 362 | 1.8× | 112 |
| 5 | **Tarve · txiki `lowPower`** | 383 | 1.9× | 294 |
| 6 | **Tarve · txiki** | 415 | 2.1× | 334 |
| 7 | Tauri | 431 | 2.2× | 30 |
| 8 | **Tarve · Node `lowPower`** | 494 | 2.5× | 411 |
| 9 | **Tarve · Node** | 512 | 2.6× | 434 |
| 10 | Flutter | 760 | 3.8× | 673 |
| 11 | Dioxus Native | 934 | 4.7× | 240 |

## Memory

### 4. Idle RAM, empty screen

Private working set: physical RAM used only by the app, summed over all its processes. "Committed" is the reserved memory (private bytes).

| # | App | MB | vs 1st | Committed (MB) |
| ---: | --- | ---: | ---: | ---: |
| 1 | **Tarve · txiki `lowPower`** | 18.1 | — | 68.3 |
| 2 | **Tarve · txiki** | 23.6 | 1.3× | 127.9 |
| 3 | **Tarve · Bun `lowPower`** | 24.8 | 1.4× | 124.7 |
| 4 | **Tarve · Bun** | 32.1 | 1.8× | 314.7 |
| 5 | egui | 33.6 | 1.9× | 69.8 |
| 6 | Flutter | 50.9 | 2.8× | 164 |
| 7 | **Tarve · Node `lowPower`** | 59.7 | 3.3× | 73.2 |
| 8 | **Tarve · Node** | 65.4 | 3.6× | 132.5 |
| 9 | Electron | 70.4 | 3.9× | 145.5 |
| 10 | Tauri | 74.9 | 4.1× | 154.2 |
| 11 | Dioxus Native | 134.8 | 7.4× | 464.5 |

### 5. Idle RAM, 2,000 rows

The same, with the list built.

| # | App | MB | vs 1st | Committed (MB) |
| ---: | --- | ---: | ---: | ---: |
| 1 | **Tarve · txiki `lowPower`** | 62.1 | — | 122.2 |
| 2 | egui | 65.9 | 1.1× | 100.7 |
| 3 | **Tarve · Bun `lowPower`** | 69.5 | 1.1× | 189.5 |
| 4 | **Tarve · txiki** | 69.9 | 1.1× | 185.1 |
| 5 | **Tarve · Node `lowPower`** | 75.9 | 1.2× | 90.1 |
| 6 | **Tarve · Bun** | 80.6 | 1.3× | 390.1 |
| 7 | **Tarve · Node** | 85.9 | 1.4× | 153.9 |
| 8 | Electron | 107.2 | 1.7× | 187.8 |
| 9 | Tauri | 114.4 | 1.8× | 198.2 |
| 10 | Dioxus Native | 166.5 | 2.7× | 504.7 |
| 11 | Flutter | 246.6 | 4.0× | 360 |

### 6. GPU memory

Dedicated video memory from the Windows `GPU Process Memory` counter. The `lowPower` variants draw on the CPU and use no GPU.

| # | App | MB | vs 1st | With 2,000 rows (MB) |
| ---: | --- | ---: | ---: | ---: |
| 1 | **Tarve · Bun `lowPower`** | 0 | — | 0 |
| 2 | **Tarve · Node `lowPower`** | 0 | — | 0 |
| 3 | **Tarve · txiki `lowPower`** | 0 | — | 0 |
| 4 | Tauri | 20.5 | +20.5 | 29.3 |
| 5 | egui | 22.8 | +22.8 | 22.8 |
| 6 | Electron | 26.6 | +26.6 | 30.6 |
| 7 | **Tarve · Bun** | 28.4 | +28.4 | 28.4 |
| 8 | **Tarve · Node** | 28.4 | +28.4 | 28.4 |
| 9 | **Tarve · txiki** | 28.4 | +28.4 | 33.4 |
| 10 | Flutter | 68.8 | +68.8 | 68.8 |
| 11 | Dioxus Native | 269.2 | +269.2 | 269.2 |

## Interaction

### 7. CPU while scrolling

240 real mouse-wheel steps (SendInput), about 60 per second, over the list.

| # | App | % of one core | vs 1st | GPU 3D use % |
| ---: | --- | ---: | ---: | ---: |
| 1 | **Tarve · Node** | 24.3 | — | 9.6 |
| 2 | **Tarve · Bun** | 25.1 | 1.0× | 10.1 |
| 3 | **Tarve · txiki** | 25.5 | 1.0× | 8.8 |
| 4 | Tauri | 31.8 | 1.3× | 12.3 |
| 5 | Electron | 41.6 | 1.7× | 11.5 |
| 6 | Dioxus Native | 97.1 | 4.0× | 4.3 |
| 7 | Flutter | 99.1 | 4.1× | 3.3 |
| 8 | egui | 102.9 | 4.2× | 5.2 |
| 9 | **Tarve · txiki `lowPower`** | 115.8 | 4.8× | 0 |
| 10 | **Tarve · Node `lowPower`** | 116.2 | 4.8× | 0 |
| 11 | **Tarve · Bun `lowPower`** | 120.1 | 4.9× | 0 |

### 8. Update time

Real clicks on the "Update" button, each one changing the text of all 2,000 rows. Measured from the click until the new colour shows on screen.

| # | App | ms (median) | vs 1st | 95th percentile (ms) |
| ---: | --- | ---: | ---: | ---: |
| 1 | **Tarve · Bun** | 20.6 | — | 24.9 |
| 2 | **Tarve · Node** | 20.8 | 1.0× | 28.9 |
| 3 | Tauri | 28.5 | 1.4× | 36.6 |
| 4 | Electron | 28.6 | 1.4× | 36.2 |
| 5 | egui | 36.6 | 1.8× | 42.5 |
| 6 | **Tarve · Bun `lowPower`** | 37.1 | 1.8× | 46.3 |
| 7 | **Tarve · Node `lowPower`** | 37.2 | 1.8× | 45.6 |
| 8 | Dioxus Native | 51.5 | 2.5× | 58 |
| 9 | **Tarve · txiki** | 124.4 | 6.0× | 133.1 |
| 10 | **Tarve · txiki `lowPower`** | 141.4 | 6.9× | 166.3 |
| 11 | Flutter | 158.5 | 7.7× | 175.5 |

## Where Tarve spends the 2,000-row update

Measured inside the app with `app.stats()` (`STATS=1`), median / 95th percentile over its frames. Layout runs only for the rows that show; the rest lays out after the frame is presented, in a frame of its own.

| Phase | Bun | txiki |
| --- | ---: | ---: |
| JS update (render + diff + send) | 7.2 / 14.2 ms | 114.2 / 134.0 ms |
| ↳ JS render | 5.9 / 11.2 ms | 76.3 / 92.9 ms |
| ↳ JS diff | 0.9 / 2.4 ms | 13.7 / 19.4 ms |
| Native apply | 0.7 / 1.4 ms | 0.7 / 1.3 ms |
| Native layout (taffy + text) | 0.0 / 3.5 ms | 0.0 / 2.7 ms |
| Native paint | 1.5 / 3.6 ms | 1.4 / 2.9 ms |
| Native frame (CPU) | 3.3 / 8.4 ms | 2.3 / 4.4 ms |

## Method

The meter lives in `harness/`; it is the same for every app and runs on Windows only.

- **Screen:** a 48×48 marker at the top-left corner, an "Update" button and, in the list scene, 2,000 rows (text and button) in a scroll area. Each click on "Update" changes the text of **every** row and the marker's colour.
- **First frame:** the magenta marker is read from the composited screen with BitBlt.
- **Memory and CPU:** summed over the whole process tree, since Electron and WebView2 spawn child processes. The app idles for 3 s after the first frame, then idle CPU is measured for 5 s.
- **Input:** real mouse input through SendInput, after checking that the window is on top before each click.
- **Order:** runs are interleaved round by round, so slow drifts on the machine hit every app alike.

To reproduce:

```
bun bench/frameworks/build.ts          # FLUTTER=<flutter.bat> if it is not on PATH
RUNS=5 bun bench/frameworks/run.ts     # → work/frameworks/results.json, results.jsonl, shots/
bun bench/frameworks/report.ts         # → this README and results/
```

## Limitations

- A single machine, warm starts only (files already in the OS cache). Other work used part of the CPU, recorded in the "Machine busy %" column.
- No app virtualizes the list: Electron and Tauri use React 19 without virtualization and Flutter uses a `Column`; the idiomatic `ListView.builder` would build only the visible rows. egui is immediate mode and redraws the whole window on every input.
- Update times include vsync and Windows composition (DWM), about 4 ms at 240 Hz. On the empty screen every app takes 4–12 ms.
- An accessibility client was active on this machine (Windows asked every app for its accessibility tree), as on many desktops.
- Dioxus Native 0.7.10 still describes itself as experimental.

## Full data

Every collected metric, median of 5 runs. Individual runs are in `results/results.jsonl`, medians in `results/results.json` and first-run screenshots in `results/shots/`. "Missed clicks" counts clicks whose change did not reach the screen within 3 s.

### Empty screen

| App | Disk MB | Zipped MB | Window ms | First frame ms | Committed MB | Private WS MB | Working set MB | Threads | Handles | Processes | Idle CPU % | Dedicated GPU MB | Shared GPU MB | Scroll CPU % | Scroll GPU 3D % | Update median ms | Update p95 ms | Update max ms | Missed clicks | Peak committed MB | Peak working set MB | Final committed MB | Final private WS MB | Machine busy % | Runs |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| Tarve · Bun | 150.8 | 75.9 | 50 | 131 | 314.7 | 32.1 | 81.6 | 88 | 628 | 1 | 0 | 28.4 | 2.3 | — | — | 7.9 | 13.5 | 19.4 | 0 | 334.2 | 88.3 | 334.2 | 36.3 | 13.6 | 5 |
| Tarve · Bun `lowPower` | 150.8 | 75.9 | 48 | 122 | 124.7 | 24.8 | 54.4 | 22 | 267 | 1 | 0 | 0 | 0 | — | — | 7.8 | 12.9 | 16.8 | 0 | 140.9 | 60.2 | 140.9 | 28.1 | 8.6 | 5 |
| Tarve · Node | 114.9 | 43.4 | 384 | 460 | 132.5 | 65.4 | 137 | 82 | 622 | 1 | 0 | 28.4 | 2.3 | — | — | 7.9 | 13.4 | 19.6 | 0 | 139.3 | 143.8 | 106.7 | 40.1 | 9.4 | 5 |
| Tarve · Node `lowPower` | 114.9 | 43.4 | 385 | 458 | 73.2 | 59.7 | 111.5 | 16 | 279 | 1 | 0 | 0 | 0 | — | — | 7.8 | 12.8 | 20.1 | 0 | 75.3 | 114.6 | 46.5 | 33.2 | 10.3 | 5 |
| Tarve · txiki | 11.5 | 8.6 | 50 | 126 | 127.9 | 23.6 | 64 | 82 | 623 | 1 | 0 | 28.4 | 2.3 | — | — | 7.8 | 16.1 | 19.5 | 0 | 134.7 | 70.6 | 129.1 | 25.6 | 8.6 | 5 |
| Tarve · txiki `lowPower` | 11.5 | 8.6 | 47 | 120 | 68.3 | 18.1 | 38.5 | 16 | 278 | 1 | 0 | 0 | 0 | — | — | 7.8 | 12.9 | 19.4 | 0 | 68.9 | 40.4 | 68.9 | 18.9 | 8.5 | 5 |
| Electron | 357.1 | 150.9 | 118 | 369 | 145.5 | 70.4 | 294.9 | 163 | 2300 | 4 | 0.6 | 26.6 | 1.9 | — | — | 7.9 | 12.3 | 15.9 | 0 | 149.6 | 299 | 148.8 | 72.5 | 8.7 | 5 |
| Tauri | 4.1 | 1.6 | 30 | 420 | 154.2 | 74.9 | 332.9 | 231 | 3453 | 7 | 0.6 | 20.5 | 1.8 | — | — | 7.8 | 12.6 | 16 | 0 | 160.3 | 340.1 | 157.4 | 76.8 | 9 | 5 |
| Flutter | 24.8 | 10.4 | 510 | 590 | 164 | 50.9 | 99 | 105 | 723 | 1 | 0 | 68.8 | 8 | — | — | 4.4 | 9 | 14.7 | 0 | 173.8 | 107.3 | 171.9 | 58.7 | 5.7 | 5 |
| Dioxus Native | 14.9 | 6.4 | 245 | 907 | 464.5 | 134.8 | 199.6 | 54 | 684 | 1 | 0 | 269.2 | 52.6 | — | — | 8 | 12.6 | 14.4 | 0 | 474 | 203.5 | 465.4 | 138.4 | 12.5 | 5 |
| egui | 3.5 | 1.8 | 165 | 267 | 69.8 | 33.6 | 65.2 | 16 | 390 | 1 | 0 | 22.8 | 5.7 | — | — | 5.3 | 9.8 | 10.7 | 0 | 74.8 | 70.8 | 74.8 | 39.1 | 7.6 | 5 |

### 2,000 rows

| App | Disk MB | Zipped MB | Window ms | First frame ms | Committed MB | Private WS MB | Working set MB | Threads | Handles | Processes | Idle CPU % | Dedicated GPU MB | Shared GPU MB | Scroll CPU % | Scroll GPU 3D % | Update median ms | Update p95 ms | Update max ms | Missed clicks | Peak committed MB | Peak working set MB | Final committed MB | Final private WS MB | Machine busy % | Runs |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| Tarve · Bun | 150.8 | 75.9 | 139 | 221 | 390.1 | 80.6 | 136.2 | 88 | 625 | 1 | 0 | 28.4 | 3 | 25.1 | 10.1 | 20.6 | 24.9 | 33.9 | 0 | 485.1 | 200.9 | 445.9 | 123.1 | 9.3 | 5 |
| Tarve · Bun `lowPower` | 150.8 | 75.9 | 121 | 200 | 189.5 | 69.5 | 105.1 | 22 | 274 | 1 | 0 | 0 | 0 | 120.1 | 0 | 37.1 | 46.3 | 53.8 | 0 | 294.4 | 170.9 | 269 | 130.2 | 8.9 | 5 |
| Tarve · Node | 114.9 | 43.4 | 434 | 512 | 153.9 | 85.9 | 162.3 | 82 | 633 | 1 | 0 | 28.4 | 3 | 24.3 | 9.6 | 20.8 | 28.9 | 37.5 | 0 | 254.4 | 258.3 | 231.1 | 161.3 | 11.6 | 5 |
| Tarve · Node `lowPower` | 114.9 | 43.4 | 411 | 494 | 90.1 | 75.9 | 132.4 | 16 | 286 | 1 | 0 | 0 | 0 | 116.2 | 0 | 37.2 | 45.6 | 53.9 | 0 | 187.3 | 226.5 | 179.1 | 159.2 | 8.8 | 5 |
| Tarve · txiki | 11.5 | 8.6 | 334 | 415 | 185.1 | 69.9 | 110.3 | 81 | 642 | 1 | 0 | 33.4 | 3.4 | 25.5 | 8.8 | 124.4 | 133.1 | 141 | 0 | 210.1 | 138.4 | 203.3 | 91.8 | 8.4 | 5 |
| Tarve · txiki `lowPower` | 11.5 | 8.6 | 294 | 383 | 122.2 | 62.1 | 83.4 | 16 | 285 | 1 | 0 | 0 | 0 | 115.8 | 0 | 141.4 | 166.3 | 183.1 | 0 | 149.4 | 114.4 | 135.9 | 81.5 | 9.9 | 5 |
| Electron | 357.1 | 150.9 | 112 | 362 | 187.8 | 107.2 | 332 | 164 | 2301 | 4 | 0.3 | 30.6 | 2.2 | 41.6 | 11.5 | 28.6 | 36.2 | 40.8 | 0 | 256.6 | 401.6 | 255.7 | 170.7 | 9.6 | 5 |
| Tauri | 4.1 | 1.6 | 30 | 431 | 198.2 | 114.4 | 378.3 | 232 | 3458 | 7 | 0.6 | 29.3 | 2.3 | 31.8 | 12.3 | 28.5 | 36.6 | 37.3 | 0 | 267.1 | 450.1 | 263.1 | 174.3 | 8.9 | 5 |
| Flutter | 24.8 | 10.4 | 673 | 760 | 360 | 246.6 | 294.8 | 106 | 729 | 1 | 0.3 | 68.8 | 8 | 99.1 | 3.3 | 158.5 | 175.5 | 203.1 | 0 | 437.4 | 367.3 | 409.9 | 292.6 | 5.2 | 5 |
| Dioxus Native | 14.9 | 6.4 | 240 | 934 | 504.7 | 166.5 | 231.4 | 54 | 684 | 1 | 0 | 269.2 | 52.6 | 97.1 | 4.3 | 51.5 | 58 | 58.4 | 0 | 513.6 | 238.1 | 507.2 | 172.6 | 8.2 | 5 |
| egui | 3.5 | 1.8 | 186 | 301 | 100.7 | 65.9 | 97.5 | 16 | 390 | 1 | 0 | 22.8 | 6.7 | 102.9 | 5.2 | 36.6 | 42.5 | 49.6 | 0 | 144.3 | 137.2 | 143.4 | 103.8 | 4.7 | 5 |
