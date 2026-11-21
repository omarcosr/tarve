# Cross-framework GUI benchmark

The same screen built in Tarve and in 5 other GUI frameworks (Electron, Tauri, Flutter, Dioxus Native, egui), all measured from outside the process in exactly the same way.

- **Date:** 2026-11-21 · median of 5 runs per app and scene · **lower is better for every metric**
- **Machine:** Intel Core Ultra 7 255HX, RTX 5070 Laptop, 31 GB, Windows 11 Insider 26340, 125% scaling, 240 Hz
- **Versions:** Tarve 0.13.6 at `a1601e6` (Bun 1.4.4, Node 26.10, txiki), Electron 45.4.1 + React 19.3, Tauri 2.12 (WebView2 157) + React 19.3, Flutter 3.50.1, Dioxus Native 0.7.10, egui/eframe 0.33
- **Tarve variants:** Bun, Node or txiki as the JavaScript runtime; GPU rendering by default (`auto`, D3D11) or the `lowPower` option (CPU rendering).

## Summary

| # | Metric | 1st place | Best Tarve | Tarve rank |
| ---: | --- | --- | --- | :---: |
| 1 | [Disk size](#1-disk-size) | egui · 3.5 MB | Tarve · txiki · 11.5 MB | 3rd of 11 |
| 2 | [First frame, empty screen](#2-first-frame-empty-screen) | Tarve · txiki `lowPower` · 123 ms | Tarve · txiki `lowPower` · 123 ms | 1st of 11 |
| 3 | [First frame, 2,000 rows](#3-first-frame-2000-rows) | Tarve · Bun `lowPower` · 219 ms | Tarve · Bun `lowPower` · 219 ms | 1st of 11 |
| 4 | [Idle RAM, empty screen](#4-idle-ram-empty-screen) | Tarve · txiki `lowPower` · 18.1 MB | Tarve · txiki `lowPower` · 18.1 MB | 1st of 11 |
| 5 | [Idle RAM, 2,000 rows](#5-idle-ram-2000-rows) | egui · 65.9 MB | Tarve · txiki `lowPower` · 87.3 MB | 2nd of 11 |
| 6 | [GPU memory](#6-gpu-memory) | Tarve · Bun `lowPower` · 0 MB | Tarve · Bun `lowPower` · 0 MB | 1st of 11 |
| 7 | [CPU while scrolling](#7-cpu-while-scrolling) | Tarve · Node · 23.5 % of one core | Tarve · Node · 23.5 % of one core | 1st of 11 |
| 8 | [Update time](#8-update-time) | Tarve · Node · 25.4 ms (median) | Tarve · Node · 25.4 ms (median) | 1st of 11 |

**At a glance:** Tarve is 1st in metrics 2, 3, 4, 6, 7, 8 and behind in 1, 5 (each with its best variant; see [PERFORMANCE.md](../../PERFORMANCE.md) for what changed between runs).

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
| 9 | **Tarve · Bun** | 150.7 | 43.1× | 75.9 |
| 10 | **Tarve · Bun `lowPower`** | 150.7 | 43.1× | 75.9 |
| 11 | Electron | 357.1 | 102.0× | 150.9 |

### 2. First frame, empty screen

From `CreateProcess` until the content shows on screen.

| # | App | ms | vs 1st | Window created (ms) |
| ---: | --- | ---: | ---: | ---: |
| 1 | **Tarve · txiki `lowPower`** | 123 | — | 45 |
| 2 | **Tarve · Bun** | 129 | 1.0× | 51 |
| 3 | **Tarve · Bun `lowPower`** | 133 | 1.1× | 55 |
| 4 | **Tarve · txiki** | 134 | 1.1× | 58 |
| 5 | egui | 267 | 2.2× | 165 |
| 6 | Electron | 363 | 3.0× | 114 |
| 7 | **Tarve · Node `lowPower`** | 436 | 3.5× | 368 |
| 8 | **Tarve · Node** | 448 | 3.6× | 360 |
| 9 | Tauri | 465 | 3.8× | 37 |
| 10 | Flutter | 590 | 4.8× | 510 |
| 11 | Dioxus Native | 950 | 7.7× | 237 |

### 3. First frame, 2,000 rows

The same, with the whole list built.

| # | App | ms | vs 1st | Window created (ms) |
| ---: | --- | ---: | ---: | ---: |
| 1 | **Tarve · Bun `lowPower`** | 219 | — | 136 |
| 2 | **Tarve · Bun** | 241 | 1.1× | 153 |
| 3 | egui | 301 | 1.4× | 186 |
| 4 | Electron | 361 | 1.6× | 116 |
| 5 | Tauri | 476 | 2.2× | 36 |
| 6 | **Tarve · txiki `lowPower`** | 496 | 2.3× | 419 |
| 7 | **Tarve · Node `lowPower`** | 531 | 2.4× | 455 |
| 8 | **Tarve · txiki** | 541 | 2.5× | 463 |
| 9 | **Tarve · Node** | 563 | 2.6× | 482 |
| 10 | Flutter | 760 | 3.5× | 673 |
| 11 | Dioxus Native | 998 | 4.6× | 237 |

## Memory

### 4. Idle RAM, empty screen

Private working set: physical RAM used only by the app, summed over all its processes. "Committed" is the reserved memory (private bytes).

| # | App | MB | vs 1st | Committed (MB) |
| ---: | --- | ---: | ---: | ---: |
| 1 | **Tarve · txiki `lowPower`** | 18.1 | — | 68.5 |
| 2 | **Tarve · txiki** | 24.1 | 1.3× | 128.3 |
| 3 | **Tarve · Bun `lowPower`** | 24.8 | 1.4× | 128.4 |
| 4 | **Tarve · Bun** | 32.1 | 1.8× | 318.1 |
| 5 | egui | 33.6 | 1.9× | 69.8 |
| 6 | Flutter | 50.9 | 2.8× | 164 |
| 7 | **Tarve · Node `lowPower`** | 59.4 | 3.3× | 73 |
| 8 | **Tarve · Node** | 65.4 | 3.6× | 133.6 |
| 9 | Electron | 71.2 | 3.9× | 145.5 |
| 10 | Tauri | 75.4 | 4.2× | 153.8 |
| 11 | Dioxus Native | 134.5 | 7.4× | 467.9 |

### 5. Idle RAM, 2,000 rows

The same, with the list built.

| # | App | MB | vs 1st | Committed (MB) |
| ---: | --- | ---: | ---: | ---: |
| 1 | egui | 65.9 | — | 100.7 |
| 2 | **Tarve · txiki `lowPower`** | 87.3 | 1.3× | 150.7 |
| 3 | **Tarve · Bun `lowPower`** | 90.1 | 1.4× | 209.7 |
| 4 | **Tarve · txiki** | 95.1 | 1.4× | 213.7 |
| 5 | **Tarve · Bun** | 97.6 | 1.5× | 404.9 |
| 6 | **Tarve · Node `lowPower`** | 102.5 | 1.6× | 119.2 |
| 7 | Electron | 108 | 1.6× | 188.7 |
| 8 | **Tarve · Node** | 110.6 | 1.7× | 181.4 |
| 9 | Tauri | 115.2 | 1.7× | 201.9 |
| 10 | Dioxus Native | 171.6 | 2.6× | 504.6 |
| 11 | Flutter | 246.6 | 3.7× | 360 |

### 6. GPU memory

Dedicated video memory from the Windows `GPU Process Memory` counter. The `lowPower` variants draw on the CPU and use no GPU.

| # | App | MB | vs 1st | With 2,000 rows (MB) |
| ---: | --- | ---: | ---: | ---: |
| 1 | **Tarve · Bun `lowPower`** | 0 | — | 0 |
| 2 | **Tarve · Node `lowPower`** | 0 | — | 0 |
| 3 | **Tarve · txiki `lowPower`** | 0 | — | 0 |
| 4 | egui | 22.8 | +22.8 | 22.8 |
| 5 | Tauri | 25.5 | +25.5 | 29.3 |
| 6 | Electron | 26.6 | +26.6 | 30.6 |
| 7 | **Tarve · Bun** | 33.4 | +33.4 | 33.4 |
| 8 | **Tarve · Node** | 33.4 | +33.4 | 33.4 |
| 9 | **Tarve · txiki** | 33.4 | +33.4 | 33.4 |
| 10 | Flutter | 68.8 | +68.8 | 68.8 |
| 11 | Dioxus Native | 269.2 | +269.2 | 269.2 |

## Interaction

### 7. CPU while scrolling

240 real mouse-wheel steps (SendInput), about 60 per second, over the list.

| # | App | % of one core | vs 1st | GPU 3D use % |
| ---: | --- | ---: | ---: | ---: |
| 1 | **Tarve · Node** | 23.5 | — | 5.3 |
| 2 | **Tarve · txiki** | 24.3 | 1.0× | 5.1 |
| 3 | **Tarve · Bun** | 25.8 | 1.1× | 6.3 |
| 4 | Tauri | 34.6 | 1.5× | 2.6 |
| 5 | Electron | 47.2 | 2.0× | 2.5 |
| 6 | Dioxus Native | 98.2 | 4.2× | 2.3 |
| 7 | Flutter | 99.1 | 4.2× | 3.3 |
| 8 | egui | 102.9 | 4.4× | 5.2 |
| 9 | **Tarve · Bun `lowPower`** | 115.9 | 4.9× | 0 |
| 10 | **Tarve · txiki `lowPower`** | 118.8 | 5.1× | 0 |
| 11 | **Tarve · Node `lowPower`** | 119.7 | 5.1× | 0 |

### 8. Update time

Real clicks on the "Update" button, each one changing the text of all 2,000 rows. Measured from the click until the new colour shows on screen.

| # | App | ms (median) | vs 1st | 95th percentile (ms) |
| ---: | --- | ---: | ---: | ---: |
| 1 | **Tarve · Node** | 25.4 | — | 37.4 |
| 2 | Electron | 25.6 | 1.0× | 33.1 |
| 3 | **Tarve · Bun** | 25.7 | 1.0× | 34 |
| 4 | Tauri | 28.8 | 1.1× | 33.8 |
| 5 | egui | 36.6 | 1.4× | 42.5 |
| 6 | **Tarve · Node `lowPower`** | 41.1 | 1.6× | 46.3 |
| 7 | **Tarve · Bun `lowPower`** | 41.2 | 1.6× | 46.1 |
| 8 | Dioxus Native | 50.1 | 2.0× | 54.3 |
| 9 | **Tarve · txiki `lowPower`** | 112.8 | 4.4× | 140.6 |
| 10 | **Tarve · txiki** | 115.5 | 4.5× | 140.9 |
| 11 | Flutter | 158.5 | 6.2× | 175.5 |

## Where Tarve spends the 2,000-row update

Measured inside the app with `app.stats()` (`STATS=1`), median / 95th percentile over its frames. Layout runs only for the rows that show; the rest lays out after the frame is presented, in a frame of its own.

| Phase | Bun | txiki |
| --- | ---: | ---: |
| JS update (render + diff + send) | 9.7 / 11.3 ms | 126.6 / 171.7 ms |
| ↳ JS render | 7.7 / 9.3 ms | 85.6 / 115.5 ms |
| ↳ JS diff | 1.6 / 2.3 ms | 17.5 / 22.2 ms |
| Native apply | 1.4 / 2.4 ms | 1.6 / 2.6 ms |
| Native layout (taffy + text) | 0.0 / 2.9 ms | 0.0 / 3.5 ms |
| Native paint | 1.3 / 2.1 ms | 1.3 / 2.5 ms |
| Native frame (CPU) | 1.5 / 5.5 ms | 1.4 / 5.7 ms |

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
| Tarve · Bun | 150.7 | 75.9 | 51 | 129 | 318.1 | 32.1 | 82.6 | 90 | 645 | 1 | 0 | 33.4 | 2.3 | — | — | 8.7 | 15.8 | 29.9 | 0 | 337.9 | 89.6 | 337.9 | 36.4 | 4.8 | 5 |
| Tarve · Bun `lowPower` | 150.7 | 75.9 | 55 | 133 | 128.4 | 24.8 | 55.3 | 24 | 284 | 1 | 0 | 0 | 0 | — | — | 4.4 | 13.5 | 23.9 | 0 | 146.2 | 61.4 | 146.2 | 28.2 | 7.6 | 5 |
| Tarve · Node | 114.9 | 43.4 | 360 | 448 | 133.6 | 65.4 | 138 | 84 | 639 | 1 | 0 | 33.4 | 2.3 | — | — | 8.4 | 16.5 | 28.8 | 0 | 140.4 | 144.5 | 107.7 | 40.1 | 8.1 | 5 |
| Tarve · Node `lowPower` | 114.9 | 43.4 | 368 | 436 | 73 | 59.4 | 112 | 18 | 296 | 1 | 0 | 0 | 0 | — | — | 4.2 | 13.2 | 25 | 0 | 75.2 | 115.2 | 46.6 | 33.4 | 4.9 | 5 |
| Tarve · txiki | 11.5 | 8.6 | 58 | 134 | 128.3 | 24.1 | 65.4 | 84 | 640 | 1 | 0 | 33.4 | 2.3 | — | — | 8.6 | 16.6 | 29.1 | 0 | 135.1 | 72 | 129.4 | 26 | 4.6 | 5 |
| Tarve · txiki `lowPower` | 11.5 | 8.6 | 45 | 123 | 68.5 | 18.1 | 39.5 | 18 | 295 | 1 | 0 | 0 | 0 | — | — | 4.9 | 13 | 22.9 | 0 | 69.1 | 41.4 | 69.1 | 19 | 4.3 | 5 |
| Electron | 357.1 | 150.9 | 114 | 363 | 145.5 | 71.2 | 298.4 | 167 | 2363 | 4 | 0 | 26.6 | 1.9 | — | — | 9 | 15.5 | 17.5 | 0 | 149.2 | 302.4 | 149 | 73.1 | 7.8 | 5 |
| Tauri | 4.1 | 1.6 | 37 | 465 | 153.8 | 75.4 | 357 | 238 | 3550 | 7 | 0.3 | 25.5 | 1.8 | — | — | 9.1 | 16.1 | 17 | 0 | 159.4 | 364.1 | 156.8 | 77.1 | 11 | 5 |
| Flutter | 24.8 | 10.4 | 510 | 590 | 164 | 50.9 | 99 | 105 | 723 | 1 | 0 | 68.8 | 8 | — | — | 4.4 | 9 | 14.7 | 0 | 173.8 | 107.3 | 171.9 | 58.7 | 5.7 | 5 |
| Dioxus Native | 14.9 | 6.4 | 237 | 950 | 467.9 | 134.5 | 200.7 | 56 | 707 | 1 | 0 | 269.2 | 52.6 | — | — | 5.6 | 13.1 | 16.1 | 0 | 478.2 | 204.4 | 468.8 | 138.1 | 4.8 | 5 |
| egui | 3.5 | 1.8 | 165 | 267 | 69.8 | 33.6 | 65.2 | 16 | 390 | 1 | 0 | 22.8 | 5.7 | — | — | 5.3 | 9.8 | 10.7 | 0 | 74.8 | 70.8 | 74.8 | 39.1 | 7.6 | 5 |

### 2,000 rows

| App | Disk MB | Zipped MB | Window ms | First frame ms | Committed MB | Private WS MB | Working set MB | Threads | Handles | Processes | Idle CPU % | Dedicated GPU MB | Shared GPU MB | Scroll CPU % | Scroll GPU 3D % | Update median ms | Update p95 ms | Update max ms | Missed clicks | Peak committed MB | Peak working set MB | Final committed MB | Final private WS MB | Machine busy % | Runs |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| Tarve · Bun | 150.7 | 75.9 | 153 | 241 | 404.9 | 97.6 | 154.1 | 90 | 646 | 1 | 0 | 33.4 | 3 | 25.8 | 6.3 | 25.7 | 34 | 49.4 | 0 | 530.4 | 240.7 | 505.2 | 180.1 | 7.4 | 5 |
| Tarve · Bun `lowPower` | 150.7 | 75.9 | 136 | 219 | 209.7 | 90.1 | 126.6 | 24 | 291 | 1 | 0 | 0 | 0 | 115.9 | 0 | 41.2 | 46.1 | 58.3 | 0 | 345.9 | 219.4 | 315.6 | 173.9 | 4.3 | 5 |
| Tarve · Node | 114.9 | 43.4 | 482 | 563 | 181.4 | 110.6 | 188 | 84 | 654 | 1 | 0 | 33.4 | 3 | 23.5 | 5.3 | 25.4 | 37.4 | 41.2 | 0 | 295.5 | 299.3 | 292.7 | 217 | 7.8 | 5 |
| Tarve · Node `lowPower` | 114.9 | 43.4 | 455 | 531 | 119.2 | 102.5 | 159.9 | 18 | 303 | 1 | 0 | 0 | 0 | 119.7 | 0 | 41.1 | 46.3 | 50 | 0 | 227.2 | 265.7 | 226.5 | 205.1 | 4.3 | 5 |
| Tarve · txiki | 11.5 | 8.6 | 463 | 541 | 213.7 | 95.1 | 136.6 | 83 | 663 | 1 | 0 | 33.4 | 3.3 | 24.3 | 5.1 | 115.5 | 140.9 | 141.4 | 0 | 240.3 | 170.9 | 234.7 | 125.1 | 4.5 | 5 |
| Tarve · txiki `lowPower` | 11.5 | 8.6 | 419 | 496 | 150.7 | 87.3 | 109.5 | 18 | 302 | 1 | 0 | 0 | 0 | 118.8 | 0 | 112.8 | 140.6 | 148.8 | 0 | 179.8 | 146.4 | 174.5 | 118.3 | 7.7 | 5 |
| Electron | 357.1 | 150.9 | 116 | 361 | 188.7 | 108 | 338.8 | 169 | 2380 | 4 | 0.3 | 30.6 | 2.2 | 47.2 | 2.5 | 25.6 | 33.1 | 38 | 0 | 263.2 | 408.7 | 261.1 | 171.8 | 3.8 | 5 |
| Tauri | 4.1 | 1.6 | 36 | 476 | 201.9 | 115.2 | 402.1 | 240 | 3562 | 7 | 0 | 29.3 | 2.4 | 34.6 | 2.6 | 28.8 | 33.8 | 37 | 0 | 270.7 | 471 | 265.5 | 176.1 | 8.3 | 5 |
| Flutter | 24.8 | 10.4 | 673 | 760 | 360 | 246.6 | 294.8 | 106 | 729 | 1 | 0.3 | 68.8 | 8 | 99.1 | 3.3 | 158.5 | 175.5 | 203.1 | 0 | 437.4 | 367.3 | 409.9 | 292.6 | 5.2 | 5 |
| Dioxus Native | 14.9 | 6.4 | 237 | 998 | 504.6 | 171.6 | 237.7 | 56 | 705 | 1 | 0 | 269.2 | 52.6 | 98.2 | 2.3 | 50.1 | 54.3 | 55.7 | 0 | 515.4 | 244.1 | 509.5 | 177.6 | 4.4 | 5 |
| egui | 3.5 | 1.8 | 186 | 301 | 100.7 | 65.9 | 97.5 | 16 | 390 | 1 | 0 | 22.8 | 6.7 | 102.9 | 5.2 | 36.6 | 42.5 | 49.6 | 0 | 144.3 | 137.2 | 143.4 | 103.8 | 4.7 | 5 |
