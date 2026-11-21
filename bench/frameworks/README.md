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

## Ranking por métrica (mediana de 5 execuções, menor é melhor)

Uma tabela por métrica, com todos os apps ordenados do melhor para o pior. Δ é a diferença em relação ao primeiro colocado.

### 1. Disco (o que é distribuído)

O Tauri não inclui o WebView2 do sistema.

| # | App | MB | Δ vs 1º | Zip MB |
| ---: | --- | ---: | ---: | ---: |
| 1 | egui | 3.5 | — | 1.8 |
| 2 | tauri | 4.1 | 1.2× | 1.6 |
| 3 | **tarve-txiki** | 11.5 | 3.3× | 8.6 |
| 4 | **tarve-txiki-lowpower** | 11.5 | 3.3× | 8.6 |
| 5 | dioxus-native | 14.9 | 4.3× | 6.4 |
| 6 | flutter | 24.8 | 7.1× | 10.4 |
| 7 | **tarve-node** | 114.8 | 32.8× | 43.4 |
| 8 | **tarve-node-lowpower** | 114.8 | 32.8× | 43.4 |
| 9 | **tarve-bun** | 150.7 | 43.1× | 75.9 |
| 10 | **tarve-bun-lowpower** | 150.7 | 43.1× | 75.9 |
| 11 | electron | 357.1 | 102.0× | 150.9 |

### 2. 1º frame, tela vazia

Do CreateProcess até o marcador aparecer na tela.

| # | App | ms | Δ vs 1º | 1ª janela ms |
| ---: | --- | ---: | ---: | ---: |
| 1 | **tarve-txiki-lowpower** | 124 | — | 47 |
| 2 | **tarve-txiki** | 126 | 1.0× | 52 |
| 3 | **tarve-bun-lowpower** | 131 | 1.1× | 54 |
| 4 | **tarve-bun** | 139 | 1.1× | 57 |
| 5 | egui | 277 | 2.2× | 166 |
| 6 | electron | 378 | 3.0× | 120 |
| 7 | **tarve-node-lowpower** | 427 | 3.4× | 356 |
| 8 | tauri | 440 | 3.5× | 37 |
| 9 | **tarve-node** | 441 | 3.6× | 356 |
| 10 | flutter | 547 | 4.4× | 471 |
| 11 | dioxus-native | 966 | 7.8× | 238 |

### 3. 1º frame, 2.000 linhas

Do CreateProcess até o marcador aparecer na tela.

| # | App | ms | Δ vs 1º | 1ª janela ms |
| ---: | --- | ---: | ---: | ---: |
| 1 | **tarve-bun-lowpower** | 212 | — | 132 |
| 2 | **tarve-bun** | 239 | 1.1× | 160 |
| 3 | egui | 298 | 1.4× | 175 |
| 4 | electron | 367 | 1.7× | 113 |
| 5 | tauri | 460 | 2.2× | 36 |
| 6 | **tarve-txiki-lowpower** | 486 | 2.3× | 406 |
| 7 | **tarve-node-lowpower** | 509 | 2.4× | 435 |
| 8 | **tarve-txiki** | 524 | 2.5× | 448 |
| 9 | **tarve-node** | 583 | 2.8× | 502 |
| 10 | flutter | 743 | 3.5× | 668 |
| 11 | dioxus-native | 957 | 4.5× | 232 |

### 4. RAM ociosa, tela vazia (private working set)

Soma de toda a árvore de processos.

| # | App | MB | Δ vs 1º | Commit MB |
| ---: | --- | ---: | ---: | ---: |
| 1 | **tarve-txiki-lowpower** | 18.5 | — | 68.8 |
| 2 | **tarve-txiki** | 24.4 | 1.3× | 129 |
| 3 | **tarve-bun-lowpower** | 25.2 | 1.4× | 128.8 |
| 4 | **tarve-bun** | 32.5 | 1.8× | 319.5 |
| 5 | egui | 33.6 | 1.8× | 68.4 |
| 6 | flutter | 50.8 | 2.7× | 163.9 |
| 7 | **tarve-node-lowpower** | 59.7 | 3.2× | 73.4 |
| 8 | **tarve-node** | 65.9 | 3.6× | 133.9 |
| 9 | electron | 72.7 | 3.9× | 147.2 |
| 10 | tauri | 75.6 | 4.1× | 154.3 |
| 11 | dioxus-native | 135.7 | 7.3× | 464.7 |

### 5. RAM ociosa, 2.000 linhas (private working set)

Soma de toda a árvore de processos.

| # | App | MB | Δ vs 1º | Commit MB |
| ---: | --- | ---: | ---: | ---: |
| 1 | egui | 65.9 | — | 100.7 |
| 2 | **tarve-txiki-lowpower** | 87.9 | 1.3× | 146 |
| 3 | **tarve-bun-lowpower** | 88.6 | 1.3× | 211.9 |
| 4 | **tarve-txiki** | 96.4 | 1.5× | 215.2 |
| 5 | **tarve-bun** | 97.3 | 1.5× | 405.3 |
| 6 | **tarve-node-lowpower** | 102.8 | 1.6× | 119.7 |
| 7 | electron | 105.3 | 1.6× | 186.7 |
| 8 | **tarve-node** | 110.5 | 1.7× | 181.9 |
| 9 | tauri | 115.7 | 1.8× | 200.4 |
| 10 | dioxus-native | 172.1 | 2.6× | 507.8 |
| 11 | flutter | 246.7 | 3.7× | 359.5 |

### 6. CPU durante o scroll

240 eventos reais de roda a ~60 Hz.

| # | App | % de 1 core | Δ vs 1º | GPU 3D % |
| ---: | --- | ---: | ---: | ---: |
| 1 | **tarve-txiki** | 24.3 | — | 2.6 |
| 2 | **tarve-node** | 26.2 | 1.1× | 2.7 |
| 3 | **tarve-bun** | 30.5 | 1.3× | 2.8 |
| 4 | tauri | 36.9 | 1.5× | 3.1 |
| 5 | electron | 41.2 | 1.7× | 3.1 |
| 6 | dioxus-native | 100.1 | 4.1× | 1.3 |
| 7 | egui | 102.8 | 4.2× | 0.8 |
| 8 | flutter | 103.8 | 4.3× | 0.6 |
| 9 | **tarve-bun-lowpower** | 120.4 | 5.0× | 0 |
| 10 | **tarve-node-lowpower** | 121.3 | 5.0× | 0 |
| 11 | **tarve-txiki-lowpower** | 122 | 5.0× | 0 |

### 7. Update das 2.000 labels (clique até o pixel na tela)

30 cliques reais. Nenhum app teve falhas.

| # | App | ms p50 | Δ vs 1º | p95 ms |
| ---: | --- | ---: | ---: | ---: |
| 1 | tauri | 28.5 | — | 32.8 |
| 2 | electron | 28.6 | 1.0× | 33.7 |
| 3 | egui | 37.1 | 1.3× | 40.8 |
| 4 | dioxus-native | 53.6 | 1.9× | 58.9 |
| 5 | **tarve-bun** | 66.1 | 2.3× | 74.7 |
| 6 | **tarve-bun-lowpower** | 66.2 | 2.3× | 83.3 |
| 7 | **tarve-node** | 66.2 | 2.3× | 79 |
| 8 | **tarve-node-lowpower** | 66.5 | 2.3× | 95.4 |
| 9 | flutter | 158.3 | 5.6× | 186.8 |
| 10 | **tarve-txiki** | 270.9 | 9.5× | 316.3 |
| 11 | **tarve-txiki-lowpower** | 274.5 | 9.6× | 321.7 |

### 8. Memória de GPU dedicada (tela vazia)

Contador GPU Process Memory do Windows.

| # | App | MB | Δ vs 1º | Com 2.000 linhas MB |
| ---: | --- | ---: | ---: | ---: |
| 1 | **tarve-bun-lowpower** | 0 | — | 0 |
| 2 | **tarve-node-lowpower** | 0 | — | 0 |
| 3 | **tarve-txiki-lowpower** | 0 | — | 0 |
| 4 | egui | 22.8 | +22.8 | 22.8 |
| 5 | tauri | 25.5 | +25.5 | 29.3 |
| 6 | electron | 26.6 | +26.6 | 30.6 |
| 7 | **tarve-bun** | 33.4 | +33.4 | 33.4 |
| 8 | **tarve-node** | 33.4 | +33.4 | 33.4 |
| 9 | **tarve-txiki** | 33.4 | +33.4 | 33.4 |
| 10 | flutter | 68.8 | +68.8 | 68.8 |
| 11 | dioxus-native | 269.2 | +269.2 | 269.2 |

## Todas as métricas (mediana de 5 execuções, todos os apps)

Tabela completa gerada de `results/results.json`. Cada execução individual está em `results/results.jsonl`, e as capturas da primeira execução de cada app estão em `results/shots/`. Em todas as métricas, menor é melhor. "Falhas" conta cliques cuja mudança não apareceu na tela em até 3 s.

#### Cena `empty`

| App | Disco MB | Zip MB | 1ª janela ms | 1º frame ms | Commit MB | Private WS MB | WS MB | Threads | Handles | Proc. | CPU ociosa % | GPU ded. MB | GPU comp. MB | CPU scroll % | GPU 3D scroll % | Update p50 ms | Update p95 ms | Update máx ms | Falhas | Pico commit MB | Pico WS MB | Commit final MB | Private WS final MB | Máquina ocupada % | Execuções |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| tarve-bun | 150.7 | 75.9 | 57 | 139 | 319.5 | 32.5 | 82.8 | 90 | 644 | 1 | 0 | 33.4 | 2.3 | — | — | 8 | 12.7 | 20.8 | 0 | 338.8 | 89.2 | 338.8 | 36.1 | 5.4 | 5 |
| tarve-bun-lowpower | 150.7 | 75.9 | 54 | 131 | 128.8 | 25.2 | 55.5 | 24 | 283 | 1 | 0 | 0 | 0 | — | — | 7.9 | 8.9 | 21 | 0 | 146.3 | 61.2 | 146 | 28.1 | 6.6 | 5 |
| tarve-node | 114.8 | 43.4 | 356 | 441 | 133.9 | 65.9 | 138.5 | 84 | 638 | 1 | 0 | 33.4 | 2.3 | — | — | 8.2 | 13 | 20.9 | 0 | 140.6 | 145 | 107.5 | 40.2 | 5.9 | 5 |
| tarve-node-lowpower | 114.8 | 43.4 | 356 | 427 | 73.4 | 59.7 | 112.3 | 18 | 295 | 1 | 0 | 0 | 0 | — | — | 7.8 | 8.8 | 20.9 | 0 | 75 | 115 | 46.5 | 33.1 | 9.7 | 5 |
| tarve-txiki | 11.5 | 8.6 | 52 | 126 | 129 | 24.4 | 65.7 | 84 | 639 | 1 | 0 | 33.4 | 2.3 | — | — | 7.8 | 12.6 | 20.9 | 0 | 135.7 | 72.4 | 129.6 | 25.6 | 13.9 | 5 |
| tarve-txiki-lowpower | 11.5 | 8.6 | 47 | 124 | 68.8 | 18.5 | 39.8 | 18 | 294 | 1 | 0 | 0 | 0 | — | — | 7.9 | 8.5 | 20.9 | 0 | 69.1 | 41.3 | 69.1 | 18.9 | 6.2 | 5 |
| electron | 357.1 | 150.9 | 120 | 378 | 147.2 | 72.7 | 300.2 | 165 | 2351 | 4 | 0 | 26.6 | 1.9 | — | — | 8.1 | 12.5 | 12.9 | 0 | 151.5 | 303.5 | 151.5 | 74.4 | 6.1 | 5 |
| tauri | 4.1 | 1.6 | 37 | 440 | 154.3 | 75.6 | 357.6 | 239 | 3536 | 7 | 0.6 | 25.5 | 2 | — | — | 12 | 13.1 | 13.6 | 0 | 160 | 364.7 | 157.3 | 77.4 | 6.8 | 5 |
| flutter | 24.8 | 10.4 | 471 | 547 | 163.9 | 50.8 | 98.9 | 105 | 722 | 1 | 0 | 68.8 | 8 | — | — | 4.2 | 8.5 | 12.6 | 0 | 173.5 | 107.3 | 171.9 | 58.7 | 8.9 | 5 |
| dioxus-native | 14.9 | 6.4 | 238 | 966 | 464.7 | 135.7 | 201.9 | 56 | 706 | 1 | 0.6 | 269.2 | 52.6 | — | — | 7.8 | 8.4 | 8.5 | 0 | 473 | 205.9 | 465.6 | 139.6 | 13.6 | 5 |
| egui | 3.5 | 1.8 | 166 | 277 | 68.4 | 33.6 | 65.2 | 16 | 389 | 1 | 0 | 22.8 | 5.7 | — | — | 4.8 | 8.5 | 9.1 | 0 | 73.4 | 70.9 | 73.4 | 39.2 | 5.4 | 5 |

#### Cena `list`

| App | Disco MB | Zip MB | 1ª janela ms | 1º frame ms | Commit MB | Private WS MB | WS MB | Threads | Handles | Proc. | CPU ociosa % | GPU ded. MB | GPU comp. MB | CPU scroll % | GPU 3D scroll % | Update p50 ms | Update p95 ms | Update máx ms | Falhas | Pico commit MB | Pico WS MB | Commit final MB | Private WS final MB | Máquina ocupada % | Execuções |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| tarve-bun | 150.7 | 75.9 | 160 | 239 | 405.3 | 97.3 | 153.8 | 90 | 645 | 1 | 0.3 | 33.4 | 3 | 30.5 | 2.8 | 66.1 | 74.7 | 82.5 | 0 | 542.9 | 251 | 501.8 | 151.7 | 6.7 | 5 |
| tarve-bun-lowpower | 150.7 | 75.9 | 132 | 212 | 211.9 | 88.6 | 125 | 24 | 290 | 1 | 0 | 0 | 0 | 120.4 | 0 | 66.2 | 83.3 | 91 | 0 | 358.6 | 214.8 | 332.9 | 148.7 | 13 | 5 |
| tarve-node | 114.8 | 43.4 | 502 | 583 | 181.9 | 110.5 | 188.1 | 84 | 653 | 1 | 0 | 33.4 | 3 | 26.2 | 2.7 | 66.2 | 79 | 90.9 | 0 | 296.2 | 297.1 | 293 | 215 | 6.1 | 5 |
| tarve-node-lowpower | 114.8 | 43.4 | 435 | 509 | 119.7 | 102.8 | 160.2 | 18 | 302 | 1 | 0 | 0 | 0 | 121.3 | 0 | 66.5 | 95.4 | 104.5 | 0 | 242.4 | 277.7 | 240.9 | 217 | 5.2 | 5 |
| tarve-txiki | 11.5 | 8.6 | 448 | 524 | 215.2 | 96.4 | 137.8 | 83 | 662 | 1 | 0 | 33.4 | 3.3 | 24.3 | 2.6 | 270.9 | 316.3 | 354.1 | 0 | 254.4 | 176.8 | 229.1 | 111.8 | 8.7 | 5 |
| tarve-txiki-lowpower | 11.5 | 8.6 | 406 | 486 | 146 | 87.9 | 110.1 | 18 | 301 | 1 | 0 | 0 | 0 | 122 | 0 | 274.5 | 321.7 | 358.2 | 0 | 205.4 | 161.9 | 198.2 | 132.7 | 9.2 | 5 |
| electron | 357.1 | 150.9 | 113 | 367 | 186.7 | 105.3 | 336.3 | 169 | 2369 | 4 | 0.3 | 30.6 | 2.1 | 41.2 | 3.1 | 28.6 | 33.7 | 37.6 | 0 | 257 | 404.8 | 255.8 | 168.2 | 9.2 | 5 |
| tauri | 4.1 | 1.6 | 36 | 460 | 200.4 | 115.7 | 402.8 | 239 | 3547 | 7 | 0 | 29.3 | 2.2 | 36.9 | 3.1 | 28.5 | 32.8 | 37.2 | 0 | 268.3 | 472.9 | 264.6 | 175.5 | 6 | 5 |
| flutter | 24.8 | 10.4 | 668 | 743 | 359.5 | 246.7 | 295 | 106 | 728 | 1 | 0.3 | 68.8 | 8 | 103.8 | 0.6 | 158.3 | 186.8 | 203.7 | 0 | 434.4 | 365.1 | 403.9 | 287.1 | 10.9 | 5 |
| dioxus-native | 14.9 | 6.4 | 232 | 957 | 507.8 | 172.1 | 238.4 | 56 | 706 | 1 | 0 | 269.2 | 52.6 | 100.1 | 1.3 | 53.6 | 58.9 | 65.9 | 0 | 519.9 | 244.1 | 509.9 | 177.2 | 13.5 | 5 |
| egui | 3.5 | 1.8 | 175 | 298 | 100.7 | 65.9 | 97.5 | 16 | 389 | 1 | 0 | 22.8 | 6.7 | 102.8 | 0.8 | 37.1 | 40.8 | 41.8 | 0 | 144.8 | 136.9 | 141.7 | 103 | 6.3 | 5 |

## Caveats

- Measured on a single machine. All starts are warm (the file cache is already loaded). Other work on the machine took 5–14% of the total CPU (`machineBusyPct`).
- Electron and Tauri use React 19 with no virtualization. Flutter uses a plain `Column` (with the idiomatic `ListView.builder`, only the visible rows would exist), so every framework renders all 2,000 rows. egui is immediate mode and redraws the whole frame on any input.
- Latency is measured on screen, so it includes vsync and DWM composition (about 4 ms at 240 Hz).
- Dioxus Native (Blitz) on 0.7.10 still marks itself experimental.
