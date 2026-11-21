# Cross-framework GUI benchmark

The same screen built in Tarve and in 5 other GUI frameworks (Electron, Tauri, Flutter, Dioxus Native, egui), all measured from outside the process in exactly the same way.

- **Date:** 2026-11-20 · median of 5 runs per app and scene · **lower is better for every metric**
- **Machine:** Intel Core Ultra 7 255HX, RTX 5070 Laptop, 31 GB, Windows 11 Insider 26340, 125% scaling, 240 Hz
- **Versions:** Tarve 0.13.6 (Bun 1.4.4, Node 26.10, txiki), Electron 45.4.1 + React 19.3, Tauri 2.12 (WebView2 157) + React 19.3, Flutter 3.50.1, Dioxus Native 0.7.10, egui/eframe 0.33
- **Tarve variants:** Bun, Node or txiki as the JavaScript runtime; GPU rendering by default (`auto`, D3D11) or the `lowPower` option (CPU rendering).

## Summary

| # | Metric | 1st place | Best Tarve | Tarve rank |
| ---: | --- | --- | --- | :---: |
| 1 | [Disk size](#1-disk-size) | egui · 3.5 MB | Tarve · txiki · 11.5 MB | 3rd of 11 |
| 2 | [First frame, empty screen](#2-first-frame-empty-screen) | Tarve · txiki `lowPower` · 124 ms | Tarve · txiki `lowPower` · 124 ms | 1st of 11 |
| 3 | [First frame, 2,000 rows](#3-first-frame-2000-rows) | Tarve · Bun `lowPower` · 212 ms | Tarve · Bun `lowPower` · 212 ms | 1st of 11 |
| 4 | [Idle RAM, empty screen](#4-idle-ram-empty-screen) | Tarve · txiki `lowPower` · 18.5 MB | Tarve · txiki `lowPower` · 18.5 MB | 1st of 11 |
| 5 | [Idle RAM, 2,000 rows](#5-idle-ram-2000-rows) | egui · 65.9 MB | Tarve · txiki `lowPower` · 87.9 MB | 2nd of 11 |
| 6 | [GPU memory](#6-gpu-memory) | Tarve · Bun `lowPower` · 0 MB | Tarve · Bun `lowPower` · 0 MB | 1st of 11 |
| 7 | [CPU while scrolling](#7-cpu-while-scrolling) | Tarve · txiki · 24.3 % of one core | Tarve · txiki · 24.3 % of one core | 1st of 11 |
| 8 | [Update time](#8-update-time) | Tauri · 28.5 ms (median) | Tarve · Bun · 66.1 ms (median) | 5th of 11 |

**At a glance:** Tarve starts the fastest (metrics 2 and 3), uses the least RAM on an empty screen (4) and the least CPU while scrolling with GPU rendering (7). It loses on updating the list (8): 66 ms on Bun or Node against 28.5 ms on Tauri and Electron, and 271 ms on txiki. It also loses on disk size with Bun or Node (1).

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
| 7 | **Tarve · Node** | 114.8 | 32.8× | 43.4 |
| 8 | **Tarve · Node `lowPower`** | 114.8 | 32.8× | 43.4 |
| 9 | **Tarve · Bun** | 150.7 | 43.1× | 75.9 |
| 10 | **Tarve · Bun `lowPower`** | 150.7 | 43.1× | 75.9 |
| 11 | Electron | 357.1 | 102.0× | 150.9 |

### 2. First frame, empty screen

From `CreateProcess` until the content shows on screen.

| # | App | ms | vs 1st | Window created (ms) |
| ---: | --- | ---: | ---: | ---: |
| 1 | **Tarve · txiki `lowPower`** | 124 | — | 47 |
| 2 | **Tarve · txiki** | 126 | 1.0× | 52 |
| 3 | **Tarve · Bun `lowPower`** | 131 | 1.1× | 54 |
| 4 | **Tarve · Bun** | 139 | 1.1× | 57 |
| 5 | egui | 277 | 2.2× | 166 |
| 6 | Electron | 378 | 3.0× | 120 |
| 7 | **Tarve · Node `lowPower`** | 427 | 3.4× | 356 |
| 8 | Tauri | 440 | 3.5× | 37 |
| 9 | **Tarve · Node** | 441 | 3.6× | 356 |
| 10 | Flutter | 547 | 4.4× | 471 |
| 11 | Dioxus Native | 966 | 7.8× | 238 |

### 3. First frame, 2,000 rows

The same, with the whole list built.

| # | App | ms | vs 1st | Window created (ms) |
| ---: | --- | ---: | ---: | ---: |
| 1 | **Tarve · Bun `lowPower`** | 212 | — | 132 |
| 2 | **Tarve · Bun** | 239 | 1.1× | 160 |
| 3 | egui | 298 | 1.4× | 175 |
| 4 | Electron | 367 | 1.7× | 113 |
| 5 | Tauri | 460 | 2.2× | 36 |
| 6 | **Tarve · txiki `lowPower`** | 486 | 2.3× | 406 |
| 7 | **Tarve · Node `lowPower`** | 509 | 2.4× | 435 |
| 8 | **Tarve · txiki** | 524 | 2.5× | 448 |
| 9 | **Tarve · Node** | 583 | 2.8× | 502 |
| 10 | Flutter | 743 | 3.5× | 668 |
| 11 | Dioxus Native | 957 | 4.5× | 232 |

## Memory

### 4. Idle RAM, empty screen

Private working set: physical RAM used only by the app, summed over all its processes. "Committed" is the reserved memory (private bytes).

| # | App | MB | vs 1st | Committed (MB) |
| ---: | --- | ---: | ---: | ---: |
| 1 | **Tarve · txiki `lowPower`** | 18.5 | — | 68.8 |
| 2 | **Tarve · txiki** | 24.4 | 1.3× | 129 |
| 3 | **Tarve · Bun `lowPower`** | 25.2 | 1.4× | 128.8 |
| 4 | **Tarve · Bun** | 32.5 | 1.8× | 319.5 |
| 5 | egui | 33.6 | 1.8× | 68.4 |
| 6 | Flutter | 50.8 | 2.7× | 163.9 |
| 7 | **Tarve · Node `lowPower`** | 59.7 | 3.2× | 73.4 |
| 8 | **Tarve · Node** | 65.9 | 3.6× | 133.9 |
| 9 | Electron | 72.7 | 3.9× | 147.2 |
| 10 | Tauri | 75.6 | 4.1× | 154.3 |
| 11 | Dioxus Native | 135.7 | 7.3× | 464.7 |

### 5. Idle RAM, 2,000 rows

The same, with the list built.

| # | App | MB | vs 1st | Committed (MB) |
| ---: | --- | ---: | ---: | ---: |
| 1 | egui | 65.9 | — | 100.7 |
| 2 | **Tarve · txiki `lowPower`** | 87.9 | 1.3× | 146 |
| 3 | **Tarve · Bun `lowPower`** | 88.6 | 1.3× | 211.9 |
| 4 | **Tarve · txiki** | 96.4 | 1.5× | 215.2 |
| 5 | **Tarve · Bun** | 97.3 | 1.5× | 405.3 |
| 6 | **Tarve · Node `lowPower`** | 102.8 | 1.6× | 119.7 |
| 7 | Electron | 105.3 | 1.6× | 186.7 |
| 8 | **Tarve · Node** | 110.5 | 1.7× | 181.9 |
| 9 | Tauri | 115.7 | 1.8× | 200.4 |
| 10 | Dioxus Native | 172.1 | 2.6× | 507.8 |
| 11 | Flutter | 246.7 | 3.7× | 359.5 |

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
| 1 | **Tarve · txiki** | 24.3 | — | 2.6 |
| 2 | **Tarve · Node** | 26.2 | 1.1× | 2.7 |
| 3 | **Tarve · Bun** | 30.5 | 1.3× | 2.8 |
| 4 | Tauri | 36.9 | 1.5× | 3.1 |
| 5 | Electron | 41.2 | 1.7× | 3.1 |
| 6 | Dioxus Native | 100.1 | 4.1× | 1.3 |
| 7 | egui | 102.8 | 4.2× | 0.8 |
| 8 | Flutter | 103.8 | 4.3× | 0.6 |
| 9 | **Tarve · Bun `lowPower`** | 120.4 | 5.0× | 0 |
| 10 | **Tarve · Node `lowPower`** | 121.3 | 5.0× | 0 |
| 11 | **Tarve · txiki `lowPower`** | 122 | 5.0× | 0 |

### 8. Update time

30 real clicks on the "Update" button, each one changing the text of all 2,000 rows. Measured from the click until the new colour shows on screen. No app missed a click.

| # | App | ms (median) | vs 1st | 95th percentile (ms) |
| ---: | --- | ---: | ---: | ---: |
| 1 | Tauri | 28.5 | — | 32.8 |
| 2 | Electron | 28.6 | 1.0× | 33.7 |
| 3 | egui | 37.1 | 1.3× | 40.8 |
| 4 | Dioxus Native | 53.6 | 1.9× | 58.9 |
| 5 | **Tarve · Bun** | 66.1 | 2.3× | 74.7 |
| 6 | **Tarve · Bun `lowPower`** | 66.2 | 2.3× | 83.3 |
| 7 | **Tarve · Node** | 66.2 | 2.3× | 79 |
| 8 | **Tarve · Node `lowPower`** | 66.5 | 2.3× | 95.4 |
| 9 | Flutter | 158.3 | 5.6× | 186.8 |
| 10 | **Tarve · txiki** | 270.9 | 9.5× | 316.3 |
| 11 | **Tarve · txiki `lowPower`** | 274.5 | 9.6× | 321.7 |

## Where Tarve spends the 2,000-row update

Measured inside the app with `app.stats()` (`STATS=1`), median:

| Phase | Bun | txiki |
| --- | ---: | ---: |
| JS update (render + diff + send) | 21.4 ms | 254.0 ms |
| ↳ JS render | 13.5 ms | 208.3 ms |
| ↳ JS diff | 2.8 ms | 34.4 ms |
| Native apply | 5.2 ms | 5.2 ms |
| Native layout (taffy + text) | 20.5 ms | 20.1 ms |
| Native paint | 1.7 ms | 1.7 ms |

On Bun the time splits between JS (about 21 ms) and native layout (about 20 ms). On txiki, rendering the tree in QuickJS dominates.

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
```

## Limitations

- A single machine, warm starts only (files already in the OS cache). Other work used 5–14% of total CPU, recorded in the "Machine busy %" column.
- No app virtualizes the list: Electron and Tauri use React 19 without virtualization and Flutter uses a `Column`; the idiomatic `ListView.builder` would build only the visible rows. egui is immediate mode and redraws the whole window on every input.
- Update times include vsync and Windows composition (DWM), about 4 ms at 240 Hz. On the empty screen every app takes 4–12 ms.
- Dioxus Native 0.7.10 still describes itself as experimental.

## Full data

Every collected metric, median of 5 runs. Individual runs are in `results/results.jsonl`, medians in `results/results.json` and first-run screenshots in `results/shots/`. "Missed clicks" counts clicks whose change did not reach the screen within 3 s.

### Empty screen

| App | Disk MB | Zipped MB | Window ms | First frame ms | Committed MB | Private WS MB | Working set MB | Threads | Handles | Processes | Idle CPU % | Dedicated GPU MB | Shared GPU MB | Scroll CPU % | Scroll GPU 3D % | Update median ms | Update p95 ms | Update max ms | Missed clicks | Peak committed MB | Peak working set MB | Final committed MB | Final private WS MB | Machine busy % | Runs |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| Tarve · Bun | 150.7 | 75.9 | 57 | 139 | 319.5 | 32.5 | 82.8 | 90 | 644 | 1 | 0 | 33.4 | 2.3 | — | — | 8 | 12.7 | 20.8 | 0 | 338.8 | 89.2 | 338.8 | 36.1 | 5.4 | 5 |
| Tarve · Bun `lowPower` | 150.7 | 75.9 | 54 | 131 | 128.8 | 25.2 | 55.5 | 24 | 283 | 1 | 0 | 0 | 0 | — | — | 7.9 | 8.9 | 21 | 0 | 146.3 | 61.2 | 146 | 28.1 | 6.6 | 5 |
| Tarve · Node | 114.8 | 43.4 | 356 | 441 | 133.9 | 65.9 | 138.5 | 84 | 638 | 1 | 0 | 33.4 | 2.3 | — | — | 8.2 | 13 | 20.9 | 0 | 140.6 | 145 | 107.5 | 40.2 | 5.9 | 5 |
| Tarve · Node `lowPower` | 114.8 | 43.4 | 356 | 427 | 73.4 | 59.7 | 112.3 | 18 | 295 | 1 | 0 | 0 | 0 | — | — | 7.8 | 8.8 | 20.9 | 0 | 75 | 115 | 46.5 | 33.1 | 9.7 | 5 |
| Tarve · txiki | 11.5 | 8.6 | 52 | 126 | 129 | 24.4 | 65.7 | 84 | 639 | 1 | 0 | 33.4 | 2.3 | — | — | 7.8 | 12.6 | 20.9 | 0 | 135.7 | 72.4 | 129.6 | 25.6 | 13.9 | 5 |
| Tarve · txiki `lowPower` | 11.5 | 8.6 | 47 | 124 | 68.8 | 18.5 | 39.8 | 18 | 294 | 1 | 0 | 0 | 0 | — | — | 7.9 | 8.5 | 20.9 | 0 | 69.1 | 41.3 | 69.1 | 18.9 | 6.2 | 5 |
| Electron | 357.1 | 150.9 | 120 | 378 | 147.2 | 72.7 | 300.2 | 165 | 2351 | 4 | 0 | 26.6 | 1.9 | — | — | 8.1 | 12.5 | 12.9 | 0 | 151.5 | 303.5 | 151.5 | 74.4 | 6.1 | 5 |
| Tauri | 4.1 | 1.6 | 37 | 440 | 154.3 | 75.6 | 357.6 | 239 | 3536 | 7 | 0.6 | 25.5 | 2 | — | — | 12 | 13.1 | 13.6 | 0 | 160 | 364.7 | 157.3 | 77.4 | 6.8 | 5 |
| Flutter | 24.8 | 10.4 | 471 | 547 | 163.9 | 50.8 | 98.9 | 105 | 722 | 1 | 0 | 68.8 | 8 | — | — | 4.2 | 8.5 | 12.6 | 0 | 173.5 | 107.3 | 171.9 | 58.7 | 8.9 | 5 |
| Dioxus Native | 14.9 | 6.4 | 238 | 966 | 464.7 | 135.7 | 201.9 | 56 | 706 | 1 | 0.6 | 269.2 | 52.6 | — | — | 7.8 | 8.4 | 8.5 | 0 | 473 | 205.9 | 465.6 | 139.6 | 13.6 | 5 |
| egui | 3.5 | 1.8 | 166 | 277 | 68.4 | 33.6 | 65.2 | 16 | 389 | 1 | 0 | 22.8 | 5.7 | — | — | 4.8 | 8.5 | 9.1 | 0 | 73.4 | 70.9 | 73.4 | 39.2 | 5.4 | 5 |

### 2,000 rows

| App | Disk MB | Zipped MB | Window ms | First frame ms | Committed MB | Private WS MB | Working set MB | Threads | Handles | Processes | Idle CPU % | Dedicated GPU MB | Shared GPU MB | Scroll CPU % | Scroll GPU 3D % | Update median ms | Update p95 ms | Update max ms | Missed clicks | Peak committed MB | Peak working set MB | Final committed MB | Final private WS MB | Machine busy % | Runs |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| Tarve · Bun | 150.7 | 75.9 | 160 | 239 | 405.3 | 97.3 | 153.8 | 90 | 645 | 1 | 0.3 | 33.4 | 3 | 30.5 | 2.8 | 66.1 | 74.7 | 82.5 | 0 | 542.9 | 251 | 501.8 | 151.7 | 6.7 | 5 |
| Tarve · Bun `lowPower` | 150.7 | 75.9 | 132 | 212 | 211.9 | 88.6 | 125 | 24 | 290 | 1 | 0 | 0 | 0 | 120.4 | 0 | 66.2 | 83.3 | 91 | 0 | 358.6 | 214.8 | 332.9 | 148.7 | 13 | 5 |
| Tarve · Node | 114.8 | 43.4 | 502 | 583 | 181.9 | 110.5 | 188.1 | 84 | 653 | 1 | 0 | 33.4 | 3 | 26.2 | 2.7 | 66.2 | 79 | 90.9 | 0 | 296.2 | 297.1 | 293 | 215 | 6.1 | 5 |
| Tarve · Node `lowPower` | 114.8 | 43.4 | 435 | 509 | 119.7 | 102.8 | 160.2 | 18 | 302 | 1 | 0 | 0 | 0 | 121.3 | 0 | 66.5 | 95.4 | 104.5 | 0 | 242.4 | 277.7 | 240.9 | 217 | 5.2 | 5 |
| Tarve · txiki | 11.5 | 8.6 | 448 | 524 | 215.2 | 96.4 | 137.8 | 83 | 662 | 1 | 0 | 33.4 | 3.3 | 24.3 | 2.6 | 270.9 | 316.3 | 354.1 | 0 | 254.4 | 176.8 | 229.1 | 111.8 | 8.7 | 5 |
| Tarve · txiki `lowPower` | 11.5 | 8.6 | 406 | 486 | 146 | 87.9 | 110.1 | 18 | 301 | 1 | 0 | 0 | 0 | 122 | 0 | 274.5 | 321.7 | 358.2 | 0 | 205.4 | 161.9 | 198.2 | 132.7 | 9.2 | 5 |
| Electron | 357.1 | 150.9 | 113 | 367 | 186.7 | 105.3 | 336.3 | 169 | 2369 | 4 | 0.3 | 30.6 | 2.1 | 41.2 | 3.1 | 28.6 | 33.7 | 37.6 | 0 | 257 | 404.8 | 255.8 | 168.2 | 9.2 | 5 |
| Tauri | 4.1 | 1.6 | 36 | 460 | 200.4 | 115.7 | 402.8 | 239 | 3547 | 7 | 0 | 29.3 | 2.2 | 36.9 | 3.1 | 28.5 | 32.8 | 37.2 | 0 | 268.3 | 472.9 | 264.6 | 175.5 | 6 | 5 |
| Flutter | 24.8 | 10.4 | 668 | 743 | 359.5 | 246.7 | 295 | 106 | 728 | 1 | 0.3 | 68.8 | 8 | 103.8 | 0.6 | 158.3 | 186.8 | 203.7 | 0 | 434.4 | 365.1 | 403.9 | 287.1 | 10.9 | 5 |
| Dioxus Native | 14.9 | 6.4 | 232 | 957 | 507.8 | 172.1 | 238.4 | 56 | 706 | 1 | 0 | 269.2 | 52.6 | 100.1 | 1.3 | 53.6 | 58.9 | 65.9 | 0 | 519.9 | 244.1 | 509.9 | 177.2 | 13.5 | 5 |
| egui | 3.5 | 1.8 | 175 | 298 | 100.7 | 65.9 | 97.5 | 16 | 389 | 1 | 0 | 22.8 | 6.7 | 102.8 | 0.8 | 37.1 | 40.8 | 41.8 | 0 | 144.8 | 136.9 | 141.7 | 103 | 6.3 | 5 |
