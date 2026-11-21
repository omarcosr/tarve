# Cross-framework GUI benchmark

The same screen built in each framework, measured from outside the process the same way for all of them (`harness/`, Windows):

- **Screen:** a 48×48 marker at the client area's top-left corner, an "Update" button and, with `SCENE=list`, 2,000 rows (text + button) in a scroll area. "Update" changes the label of **every** row and toggles the marker colour.
- **First frame:** time from `CreateProcess` until the marker's magenta shows on screen (read with BitBlt from the composited desktop).
- **Memory:** summed over the whole process tree (Electron and WebView2 spawn child processes). *Private WS* (private working set) is the RAM only that app uses; *private* is commit.
- **Idle:** 3 s after the first frame, then 5 s of idle CPU. GPU memory comes from the Windows counters (`GPU Process Memory`).
- **Scroll:** 240 real wheel events (SendInput) at ~60 Hz over the list. Reports CPU and GPU 3D use of the tree.
- **Update:** 30 real clicks on "Update". Latency runs from the click until the marker's new colour shows on screen.

```
bun bench/frameworks/build.ts                       # FLUTTER=<flutter.bat> if not on PATH
RUNS=5 bun bench/frameworks/run.ts                  # → work/frameworks/results.json, results.jsonl, shots/
```

## Result (2026-11-20, 5 runs per cell, median)

Intel Core Ultra 7 255HX, RTX 5070 Laptop, 31 GB, Windows 11 Insider 26340, 125% scale, 240 Hz.
Versions: Tarve 0.13.6 (Bun 1.4.4, Node 26.10, txiki), Electron 45.4.1 + React 19.3, Tauri 2.12 (WebView2 157) + React 19.3, Flutter 3.50.1, Dioxus Native 0.7.10, eframe/egui 0.33.
Tarve `auto` = D3D11; `lowPower` = CPU renderer.

### Size and startup

| App | Disk MB | Zip MB | 1st frame, empty | 1st frame, 2,000 rows |
| --- | ---: | ---: | ---: | ---: |
| Tarve · Bun | 150.7 | 75.9 | 139 ms | 239 ms |
| Tarve · Bun lowPower | 150.7 | 75.9 | 131 ms | **212 ms** |
| Tarve · Node | 114.8 | 43.4 | 441 ms | 583 ms |
| Tarve · txiki | 11.5 | 8.6 | 126 ms | 524 ms |
| Tarve · txiki lowPower | 11.5 | 8.6 | **124 ms** | 486 ms |
| Electron | 357.1 | 150.9 | 378 ms | 367 ms |
| Tauri (*) | 4.1 | 1.6 | 440 ms | 460 ms |
| Flutter | 24.8 | 10.4 | 547 ms | 743 ms |
| Dioxus Native | 14.9 | 6.4 | 966 ms | 957 ms |
| egui | **3.5** | 1.8 | 277 ms | 298 ms |

(*) Tauri relies on the WebView2 runtime installed on the system, which is not counted.

### Idle memory and hardware

| App | Private WS empty | Private WS list | Commit empty | Commit list | Threads / processes | Dedicated GPU MB |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| Tarve · Bun | 32.5 | 97.3 | 319.5 | 405.3 | 90 / 1 | 33.4 |
| Tarve · Bun lowPower | 25.2 | 88.6 | 128.8 | 211.9 | 24 / 1 | 0 |
| Tarve · Node | 65.9 | 110.5 | 133.9 | 181.9 | 84 / 1 | 33.4 |
| Tarve · txiki | 24.4 | 96.4 | 129.0 | 215.2 | 84 / 1 | 33.4 |
| Tarve · txiki lowPower | **18.5** | 87.9 | 68.8 | 146.0 | 18 / 1 | 0 |
| Electron | 72.7 | 105.3 | 147.2 | 186.7 | 165 / 4 | 26.6 |
| Tauri | 75.6 | 115.7 | 154.3 | 200.4 | 239 / 7 | 25.5 |
| Flutter | 50.8 | 246.7 | 163.9 | 359.5 | 105 / 1 | 68.8 |
| Dioxus Native | 135.7 | 172.1 | 464.7 | 507.8 | 56 / 1 | 269.2 |
| egui | 33.6 | **65.9** | **68.4** | **100.7** | 16 / 1 | 22.8 |

Idle CPU: 0–0.6% of one core in every app (no idle frames).

### Interaction (2,000 rows)

| App | Scroll CPU (% of 1 core) | Scroll GPU 3D | Update p50 | Update p95 | Peak private WS* |
| --- | ---: | ---: | ---: | ---: | ---: |
| Tarve · Bun | 30.5 | 2.8% | 66.1 ms | 74.7 ms | 251 |
| Tarve · Bun lowPower | 120.4 | 0 | 66.2 ms | 83.3 ms | 215 |
| Tarve · Node | 26.2 | 2.7% | 66.2 ms | 79.0 ms | 297 |
| Tarve · txiki | **24.3** | 2.6% | 270.9 ms | 316.3 ms | 177 |
| Tarve · txiki lowPower | 122.0 | 0 | 274.5 ms | 321.7 ms | 162 |
| Electron | 41.2 | 3.1% | 28.6 ms | 33.7 ms | 405 |
| Tauri | 36.9 | 3.1% | **28.5 ms** | **32.8 ms** | 473 |
| Flutter | 103.8 | 0.6% | 158.3 ms | 186.8 ms | 365 |
| Dioxus Native | 100.1 | 1.3% | 53.6 ms | 58.9 ms | 244 |
| egui | 102.8 | 0.8% | 37.1 ms | 40.8 ms | 137 |

\* peak working set of the tree at the end of the run.

On the empty screen the update takes 4–12 ms in every framework: that is the vsync and composition floor at 240 Hz.

### Where Tarve spends the 2,000-row update (`STATS=1`, `app.stats()`, p50)

| Phase | Bun | txiki |
| --- | ---: | ---: |
| JS `update` (render + diff + send) | 21.4 ms | 254.0 ms |
| ↳ JS `render` | 13.5 ms | 208.3 ms |
| ↳ JS `diff` | 2.8 ms | 34.4 ms |
| native `apply` | 5.2 ms | 5.2 ms |
| native `layout` (taffy + text) | 20.5 ms | 20.1 ms |
| native `paint` | 1.7 ms | 1.7 ms |

## Caveats

- Measured on a single machine. All starts are warm (the file cache is already loaded). Other work on the machine took 5–14% of the total CPU (`machineBusyPct`).
- Electron and Tauri use React 19 with no virtualization. Flutter uses a plain `Column` (with the idiomatic `ListView.builder`, only the visible rows would exist), so every framework renders all 2,000 rows. egui is immediate mode and redraws the whole frame on any input.
- Latency is measured on screen, so it includes vsync and DWM composition (about 4 ms at 240 Hz).
- Dioxus Native (Blitz) on 0.7.10 still marks itself experimental.
